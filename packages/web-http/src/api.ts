/**
 * Explicit inputs for every handler in this package.
 *
 * Nothing here reads `process.env`: the adapter that knows the runtime (the React
 * Router app, a container, a test) resolves the API origin and passes it in. That
 * is what makes the same handler testable without a framework request object, and
 * it is why a Vercel service binding can stay a transitional detail of one
 * adapter.
 */
import type { RefreshCoordinator } from "./refresh-coordinator.ts";
import type { UpstreamTransport } from "./upstream.ts";
import { UpstreamCancelledError } from "./upstream-errors.ts";

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export type ApiProxyConfig = {
  /** Absolute HTTP(S) API origin, already validated by the caller. */
  apiBaseUrl?: string | undefined;
  fetchImpl?: FetchImpl;
  /** Shared process admission/byte budgets. Do not also supply a fetch override. */
  upstreamTransport?: UpstreamTransport;
  /**
   * Budget in milliseconds for one upstream call, covering connection,
   * response headers and (for buffered calls) the whole body. Defaults to
   * `DEFAULT_UPSTREAM_TIMEOUT_MS`; an invalid value fails closed.
   */
  upstreamTimeoutMs?: number | string | null | undefined;
  /**
   * Rotation single-flight (ADR 0025). A multi-instance deployment supplies a
   * shared implementation; the default is one coordinator per Web process (and,
   * for injected transports, one per transport).
   */
  refreshCoordinator?: RefreshCoordinator;
  /** Server-owned request context only; never construct this from browser headers. */
  clientAddressHeaders?: (target: string, method: string) => HeadersInit;
};

/** Only the two private metadata fields may be supplied by a server adapter. */
export function applyClientAddressHeaders(headers: Headers, target: string, method: string, provider: ApiProxyConfig["clientAddressHeaders"]): void {
  if (!provider) return;
  const metadata = new Headers(provider(target, method));
  for (const name of ["x-nw-client-address", "x-nw-client-address-proof"]) {
    const value = metadata.get(name);
    if (value !== null) headers.set(name, value);
  }
}

/** Join an API origin and a relative path, tolerating a trailing slash on either. */
export function apiUrl(base: string, path: string): string {
  // Scan each edge once: an unanchored trailing-slash regex can backtrack
  // quadratically through a long slash run followed by a non-slash.
  let baseEnd = base.length;
  while (baseEnd > 0 && base.charCodeAt(baseEnd - 1) === 47) baseEnd--;
  let pathStart = 0;
  while (pathStart < path.length && path.charCodeAt(pathStart) === 47) pathStart++;
  return new URL(path.slice(pathStart), `${base.slice(0, baseEnd)}/`).toString();
}

export async function readPayload(response: Response): Promise<unknown> {
  try {
    return (await response.clone().json()) as unknown;
  } catch {
    return null;
  }
}

/**
 * Default budget for one upstream API call made by the Web tier.
 *
 * Without a budget a hung API pins the SSR connection (and every request behind
 * it) for as long as the socket survives, which is how one slow dependency turns
 * into an outage. Ten seconds is long enough for a cold start plus an ordinary
 * read, and short enough that a visitor sees the page's own 503 instead of a
 * browser timeout.
 */
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 10_000;

/**
 * Upper bound for a configured budget. A value above this is a configuration
 * mistake (minutes-long hangs are what the budget exists to prevent), so it is
 * rejected rather than clamped.
 */
export const MAXIMUM_UPSTREAM_TIMEOUT_MS = 120_000;

/**
 * The upstream did not answer within the configured budget.
 *
 * The message deliberately carries only the budget: no origin, path, header or
 * credential. It reaches a public error boundary on an SSR page, and its `name`
 * is what the failure log records.
 */
export class UpstreamTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`The upstream API did not answer within ${timeoutMs} ms.`);
    this.name = "UpstreamTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Normalize a configured budget.
 *
 * `undefined`/`null` mean "use the default". Anything else must be a positive
 * integer number of milliseconds not above the maximum; digits-only strings are
 * accepted so a value can come straight from an environment variable. Every
 * other shape throws, because a typo must not quietly become the default budget
 * or an unbounded wait.
 */
export function resolveUpstreamTimeoutMs(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_UPSTREAM_TIMEOUT_MS;
  let candidate: unknown = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^[0-9]+$/.test(trimmed)) throw invalidTimeout();
    candidate = Number(trimmed);
  }
  if (typeof candidate !== "number" || !Number.isInteger(candidate) || candidate < 1 || candidate > MAXIMUM_UPSTREAM_TIMEOUT_MS) {
    throw invalidTimeout();
  }
  return candidate;
}

function invalidTimeout(): RangeError {
  return new RangeError(
    `The upstream timeout must be a whole number of milliseconds between 1 and ${MAXIMUM_UPSTREAM_TIMEOUT_MS}.`,
  );
}

/**
 * Run one upstream call under a deadline and abort signal.
 *
 * The deadline is a race, not an assumption that the transport honours the
 * signal: a socket stuck in a black hole ends the call even when the fetch
 * implementation never looks at `signal`. `run` gets the signal so a
 * cooperating transport can drop the connection early, and the timer is cleared
 * as soon as `run` settles — a late abort must never kill a body that has
 * already been handed to a caller.
 *
 * An abort observed by `run` becomes `UpstreamTimeoutError`; any other failure
 * keeps its own identity, because a refused connection is not a timeout.
 */
export type DeadlineCheckpoint = () => void;

export async function withUpstreamDeadline<T>(
  timeoutMs: number,
  run: (signal: AbortSignal, checkpoint: DeadlineCheckpoint) => Promise<T>,
  callerSignal?: AbortSignal,
): Promise<T> {
  const timeout = resolveUpstreamTimeoutMs(timeoutMs);
  if (callerSignal?.aborted) throw new UpstreamCancelledError();
  const controller = new AbortController();
  const deadlineAt = performance.now() + timeout;
  let termination: "timeout" | "cancelled" | undefined;
  let rejectAborted: (reason: Error) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAborted = reject; });
  const abort = (reason: "timeout" | "cancelled") => {
    if (termination) return;
    termination = reason;
    // Reject before dispatching the signal: a cooperating stream may resolve
    // synchronously from cancel(), but that is not a successful response.
    rejectAborted(reason === "timeout" ? new UpstreamTimeoutError(timeout) : new UpstreamCancelledError());
    controller.abort(reason === "timeout" ? new UpstreamTimeoutError(timeout) : new UpstreamCancelledError());
  };
  const onCallerAbort = () => abort("cancelled");
  // Timers may be starved by already-resolved microtasks or JSON work. A
  // monotonic checkpoint forbids late success and, when used before dispatch,
  // forbids a queued write from starting after its absolute budget expired.
  const checkpoint: DeadlineCheckpoint = () => {
    if (callerSignal?.aborted) onCallerAbort();
    else if (performance.now() >= deadlineAt) abort("timeout");
    if (termination === "timeout") throw new UpstreamTimeoutError(timeout);
    if (termination === "cancelled") throw new UpstreamCancelledError();
  };
  const timer = setTimeout(() => abort("timeout"), timeout);
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  // Promise.resolve also captures a synchronous throw from an injected port.
  const operation = Promise.resolve().then(() => {
    checkpoint();
    return run(controller.signal, checkpoint);
  });
  try {
    if (callerSignal?.aborted) onCallerAbort();
    const value = await Promise.race([operation, aborted]);
    checkpoint();
    return value;
  } catch (error) {
    if (termination === "timeout") throw new UpstreamTimeoutError(timeout);
    if (termination === "cancelled") throw new UpstreamCancelledError();
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
    void operation.catch(() => {});
  }
}
