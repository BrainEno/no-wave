import { RefreshCoordinationError } from "./errors.ts";

export const REFRESH_NOTIFY_CHANNEL = "no_wave_refresh_result_v1";
export type RefreshWatch = { revision(): number; wait(after: number, timeoutMs: number, signal: AbortSignal): Promise<void>; close(): void };
type WatchState = { revision: number; references: number; lastWake: number; waiters: Set<{ wake: () => void; close: () => void }> };
type Listen = (channel: string, onNotify: (payload: string) => void, onListen: () => void) => Promise<unknown>;

export function refreshWakeupPayload(namespace: string, key: string): string {
  return JSON.stringify(["nwr1", namespace, key]);
}

/** NOTIFY is a hint, never a claim/result. Missed or forged hints cannot rotate. */
export class RefreshChangeFeed {
  private readonly namespace: string;
  private readonly maxKeys: number;
  private readonly timeoutMs: number;
  private readonly listen: Listen;
  private readonly keys = new Map<string, WatchState>();
  private starting: Promise<void> | undefined;
  private closed = false;
  private burstAt = 0;
  private burst = 0;
  private ignored = 0;
  private watches = 0;
  private cancelStart: (() => void) | undefined;

  constructor(options: { namespace: string; maxKeys: number; timeoutMs: number; listen: Listen }) {
    this.namespace = options.namespace;
    this.maxKeys = options.maxKeys;
    this.timeoutMs = options.timeoutMs;
    this.listen = options.listen;
  }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new RefreshCoordinationError("closed"));
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new RefreshCoordinationError("deadline")), this.timeoutMs);
      this.cancelStart = () => { clearTimeout(timeout); reject(new RefreshCoordinationError("closed")); };
      void Promise.resolve().then(() => this.listen(REFRESH_NOTIFY_CHANNEL, payload => this.notified(payload), () => {
        if (!this.closed) for (const state of this.keys.values()) this.wake(state);
      })).then(() => { clearTimeout(timeout); this.closed ? reject(new RefreshCoordinationError("closed")) : resolve(); }, () => {
        clearTimeout(timeout); reject(new RefreshCoordinationError("database"));
      });
    });
    return this.starting;
  }

  private wake(state: WatchState): void {
    state.revision = (state.revision + 1) % Number.MAX_SAFE_INTEGER;
    for (const waiter of [...state.waiters]) waiter.wake();
  }

  private notified(payload: string): void {
    if (this.closed || typeof payload !== "string" || payload.length > 256) return;
    let value: unknown;
    try { value = JSON.parse(payload) as unknown; } catch { return; }
    if (!Array.isArray(value) || value.length !== 3 || value[0] !== "nwr1" || value[1] !== this.namespace ||
        typeof value[2] !== "string" || !/^[a-f0-9]{64}$/.test(value[2])) return;
    const state = this.keys.get(value[2]);
    if (!state) return;
    const now = performance.now();
    if (now - this.burstAt >= 1000) { this.burstAt = now; this.burst = 0; }
    // Notifications from a DB role are not permission to amplify query load.
    // A suppressed wakeup is recovered by the bounded polling fallback.
    if (this.burst >= 128 || now - state.lastWake < 20) { this.ignored = Math.min(Number.MAX_SAFE_INTEGER, this.ignored + 1); return; }
    this.burst++; state.lastWake = now; this.wake(state);
  }

  watch(key: string): RefreshWatch {
    if (this.closed) throw new RefreshCoordinationError("closed");
    if (!/^[a-f0-9]{64}$/.test(key)) throw new RefreshCoordinationError("invalid-result");
    if (this.watches >= this.maxKeys) throw new RefreshCoordinationError("capacity");
    let state = this.keys.get(key);
    if (!state) {
      if (this.keys.size >= this.maxKeys) throw new RefreshCoordinationError("capacity");
      state = { revision: 0, references: 0, lastWake: -Infinity, waiters: new Set() };
      this.keys.set(key, state);
    }
    this.watches++; state.references++;
    const owned = state;
    let released = false;
    return {
      revision: () => owned.revision,
      wait: (after, timeoutMs, signal) => {
        if (released || this.closed || signal.aborted) return Promise.reject(new RefreshCoordinationError("closed"));
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new RefreshCoordinationError("deadline"));
        if (owned.waiters.size >= this.maxKeys) return Promise.reject(new RefreshCoordinationError("capacity"));
        if (after !== owned.revision) return Promise.resolve();
        return new Promise<void>((resolve, reject) => {
          const done = (closed: boolean) => {
            clearTimeout(timer); signal.removeEventListener("abort", abort); owned.waiters.delete(waiter);
            closed ? reject(new RefreshCoordinationError("closed")) : resolve();
          };
          const abort = () => done(true);
          const waiter = { wake: () => done(false), close: () => done(true) };
          const timer = setTimeout(waiter.wake, Math.max(1, timeoutMs));
          owned.waiters.add(waiter); signal.addEventListener("abort", abort, { once: true });
        });
      },
      close: () => {
        if (released) return;
        released = true;
        if (!this.closed) this.watches--;
        if (--owned.references === 0) {
          for (const waiter of [...owned.waiters]) waiter.close();
          this.keys.delete(key);
        }
      },
    };
  }

  snapshot(): { keys: number; waiters: number; ignored: number; closed: boolean } {
    return { keys: this.keys.size, waiters: [...this.keys.values()].reduce((sum, state) => sum + state.waiters.size, 0), ignored: this.ignored, closed: this.closed };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelStart?.();
    this.watches = 0;
    for (const state of this.keys.values()) for (const waiter of [...state.waiters]) waiter.close();
    this.keys.clear();
  }
}
