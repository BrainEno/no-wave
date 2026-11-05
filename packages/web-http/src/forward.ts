import { apiUrl, readPayload, type ApiProxyConfig, type FetchImpl } from "./api.ts";
import { accessTokenFrom, clearedTokenCookieHeaders, refreshTokenFrom, tokenCookieHeaders, type TokenSet } from "./cookies.ts";
import { NO_STORE, errorResponse } from "./http.ts";
import { isTokenEnvelope, setIdempotencyKeyHeader } from "./policy.ts";
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

async function callApi(
  fetchImpl: FetchImpl,
  base: string,
  path: string,
  method: ForwardMethod,
  body: BodyInit | undefined,
  token: string | undefined,
  contentType: string,
  idempotencyKey: string | null,
): Promise<Response> {
  const headers = new Headers({ accept: "application/json" });
  if (body !== undefined) headers.set("content-type", contentType);
  if (token) headers.set("authorization", `Bearer ${token}`);
  setIdempotencyKeyHeader(headers, idempotencyKey);
  return fetchImpl(apiUrl(base, path), {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    cache: "no-store",
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

  const refreshToken = refreshTokenFrom(request);
  let accessToken = accessTokenFrom(request);
  let rotated: TokenSet | null | undefined = null;
  let clearCookies = false;
  let upstream: Response;

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
  async function guardedCall(token: string | undefined): Promise<Response> {
    if (expectedActorId !== undefined || verifyViewer) {
      const identity = await callApi(fetchImpl, apiBase, "api/v1/me", "GET", undefined, token, contentType, null);
      if (!identity.ok) return identity;
      const payload: unknown = await identity.json().catch(() => null);
      const data = typeof payload === "object" && payload !== null && "data" in payload
        ? (payload as { data?: unknown }).data : null;
      const id = typeof data === "object" && data !== null && "id" in data
        ? (data as { id?: unknown }).id : null;
      if (typeof id !== "string" || id.length === 0) {
        return errorResponse("SERVICE_UNAVAILABLE", "The current account could not be verified.", 502);
      }
      if (expectedActorId !== undefined && id !== expectedActorId) {
        return errorResponse("ACCOUNT_CHANGED", "The signed-in account changed. Sign in to the original account.", 409);
      }
    }
    return callApi(fetchImpl, apiBase, path, method, body, token, contentType, request.headers.get("idempotency-key"));
  }

  try {
    upstream = await guardedCall(accessToken);
    if (upstream.status === 401 && refreshToken) {
      // Retry exactly once: a refresh loop would hammer the identity service and
      // could replay a mutation more than once. Every request carrying this same
      // stale credential pair joins one rotation instead of consuming the token
      // again — a second presentation would revoke the whole session family.
      const key = await refreshCoordinatorKey(base, refreshToken, accessToken);
      const refreshAttempt = await coordinatorFor(config).resolve(
        key,
        () => upgradeSession(fetchImpl, base, refreshToken),
      );
      if (refreshAttempt) {
        rotated = refreshAttempt;
        accessToken = refreshAttempt.accessToken;
        upstream = await guardedCall(accessToken);
      } else if (refreshAttempt === null) {
        // A rejected refresh token means the session is over: clear it instead of
        // leaving the browser to retry with a credential the API already refused.
        clearCookies = true;
      }
    }
  } catch {
    return errorResponse("SERVICE_UNAVAILABLE", "The API service could not be reached.", 502);
  }

  const headers = new Headers({ "cache-control": NO_STORE });
  headers.set("content-type", upstream.headers.get("content-type") ?? "application/json; charset=utf-8");
  const text = await upstream.text();
  const response = new Response(text, { status: upstream.status, headers });

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
async function upgradeSession(fetchImpl: FetchImpl, base: string, refreshToken: string): Promise<TokenSet | null | undefined> {
  let response: Response;
  try {
    response = await fetchImpl(apiUrl(base, "api/v1/auth/refresh"), {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ refreshToken }),
      cache: "no-store",
    });
  } catch {
    return undefined;
  }
  const payload = await readPayload(response);
  if (response.ok && isTokenEnvelope(payload)) return payload.data;
  if (response.status === 400 || response.status === 401) return null;
  return undefined;
}
