import { RefreshCoordinationError } from "./errors.ts";

type Release = () => void;
type Waiter = { resolve: (release: Release) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** A deadline limits the caller, not ownership of an already-running driver. */
export class BoundedRefreshGate {
  private active = 0;
  private readonly queue: Waiter[] = [];
  private readonly stopped = new AbortController();
  private readonly idle = new Set<() => void>();
  private readonly concurrency: number;
  private readonly maxQueued: number;

  constructor(concurrency: number, maxQueued: number) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || !Number.isSafeInteger(maxQueued) || maxQueued < 0) {
      throw new RangeError("Invalid refresh gate capacity.");
    }
    this.concurrency = concurrency;
    this.maxQueued = maxQueued;
  }

  snapshot(): { active: number; queued: number; closed: boolean } {
    return { active: this.active, queued: this.queue.length, closed: this.stopped.signal.aborted };
  }

  private release(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      if (!this.stopped.signal.aborted) {
        const next = this.queue.shift();
        if (next) { clearTimeout(next.timer); this.active++; next.resolve(this.release()); }
      }
      if (this.active === 0) for (const notify of this.idle) notify();
    };
  }

  private acquire(timeoutMs: number): Promise<Release> {
    if (this.stopped.signal.aborted) return Promise.reject(new RefreshCoordinationError("closed"));
    if (this.active < this.concurrency) { this.active++; return Promise.resolve(this.release()); }
    if (this.queue.length >= this.maxQueued) return Promise.reject(new RefreshCoordinationError("capacity"));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, timer: setTimeout(() => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(new RefreshCoordinationError("deadline"));
      }, timeoutMs) };
      this.queue.push(waiter);
    });
  }

  async run<Value>(work: () => Promise<Value>, timeoutMs: number): Promise<Value> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RefreshCoordinationError("deadline");
    const started = performance.now();
    const release = await this.acquire(timeoutMs);
    const remaining = timeoutMs - (performance.now() - started);
    if (this.stopped.signal.aborted || remaining <= 0) { release(); throw new RefreshCoordinationError(this.stopped.signal.aborted ? "closed" : "deadline"); }
    // Start in a microtask, then recheck cancellation: a close in this gap must
    // not launch a queued database transaction after shutdown has begun.
    const actual = Promise.resolve().then(() => {
      if (this.stopped.signal.aborted) throw new RefreshCoordinationError("closed");
      return work();
    }).finally(release);
    return new Promise<Value>((resolve, reject) => {
      const abort = () => { cleanup(); reject(new RefreshCoordinationError("closed")); };
      const timer = setTimeout(() => { cleanup(); reject(new RefreshCoordinationError("deadline")); }, remaining);
      const cleanup = () => { clearTimeout(timer); this.stopped.signal.removeEventListener("abort", abort); };
      this.stopped.signal.addEventListener("abort", abort, { once: true });
      actual.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
  }

  close(): void {
    if (this.stopped.signal.aborted) return;
    this.stopped.abort();
    for (const waiter of this.queue.splice(0)) { clearTimeout(waiter.timer); waiter.reject(new RefreshCoordinationError("closed")); }
  }

  drain(timeoutMs: number): Promise<boolean> {
    if (this.active === 0) return Promise.resolve(true);
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.idle.delete(done); resolve(true); };
      const timer = setTimeout(() => { this.idle.delete(done); resolve(false); }, timeoutMs);
      this.idle.add(done);
    });
  }
}
