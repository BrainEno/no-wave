import type { RefreshCoordinatorContext } from "@no-wave/web-http";
import { RefreshCoordinationError } from "./errors.ts";

/** Request cancellation is NOT permission to cancel/delete a shared generation. */
export class RefreshWaiters {
  private readonly maximum: number;
  private readonly perKey: number;
  private readonly keys = new Map<string, number>();
  private readonly canceled = new Set<() => void>();
  private active = 0;
  private closed = false;

  constructor(maximum: number, perKey: number) {
    if (!Number.isSafeInteger(maximum) || !Number.isSafeInteger(perKey) || perKey < 1 || maximum < perKey) {
      throw new RangeError("Invalid refresh waiter capacity.");
    }
    this.maximum = maximum;
    this.perKey = perKey;
  }

  join<Value>(key: string, work: () => Promise<Value>, context: RefreshCoordinatorContext): Promise<Value> {
    if (this.closed || context.signal?.aborted) return Promise.reject(new RefreshCoordinationError("closed"));
    const timeout = context.timeoutMs;
    if (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) {
      return Promise.reject(new RefreshCoordinationError("deadline"));
    }
    const count = this.keys.get(key) ?? 0;
    if (this.active >= this.maximum || count >= this.perKey) return Promise.reject(new RefreshCoordinationError("capacity"));
    this.active++; this.keys.set(key, count + 1);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (outcome: { ok: true; value: Value } | { ok: false; error: unknown }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        context.signal?.removeEventListener("abort", abort);
        this.canceled.delete(abort);
        this.active--;
        const remaining = (this.keys.get(key) ?? 1) - 1;
        if (remaining > 0) this.keys.set(key, remaining); else this.keys.delete(key);
        if (outcome.ok) resolve(outcome.value); else reject(outcome.error);
      };
      const abort = () => finish({ ok: false, error: new RefreshCoordinationError("closed") });
      const timer = setTimeout(() => finish({ ok: false, error: new RefreshCoordinationError("deadline") }), timeout);
      this.canceled.add(abort);
      context.signal?.addEventListener("abort", abort, { once: true });
      // Check again inside the scheduled work: shutdown/cancellation in this
      // microtask gap must not start a new claim after the caller was rejected.
      void Promise.resolve().then(() => {
        if (settled || this.closed || context.signal?.aborted) throw new RefreshCoordinationError("closed");
        return work();
      }).then(value => finish({ ok: true, value }), error => finish({ ok: false, error }));
    });
  }

  snapshot(): { active: number; keys: number; closed: boolean } { return { active: this.active, keys: this.keys.size, closed: this.closed }; }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const cancel of [...this.canceled]) cancel();
  }
}
