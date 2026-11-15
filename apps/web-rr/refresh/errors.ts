import type { RefreshFailure } from "@bot-thk/web-http";

export type CoordinationFailureCode = "closed" | "capacity" | "circuit-open" | "deadline" | "database" | "policy" | "invalid-result" | "uncertain";

/** Only fixed protocol classifications may leave this module, never driver text. */
export class RefreshCoordinationError extends Error {
  readonly code: CoordinationFailureCode;
  constructor(code: CoordinationFailureCode) {
    super("Web refresh coordination is unavailable.");
    this.name = "RefreshCoordinationError";
    this.code = code;
  }
}

export function coordinationFailure(code: CoordinationFailureCode = "database"): RefreshFailure {
  return { kind: "failed", status: 503, code: code === "uncertain" ? "REFRESH_UNCERTAIN" : "SERVICE_UNAVAILABLE",
    message: code === "uncertain" ? "The previous refresh result is uncertain. Sign in again to continue." : "Session refresh is temporarily unavailable.",
    retryAfterSeconds: code === "uncertain" ? null : 1 };
}

export type RefreshObservation = Readonly<{ event: "requested" | "claimed" | "shared" | "completed" | "uncertain" | "rejected" | "sweep-failed"; reason?: CoordinationFailureCode }>;
export type RefreshObserver = (sample: RefreshObservation) => void;

export function observeRefresh(observer: RefreshObserver | undefined, sample: RefreshObservation): void {
  try { observer?.(sample); } catch { /* A log sink cannot change rotation ownership. */ }
}
