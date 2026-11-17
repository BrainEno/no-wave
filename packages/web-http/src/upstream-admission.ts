import { UpstreamBusyError, UpstreamCancelledError } from "./upstream-errors.ts";

export const ADMISSION_WAIT_BUCKETS_MS = [1, 10, 50, 100, 250, 1000, 5000] as const;
type CancellationMetrics = { acknowledged: number; rejected: number; totalMs: number };
const emptyCancellationMetrics = (): CancellationMetrics => ({ acknowledged: 0, rejected: 0, totalMs: 0 });
type WaitMetrics = { count: number; totalMs: number; buckets: number[] };
export type UpstreamLane = "data" | "auth" | "bulk";
export type AdmissionLimits = { concurrency: number; queue: number; queueTimeoutMs: number };
export type AdmissionSnapshot = Record<UpstreamLane, { active: number; queued: number; concurrency: number; capacity: number; oldestActiveMs: number; detached: number; cancelling: number; oldestDetachedMs: number; oldestCancellingMs: number; wait: WaitMetrics; cancellation: CancellationMetrics }>;
export type UpstreamLease = { release(cancellationRejected?: boolean): void; detach(): void; cancelling(): void };
type PhysicalOperation = { at: number; detachedAt: number | null; cancellingAt: number | null };
type Waiter = {
  grant(lease: UpstreamLease): void;
  reject(error: Error): void;
  signal?: AbortSignal;
  abort(): void;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
  startedAt: number;
};
type LaneState = { limits: AdmissionLimits; active: number; waiters: Waiter[]; started: Set<PhysicalOperation>; wait: WaitMetrics; cancellation: CancellationMetrics };

function limits(value: AdmissionLimits): AdmissionLimits {
  if (!Number.isSafeInteger(value.concurrency) || value.concurrency < 1 || value.concurrency > 32 ||
      !Number.isSafeInteger(value.queue) || value.queue < 0 || value.queue > 128 ||
      !Number.isSafeInteger(value.queueTimeoutMs) || value.queueTimeoutMs < 1 || value.queueTimeoutMs > 5000) {
    throw new RangeError("Invalid upstream admission limits.");
  }
  return { ...value };
}

/** FIFO, finite queues. Authentication never waits behind large public reads. */
export class UpstreamAdmission {
  private readonly lanes: Record<UpstreamLane, LaneState>;
  private stopping = false;
  private readonly idleListeners = new Set<() => void>();

  constructor(data: AdmissionLimits = { concurrency: 8, queue: 32, queueTimeoutMs: 250 }) {
    this.lanes = {
      data: { limits: limits(data), active: 0, waiters: [], started: new Set(), wait: this.emptyWait(), cancellation: emptyCancellationMetrics() },
      auth: { limits: { concurrency: 2, queue: 8, queueTimeoutMs: 250 }, active: 0, waiters: [], started: new Set(), wait: this.emptyWait(), cancellation: emptyCancellationMetrics() },
      bulk: { limits: { concurrency: 1, queue: 2, queueTimeoutMs: 250 }, active: 0, waiters: [], started: new Set(), wait: this.emptyWait(), cancellation: emptyCancellationMetrics() },
    };
  }

  acquire(lane: UpstreamLane, signal?: AbortSignal): Promise<UpstreamLease> {
    const state = this.lanes[lane];
    const startedAt = performance.now();
    const rejectImmediately = (error: Error) => {
      this.recordWait(state, startedAt);
      return Promise.reject<UpstreamLease>(error);
    };
    if (signal?.aborted) return rejectImmediately(new UpstreamCancelledError());
    if (this.stopping) return rejectImmediately(new UpstreamBusyError("closing"));
    if (state.active < state.limits.concurrency && state.waiters.length === 0) {
      this.recordWait(state, startedAt);
      return Promise.resolve(this.lease(state));
    }
    if (state.waiters.length >= state.limits.queue) return rejectImmediately(new UpstreamBusyError("capacity"));
    return new Promise<UpstreamLease>((resolve, reject) => {
      const fail = (error: Error): void => {
        if (waiter.settled) return;
        this.remove(state, waiter);
        reject(error);
      };
      const waiter: Waiter = {
        grant: resolve, reject, signal, settled: false, startedAt,
        abort: () => fail(new UpstreamCancelledError()),
        timer: setTimeout(() => fail(new UpstreamBusyError("queue-timeout")), state.limits.queueTimeoutMs),
      };
      state.waiters.push(waiter);
      signal?.addEventListener("abort", waiter.abort, { once: true });
      // A signal can already be aborted when a custom signal adapter registers.
      if (signal?.aborted) waiter.abort();
    });
  }

  private emptyWait(): WaitMetrics {
    return { count: 0, totalMs: 0, buckets: ADMISSION_WAIT_BUCKETS_MS.map(() => 0) };
  }

  private recordWait(state: LaneState, startedAt: number): void {
    const elapsed = Math.max(0, performance.now() - startedAt);
    state.wait.count = Math.min(Number.MAX_SAFE_INTEGER, state.wait.count + 1);
    state.wait.totalMs = Math.min(Number.MAX_SAFE_INTEGER, state.wait.totalMs + elapsed);
    for (const [index, upper] of ADMISSION_WAIT_BUCKETS_MS.entries()) {
      if (elapsed <= upper) state.wait.buckets[index] = Math.min(Number.MAX_SAFE_INTEGER, state.wait.buckets[index]! + 1);
    }
  }

  private remove(state: LaneState, waiter: Waiter): void {
    waiter.settled = true;
    this.recordWait(state, waiter.startedAt);
    clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener("abort", waiter.abort);
    const index = state.waiters.indexOf(waiter);
    if (index >= 0) state.waiters.splice(index, 1);
  }

  private lease(state: LaneState): UpstreamLease {
    const started: PhysicalOperation = { at: performance.now(), detachedAt: null, cancellingAt: null };
    state.started.add(started);
    state.active++;
    let released = false;
    return {
      detach: () => {
        if (!released && started.detachedAt === null) started.detachedAt = performance.now();
      },
      cancelling: () => {
        if (!released && started.cancellingAt === null) started.cancellingAt = performance.now();
      },
      release: cancellationRejected => {
        if (released) return;
        released = true;
        state.active--;
        state.started.delete(started);
        if (started.cancellingAt !== null) {
          const elapsed = Math.max(0, performance.now() - started.cancellingAt);
          const result = cancellationRejected ? "rejected" : "acknowledged";
          state.cancellation[result] = Math.min(Number.MAX_SAFE_INTEGER, state.cancellation[result] + 1);
          state.cancellation.totalMs = Math.min(Number.MAX_SAFE_INTEGER, state.cancellation.totalMs + elapsed);
        }
        while (!this.stopping && state.waiters.length && state.active < state.limits.concurrency) {
          const next = state.waiters[0]!;
          this.remove(state, next);
          if (next.signal?.aborted) next.reject(new UpstreamCancelledError());
          else if (performance.now() - next.startedAt >= state.limits.queueTimeoutMs) next.reject(new UpstreamBusyError("queue-timeout"));
          else next.grant(this.lease(state));
        }
        if (this.active() === 0) for (const listener of [...this.idleListeners]) listener();
      },
    };
  }

  snapshot(): AdmissionSnapshot {
    const now = performance.now();
    const view = (state: LaneState) => {
      let oldestActiveMs = 0, oldestDetachedMs = 0, oldestCancellingMs = 0;
      let detached = 0, cancelling = 0;
      // A fixed-size active set, not a request/URL registry. Distinguish calls
      // still serving a reader from logical completions and pending cancel().
      for (const operation of state.started) {
        oldestActiveMs = Math.max(oldestActiveMs, now - operation.at);
        if (operation.detachedAt !== null) {
          detached++;
          oldestDetachedMs = Math.max(oldestDetachedMs, now - operation.detachedAt);
        }
        if (operation.cancellingAt !== null) {
          cancelling++;
          oldestCancellingMs = Math.max(oldestCancellingMs, now - operation.cancellingAt);
        }
      }
      return { active: state.active, queued: state.waiters.length,
        concurrency: state.limits.concurrency, capacity: state.limits.queue,
        oldestActiveMs, detached, cancelling, oldestDetachedMs, oldestCancellingMs,
        cancellation: { ...state.cancellation },
        wait: { ...state.wait, buckets: [...state.wait.buckets] } };
    };
    return { data: view(this.lanes.data), auth: view(this.lanes.auth), bulk: view(this.lanes.bulk) };
  }

  active(): number {
    return this.lanes.data.active + this.lanes.auth.active + this.lanes.bulk.active;
  }

  /** Reject queued work immediately, but do not pretend a running socket ended. */
  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    for (const state of Object.values(this.lanes)) {
      for (const waiter of [...state.waiters]) {
        this.remove(state, waiter);
        waiter.reject(new UpstreamBusyError("closing"));
      }
    }
  }

  waitForIdle(timeoutMs: number): Promise<boolean> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return Promise.reject(new RangeError("Invalid upstream drain budget."));
    if (this.active() === 0) return Promise.resolve(true);
    return new Promise<boolean>(resolve => {
      const finish = (idle: boolean) => {
        clearTimeout(timer);
        this.idleListeners.delete(onIdle);
        resolve(idle);
      };
      const onIdle = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.idleListeners.add(onIdle);
    });
  }
}
