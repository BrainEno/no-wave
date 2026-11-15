import { RefreshCoordinationError } from "./errors.ts";

export type RefreshCircuitSnapshot = Readonly<{ state: "closed" | "open" | "half-open" | "stopped"; failures: number; retryAfterMs: number }>;

/** Protect an unavailable coordination database without ever falling back to memory. */
export class RefreshDatabaseCircuit {
  private readonly threshold: number;
  private readonly baseDelayMs: number;
  private readonly maximumDelayMs: number;
  private readonly now: () => number;
  private failures = 0;
  private consecutiveOpenings = 0;
  private retryAt = 0;
  private epoch = 0;
  private state: RefreshCircuitSnapshot["state"] = "closed";
  private lastNow = -Infinity;

  constructor(options: { threshold?: number; baseDelayMs?: number; maximumDelayMs?: number; now?: () => number } = {}) {
    this.threshold = options.threshold ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.maximumDelayMs = options.maximumDelayMs ?? 30_000;
    this.now = options.now ?? (() => performance.now());
    if (![this.threshold, this.baseDelayMs, this.maximumDelayMs].every(value => Number.isSafeInteger(value) && value > 0) || this.baseDelayMs > this.maximumDelayMs) {
      throw new RangeError("Invalid refresh database circuit bounds.");
    }
  }

  private clock(): number {
    const sample = this.now();
    if (!Number.isFinite(sample)) throw new RefreshCoordinationError("database");
    // A wall-clock-like injected source cannot lengthen/shorten ownership by
    // moving backwards. Production uses the monotonic performance clock.
    this.lastNow = Math.max(this.lastNow, sample);
    return this.lastNow;
  }

  snapshot(): RefreshCircuitSnapshot {
    return { state: this.state, failures: this.failures, retryAfterMs: this.state === "open" ? Math.max(0, Math.ceil(this.retryAt - this.clock())) : 0 };
  }

  private admit(): { epoch: number; probe: boolean } {
    if (this.state === "stopped") throw new RefreshCoordinationError("closed");
    if (this.state === "half-open") throw new RefreshCoordinationError("circuit-open");
    if (this.state === "open") {
      if (this.clock() < this.retryAt) throw new RefreshCoordinationError("circuit-open");
      this.state = "half-open";
      this.epoch++;
      return { epoch: this.epoch, probe: true };
    }
    return { epoch: this.epoch, probe: false };
  }

  async run<Value>(work: () => Promise<Value>): Promise<Value> {
    const ticket = this.admit();
    try {
      const value = await work();
      if (ticket.epoch === this.epoch && this.state !== "stopped") {
        this.failures = 0;
        if (ticket.probe) { this.state = "closed"; this.consecutiveOpenings = 0; this.epoch++; }
      }
      return value;
    } catch (error) {
      if (ticket.epoch === this.epoch && this.state !== "stopped" && error instanceof RefreshCoordinationError &&
          ["database", "deadline", "policy"].includes(error.code)) {
        this.failures++;
        if (ticket.probe || this.failures >= this.threshold) {
          const exponent = Math.min(this.consecutiveOpenings++, 16);
          const backoff = Math.min(this.maximumDelayMs, this.baseDelayMs * 2 ** exponent);
          this.retryAt = this.clock() + backoff;
          this.state = "open";
          this.epoch++;
        }
      } else if (ticket.probe && ticket.epoch === this.epoch && this.state !== "stopped") {
        // A local capacity/validation refusal says nothing about DB recovery.
        this.state = "open"; this.retryAt = this.clock() + this.baseDelayMs; this.epoch++;
      }
      throw error;
    }
  }

  close(): void { this.state = "stopped"; this.epoch++; }
}
