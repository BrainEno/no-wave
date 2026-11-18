import type { ServerResponse } from "node:http";
import { integerSetting } from "./service-settings.ts";

export function httpCollectionAdmissionSettings(env: NodeJS.ProcessEnv) {
  return Object.freeze({ active: integerSetting(env, "API_COLLECTION_CONCURRENCY", 4, 1, 32),
    queued: integerSetting(env, "API_COLLECTION_QUEUE", 16, 0, 128),
    waitMs: integerSetting(env, "API_COLLECTION_QUEUE_TIMEOUT_MS", 250, 1, 5000) });
}
export type CollectionReadLease = { finish(): void };
type Limits = ReturnType<typeof httpCollectionAdmissionSettings>;
type Reason = "full" | "timeout" | "cancelled" | "closing";
type Active = { socketDone: boolean; handlerDone: boolean };
type Waiter = { response: ServerResponse; deadline: number; resolve: (lease: CollectionReadLease | null) => void;
  detach(): void; settled: boolean; timer?: ReturnType<typeof setTimeout> };

/**
 * Only large article GET handlers use this pool. Authentication, probes, detail
 * reads and mutations do not wait behind a stalled page. A lease ends only after
 * both the handler and its response finish: closing a browser socket alone is
 * not evidence that a non-cooperating database query released its full bodies.
 * No timeout reclaims physical ownership. Queued requests have no body/page yet.
 */
export class HttpCollectionAdmission {
  private readonly limits: Limits;
  private readonly active = new Set<Active>();
  private readonly queue: Waiter[] = [];
  private readonly rejected: Record<Reason, number> = { full: 0, timeout: 0, cancelled: 0, closing: 0 };
  private stopping = false;
  private drained?: Promise<void>;
  private resolveDrain?: () => void;

  constructor(limits: Limits) {
    if (!Number.isSafeInteger(limits.active) || limits.active < 1 || limits.active > 32 ||
        !Number.isSafeInteger(limits.queued) || limits.queued < 0 || limits.queued > 128 ||
        !Number.isSafeInteger(limits.waitMs) || limits.waitMs < 1 || limits.waitMs > 5000) throw new RangeError("Invalid collection admission limits.");
    this.limits = Object.freeze({ ...limits });
  }

  acquire(response: ServerResponse): Promise<CollectionReadLease | null> {
    if (this.stopping) return Promise.resolve(this.refuse("closing"));
    if (response.destroyed || response.writableEnded) return Promise.resolve(this.refuse("cancelled"));
    if (this.active.size < this.limits.active && this.queue.length === 0) return Promise.resolve(this.grant(response));
    if (this.queue.length >= this.limits.queued) return Promise.resolve(this.refuse("full"));
    return new Promise(resolve => {
      const close = () => this.settle(waiter, "cancelled");
      const waiter: Waiter = { response, deadline: performance.now() + this.limits.waitMs, resolve, settled: false,
        detach: () => { response.off("finish", close); response.off("close", close); if (waiter.timer) clearTimeout(waiter.timer); } };
      response.once("close", close);
      response.once("finish", close);
      this.queue.push(waiter);
      const expire = () => {
        const remaining = waiter.deadline - performance.now();
        if (remaining > 0) { waiter.timer = setTimeout(expire, Math.ceil(remaining)); waiter.timer.unref(); }
        else this.settle(waiter, "timeout");
      };
      waiter.timer = setTimeout(expire, this.limits.waitMs);
      waiter.timer.unref();
    });
  }

  private refuse(reason: Reason): null {
    this.rejected[reason] = Math.min(Number.MAX_SAFE_INTEGER, this.rejected[reason] + 1);
    return null;
  }

  private settle(waiter: Waiter, reason?: Reason): void {
    if (waiter.settled) return;
    waiter.settled = true;
    waiter.detach();
    const index = this.queue.indexOf(waiter);
    if (index >= 0) this.queue.splice(index, 1);
    const refusal = reason ?? (this.stopping ? "closing" : waiter.response.destroyed || waiter.response.writableEnded ? "cancelled"
      : performance.now() >= waiter.deadline ? "timeout" : undefined);
    waiter.resolve(refusal ? this.refuse(refusal) : this.grant(waiter.response));
  }

  private grant(response: ServerResponse): CollectionReadLease {
    const state: Active = { socketDone: false, handlerDone: false };
    this.active.add(state);
    const release = () => {
      if (!state.handlerDone || !state.socketDone || !this.active.delete(state)) return;
      if (this.stopping && this.active.size === 0) this.resolveDrain?.();
      while (!this.stopping && this.active.size < this.limits.active && this.queue.length) this.settle(this.queue[0]!);
    };
    const socketDone = () => {
      state.socketDone = true;
      response.off("finish", socketDone);
      response.off("close", socketDone);
      release();
    };
    response.once("finish", socketDone);
    response.once("close", socketDone);
    if (response.destroyed || response.writableFinished) socketDone();
    return { finish: () => { state.handlerDone = true; release(); } };
  }

  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    for (const waiter of [...this.queue]) this.settle(waiter, "closing");
  }

  /** One shared settlement promise; no polling or premature physical-slot release. */
  drain(): Promise<void> {
    this.stop();
    if (!this.active.size) return Promise.resolve();
    this.drained ??= new Promise<void>(resolve => { this.resolveDrain = resolve; });
    return this.drained;
  }

  renderMetrics(): string {
    const detached = [...this.active].filter(state => state.socketDone && !state.handlerDone).length;
    const lines = [`# TYPE api_http_collection_active gauge`, `api_http_collection_active ${this.active.size}`,
      `# TYPE api_http_collection_queued gauge`, `api_http_collection_queued ${this.queue.length}`,
      `# TYPE api_http_collection_detached gauge`, `api_http_collection_detached ${detached}`,
      "# TYPE api_http_collection_admission_rejections_total counter"];
    for (const reason of ["full", "timeout", "cancelled", "closing"] as const) lines.push(`api_http_collection_admission_rejections_total{reason="${reason}"} ${this.rejected[reason]}`);
    return lines.join("\n") + "\n";
  }
}
