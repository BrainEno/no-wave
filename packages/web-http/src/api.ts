/**
 * Explicit inputs for every handler in this package.
 *
 * Nothing here reads `process.env`: the adapter that knows the runtime (Next.js,
 * React Router, a test) resolves the API origin and passes it in. That is what
 * makes the same handler testable without a framework request object, and it is
 * why a Vercel service binding can stay a transitional detail of one adapter.
 */
import type { RefreshCoordinator } from "./refresh-coordinator.ts";

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export type ApiProxyConfig = {
  /** Absolute HTTP(S) API origin, already validated by the caller. */
  apiBaseUrl?: string | undefined;
  fetchImpl?: FetchImpl;
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
};

/** Join an API origin and a relative path, tolerating a trailing slash on either. */
export function apiUrl(base: string, path: string): string {
  return new URL(path.replace(/^\/+/, ""), `${base.replace(/\/+$/, "")}/`).toString();
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
export async function withUpstreamDeadline<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeout = resolveUpstreamTimeoutMs(timeoutMs);
  const controller = new AbortController();
  // Never `unref` this timer: it is the deadline the caller is waiting on, and
  // an unref'd timer lets the event loop exit with that promise still pending.
  // It is cleared in `finally`, so it does not outlive the call either.
  const timer = setTimeout(() => controller.abort(), timeout);
  const operation = run(controller.signal);
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(new UpstreamTimeoutError(timeout)), { once: true });
      }),
    ]);
  } catch (error) {
    // A cooperating transport usually rejects with its own abort error on the
    // very same tick the timer fires, and that can win the race. Once the
    // deadline has passed, the caller's answer is a timeout whatever shape the
    // transport used to say "aborted".
    if (controller.signal.aborted && !(error instanceof UpstreamTimeoutError)) {
      throw new UpstreamTimeoutError(timeout);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    // When the deadline won the race, `operation` may still reject later (an
    // aborted request does). Attach a handler so that late failure is not an
    // unhandled rejection; the caller already has the timeout.
    operation.catch(() => {});
  }
}
