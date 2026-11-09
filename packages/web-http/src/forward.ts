import {
  UpstreamTimeoutError,
  apiUrl,
  resolveUpstreamTimeoutMs,
  withUpstreamDeadline,
  type ApiProxyConfig,
  type FetchImpl,
} from "./api.ts";
import { accessTokenFrom, clearedTokenCookieHeaders, refreshTokenFrom, tokenCookieHeaders, type TokenSet } from "./cookies.ts";
import { NO_STORE, errorResponse } from "./http.ts";
import { isTokenEnvelope, setIdempotencyKeyHeader } from "./policy.ts";
import { parseRetryAfterSeconds } from "./retry-after.ts";
import { InMemoryRefreshCoordinator, refreshCoordinatorKey, type RefreshCoordinator } from "./refresh-coordinator.ts";

/**
 * Concurrent 401s must agree on one rotation (ADR 0025). Production requests
 * share the process-wide coordinator. A caller that injects its own `fetchImpl`
 * is talking to a different upstream transport, so it gets its own ledger —
 * rotation results never cross transports, and an injected test transport is
 * isolated from every other one. `config.refreshCoordinator` is the explicit
 * override a multi-instance deployment uses for a shared implementation.
 */
const processRefreshCoordinator = new InMemoryRefreshCoordinator();
const transportRefreshCoordinators = new WeakMap<FetchImpl, RefreshCoordinator>();

function coordinatorFor(config: ApiProxyConfig): RefreshCoordinator {
  if (config.refreshCoordinator) return config.refreshCoordinator;
  const transport = config.fetchImpl;
  if (!transport) return processRefreshCoordinator;
  let scoped = transportRefreshCoordinators.get(transport);
  if (!scoped) {
    scoped = new InMemoryRefreshCoordinator();
    transportRefreshCoordinators.set(transport, scoped);
  }
  return scoped;
}

/**
 * Authenticated API forwarder for the browser-facing authoring/session/media
 * and inbox routes.
 *
 * The access token lives in an `HttpOnly` cookie, so this function — not the
 * browser — attaches the `Authorization` header, performs one refresh-and-retry
 * when the API answers 401, and clears the cookies when the refresh token is
 * rejected. Tokens are never returned to the browser.
 */
export type ForwardMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * One upstream reply, fully read.
 *
 * The body is buffered inside the same deadline as the connection: a proxy that
 * forwards JSON has to finish with it, and an upstream that sends headers and
 * then stops mid-body would otherwise hold the caller exactly like a hung
 * connection. The proxied surface is JSON of bounded size, so buffering does not
 * change what this forwarder can carry.
 */
type BufferedUpstream = {
  status: number;
  contentType: string | null;
  text: string;
  /**
   * The raw upstream `Retry-After`, kept so a throttled caller can be told when
   * to come back (#244).
   *
   * It is relayed through `parseRetryAfterSeconds`, exactly like the auth
   * proxy's error path: the browser sees normalized integer seconds and nothing
   * else, so this cannot become a channel for arbitrary upstream headers.
   */
  retryAfter: string | null;
};

/** The `data` field of a `{ data: ... }` envelope, or `null` when unusable. */
function dataFromText(text: string): unknown {
  try {
    const payload: unknown = JSON.parse(text);
    return typeof payload === "object" && payload !== null && "data" in payload
      ? (payload as { data?: unknown }).data
      : null;
  } catch {
    return null;
  }
}

async function callApi(
  fetchImpl: FetchImpl,
  base: string,
  path: string,
  method: ForwardMethod,
  body: BodyInit | undefined,
  token: string | undefined,
  contentType: string,
  idempotencyKey: string | null,
  timeoutMs: number,
): Promise<BufferedUpstream> {
  const headers = new Headers({ accept: "application/json" });
  if (body !== undefined) headers.set("content-type", contentType);
  if (token) headers.set("authorization", `Bearer ${token}`);
  setIdempotencyKeyHeader(headers, idempotencyKey);
  return withUpstreamDeadline(timeoutMs, async (signal) => {
    const response = await fetchImpl(apiUrl(base, path), {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      cache: "no-store",
      signal,
    });
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      text: await response.text(),
      retryAfter: response.headers.get("retry-after"),
    };
  });
}

export async function forwardAuthoringRequest(
  request: Request,
  path: string,
  method: ForwardMethod,
  config: ApiProxyConfig = {},
  body?: BodyInit,
  contentType = "application/json; charset=utf-8",
  expectedActorId?: string,
  verifyViewerIfPresent = false,
): Promise<Response> {
  const base = config.apiBaseUrl;
  if (!base) {
    return errorResponse("SERVICE_UNAVAILABLE", "The API service is not configured.", 503);
  }
  const fetchImpl = config.fetchImpl ?? fetch;
  const apiBase = base;
  let timeoutMs: number;
  try {
    timeoutMs = resolveUpstreamTimeoutMs(config.upstreamTimeoutMs);
  } catch {
    // A malformed budget is a deployment error. Answer like a missing origin
    // instead of letting a typo become an unbounded wait.
    return errorResponse("SERVICE_UNAVAILABLE", "The API service is not configured correctly.", 503);
  }

  const refreshToken = refreshTokenFrom(request);
  let accessToken = accessTokenFrom(request);
  let rotated: TokenSet | null | undefined = null;
  let clearCookies = false;
  /** A complete answer that is not the resource reply (identity check, failure). */
  let reply: Response | undefined;
  let upstream: BufferedUpstream | undefined;

  // An optional restrictive precondition, never an identity supplied by the
  // client: compare the API's verified /me to the editor's expected actor using
  // the *same token* as the following write. Recheck after a refresh. Checking
  // in the browser instead would race a cross-tab cookie/account change.
  //
  // A viewer-specific field on an otherwise public read needs the same check:
  // the upstream treats expired/missing bearer tokens as anonymous and returns
  // 200, which would bypass the usual 401-triggered refresh. With any session
  // credential present, verify /me first; a genuinely anonymous read skips it.
  const verifyViewer = verifyViewerIfPresent && Boolean(accessToken || refreshToken);
  async function guardedCall(token: string | undefined): Promise<BufferedUpstream | Response> {
    if (expectedActorId !== undefined || verifyViewer) {
      const identity = await callApi(fetchImpl, apiBase, "api/v1/me", "GET", undefined, token, contentType, null, timeoutMs);
      if (identity.status < 200 || identity.status > 299) {
        return new Response(identity.text, {
          status: identity.status,
          headers: new Headers({
            "cache-control": NO_STORE,
            "content-type": identity.contentType ?? "application/json; charset=utf-8",
          }),
        });
      }
      const data = dataFromText(identity.text);
      const id = typeof data === "object" && data !== null && "id" in data
        ? (data as { id?: unknown }).id : null;
      if (typeof id !== "string" || id.length === 0) {
        return errorResponse("SERVICE_UNAVAILABLE", "The current account could not be verified.", 502);
      }
      if (expectedActorId !== undefined && id !== expectedActorId) {
        return errorResponse("ACCOUNT_CHANGED", "The signed-in account changed. Sign in to the original account.", 409);
      }
    }
    return callApi(
      fetchImpl,
      apiBase,
      path,
      method,
      body,
      token,
      contentType,
      request.headers.get("idempotency-key"),
      timeoutMs,
    );
  }

  try {
    const first = await guardedCall(accessToken);
    // Either shape can be a 401: the resource itself, or the preceding /me
    // precondition (which is answered by the identity service and can expire
    // first). Both mean "this credential is stale, try one rotation".
    if (first.status !== 401 || !refreshToken) {
      if (first instanceof Response) reply = first;
      else upstream = first;
    } else {
      // Retry exactly once: a refresh loop would hammer the identity service and
      // could replay a mutation more than once. Every request carrying this same
      // stale credential pair joins one rotation instead of consuming the token
      // again — a second presentation would revoke the whole session family.
      const key = await refreshCoordinatorKey(base, refreshToken, accessToken);
      const refreshAttempt = await coordinatorFor(config).resolve(
        key,
        () => upgradeSession(fetchImpl, base, refreshToken, timeoutMs),
      );
      if (refreshAttempt) {
        rotated = refreshAttempt;
        accessToken = refreshAttempt.accessToken;
        const retried = await guardedCall(accessToken);
        if (retried instanceof Response) reply = retried;
        else upstream = retried;
      } else {
        if (refreshAttempt === null) {
          // A rejected refresh token means the session is over: clear it instead of
          // leaving the browser to retry with a credential the API already refused.
          clearCookies = true;
        }
        // Pass the original 401 through: it failed for a reason this proxy cannot
        // improve on, and the refresh proved nothing about the session.
        if (first instanceof Response) reply = first;
        else upstream = first;
      }
    }
  } catch (error) {
    reply = error instanceof UpstreamTimeoutError
      ? errorResponse("UPSTREAM_TIMEOUT", "The API service did not answer in time.", 504)
      : errorResponse("SERVICE_UNAVAILABLE", "The API service could not be reached.", 502);
  }

  let response: Response;
  if (reply) {
    response = reply;
  } else if (upstream) {
    const headers = new Headers({
      "cache-control": NO_STORE,
      "content-type": upstream.contentType ?? "application/json; charset=utf-8",
    });
    // A 429 from the API carries how long the caller should wait; dropping it
    // left the browser with no way to back off except guessing (#244).
    const retryAfterSeconds = parseRetryAfterSeconds(upstream.retryAfter);
    if (retryAfterSeconds !== null) headers.set("retry-after", String(retryAfterSeconds));
    response = new Response(upstream.text, { status: upstream.status, headers });
  } else {
    response = errorResponse("SERVICE_UNAVAILABLE", "The API service could not be reached.", 502);
  }

  if (rotated) {
    for (const cookie of tokenCookieHeaders(request, rotated)) response.headers.append("set-cookie", cookie);
  } else if (clearCookies) {
    for (const cookie of clearedTokenCookieHeaders(request)) response.headers.append("set-cookie", cookie);
  }
  return response;
}

/**
 * Read a public resource whose response contains viewer-specific state. When a
 * session cookie is present, verify it before fetching the public resource so
 * an expired access cookie cannot be mistaken for a signed-out reader. Both the
 * verification and read use the same access token, including after refresh.
 */
export function forwardViewerRead(request: Request, path: string, config: ApiProxyConfig = {}): Promise<Response> {
  return forwardAuthoringRequest(request, path, "GET", config, undefined, undefined, undefined, true);
}

/**
 * Refresh the session.
 *
 * Returns the rotated token set on success, `null` when the refresh token was
 * definitively rejected (the caller must clear cookies), and `undefined` when the
 * refresh failed in a way that proves nothing about the session (network error or
 * 5xx), where the original 401 must simply be passed through.
 */
async function upgradeSession(
  fetchImpl: FetchImpl,
  base: string,
  refreshToken: string,
  timeoutMs: number,
): Promise<TokenSet | null | undefined> {
  let result: BufferedUpstream;
  try {
    // The rotation has its own budget. A timeout here (like a network failure)
    // proves nothing about the session, so the original 401 is passed through
    // instead of clearing a credential that may still be valid upstream.
    result = await withUpstreamDeadline(timeoutMs, async (signal) => {
      const response = await fetchImpl(apiUrl(base, "api/v1/auth/refresh"), {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ refreshToken }),
        cache: "no-store",
        signal,
      });
      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
        text: await response.text(),
        retryAfter: response.headers.get("retry-after"),
      };
    });
  } catch {
    return undefined;
  }
  let payload: unknown = null;
  try {
    payload = JSON.parse(result.text) as unknown;
  } catch {
    payload = null;
  }
  if (result.status >= 200 && result.status <= 299 && isTokenEnvelope(payload)) return payload.data;
  if (result.status === 400 || result.status === 401) return null;
  return undefined;
}
