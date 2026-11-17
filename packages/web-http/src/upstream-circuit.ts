import type { UpstreamLane } from "./upstream-admission.ts";
import { UpstreamBusyError } from "./upstream-errors.ts";

export type CircuitOutcome = "healthy" | "failure" | "neutral";
export type CircuitPermit = { report(outcome: CircuitOutcome): void; release(): void };
export type CircuitSnapshot = Record<UpstreamLane, { state: "closed" | "open" | "half-open"; failures: number; retryAfterMs: number }>;
type CircuitState = { open: boolean; failures: number; retryAt: number; generation: number; probeHeld: boolean };
export type CircuitOptions = { threshold?: number; cooldownMs?: number; now?: () => number };

/** Fixed lanes, no URL-keyed registry. Failures never cause automatic retries. */
export class UpstreamCircuit {
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly lanes: Record<UpstreamLane, CircuitState>;

  constructor(options: CircuitOptions = {}) {
    this.threshold = options.threshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 2000;
    if (!Number.isSafeInteger(this.threshold) || this.threshold < 1 || this.threshold > 100 ||
        !Number.isSafeInteger(this.cooldownMs) || this.cooldownMs < 1 || this.cooldownMs > 30_000) {
      throw new RangeError("Invalid upstream circuit settings.");
    }
    this.now = options.now ?? (() => performance.now());
    const empty = (): CircuitState => ({ open: false, failures: 0, retryAt: 0, generation: 0, probeHeld: false });
    this.lanes = { data: empty(), auth: empty(), bulk: empty() };
  }

  enter(lane: UpstreamLane): CircuitPermit {
    const state = this.lanes[lane];
    const probe = state.open;
    if (probe) {
      if (state.probeHeld || this.now() < state.retryAt) {
        throw new UpstreamBusyError("circuit-open", Math.max(1, Math.ceil((state.retryAt - this.now()) / 1000)));
      }
      state.probeHeld = true;
    }
    const generation = state.generation;
    let reported = false;
    let released = false;
    return {
      report: outcome => {
        if (reported || released) return;
        reported = true;
        // Requests already in flight when a lane trips cannot reopen/close the
        // next generation, regardless of their late success or failure order.
        if (state.generation !== generation || outcome === "neutral") return;
        if (outcome === "healthy") {
          state.failures = 0;
          state.retryAt = 0;
          if (probe) { state.open = false; state.generation++; }
          return;
        }
        state.failures = Math.min(this.threshold, state.failures + 1);
        if (probe || state.failures >= this.threshold) {
          state.open = true;
          state.retryAt = this.now() + this.cooldownMs;
          state.generation++;
        }
      },
      release: () => {
        if (released) return;
        released = true;
        // Even after its deadline reports failure, a physical probe retains
        // this flag until its socket/body actually ends.
        if (probe) state.probeHeld = false;
      },
    };
  }

  snapshot(): CircuitSnapshot {
    const now = this.now();
    const view = (state: CircuitState): CircuitSnapshot[UpstreamLane] => ({
      state: !state.open ? "closed" : state.probeHeld ? "half-open" : "open",
      failures: state.failures,
      retryAfterMs: state.open ? Math.max(0, state.retryAt - now) : 0,
    });
    return { data: view(this.lanes.data), auth: view(this.lanes.auth), bulk: view(this.lanes.bulk) };
  }
}
