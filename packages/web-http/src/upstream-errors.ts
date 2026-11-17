import { UpstreamTimeoutError } from "./api.ts";
import { errorResponse } from "./http.ts";

export type UpstreamBodyFailure = "too-large" | "unreadable" | "invalid-json" | "invalid-content-type";

/** These errors cross public error boundaries; never retain a URL, cause or body. */
export class UpstreamResponseError extends Error {
  readonly reason: UpstreamBodyFailure;
  constructor(reason: UpstreamBodyFailure) {
    super(reason === "too-large" ? "The upstream response exceeded its byte limit." : "The upstream response was invalid.");
    this.name = "UpstreamResponseError";
    this.reason = reason;
  }
}

export class UpstreamCancelledError extends Error {
  constructor() {
    super("The upstream request was cancelled.");
    this.name = "UpstreamCancelledError";
  }
}

export type UpstreamBusyReason = "capacity" | "queue-timeout" | "closing" | "circuit-open";
export class UpstreamBusyError extends Error {
  readonly reason: UpstreamBusyReason;
  readonly retryAfterSeconds: number;
  constructor(reason: UpstreamBusyReason, retryAfterSeconds = 1) {
    super("The upstream service is temporarily busy.");
    this.name = "UpstreamBusyError";
    this.reason = reason;
    this.retryAfterSeconds = Number.isSafeInteger(retryAfterSeconds) ? Math.min(30, Math.max(1, retryAfterSeconds)) : 1;
  }
}

/** No raw exception message, browser cancellation reason, or driver error is relayed. */
export function upstreamFailureResponse(error: unknown, cookies: readonly string[] = []): Response {
  if (error instanceof UpstreamTimeoutError) {
    return errorResponse("UPSTREAM_TIMEOUT", "The API service did not answer in time.", 504, cookies);
  }
  if (error instanceof UpstreamCancelledError) {
    return errorResponse("REQUEST_CANCELLED", "The request was cancelled.", 499, cookies);
  }
  if (error instanceof UpstreamBusyError) {
    const response = errorResponse("UPSTREAM_BUSY", "The API service is temporarily busy. Try again shortly.", 503, cookies);
    response.headers.set("retry-after", String(error.retryAfterSeconds));
    return response;
  }
  if (error instanceof UpstreamResponseError) {
    return errorResponse(error.reason === "too-large" ? "UPSTREAM_RESPONSE_TOO_LARGE" : "INVALID_API_RESPONSE",
      error.reason === "too-large" ? "The API response exceeded the response limit." : "The API returned an invalid response.", 502, cookies);
  }
  return errorResponse("SERVICE_UNAVAILABLE", "The API service could not be reached.", 502, cookies);
}
