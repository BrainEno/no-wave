import { apiUrl, readPayload, type ApiProxyConfig, type FetchImpl } from "./api.ts";
import { accessTokenFrom, clearedTokenCookieHeaders, refreshTokenFrom, tokenCookieHeaders, type TokenSet } from "./cookies.ts";
import { NO_STORE, errorResponse } from "./http.ts";
import { isTokenEnvelope, setIdempotencyKeyHeader } from "./policy.ts";

/**
 * Authenticated API forwarder for the browser-facing authoring/session/media
 * routes.
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
): Promise<Response> {
  const base = config.apiBaseUrl;
  if (!base) {
    return errorResponse("SERVICE_UNAVAILABLE", "The API service is not configured.", 503);
  }
  const fetchImpl = config.fetchImpl ?? fetch;

  const refreshToken = refreshTokenFrom(request);
  let accessToken = accessTokenFrom(request);
  let rotated: TokenSet | null | undefined = null;
  let clearCookies = false;
  let upstream: Response;

  try {
    upstream = await callApi(fetchImpl, base, path, method, body, accessToken, contentType, request.headers.get("idempotency-key"));
    if (upstream.status === 401 && refreshToken) {
      // Retry exactly once: a refresh loop would hammer the identity service and
      // could replay a mutation more than once.
      const refreshAttempt = await upgradeSession(fetchImpl, base, refreshToken);
      if (refreshAttempt) {
        rotated = refreshAttempt;
        accessToken = refreshAttempt.accessToken;
        upstream = await callApi(fetchImpl, base, path, method, body, accessToken, contentType, request.headers.get("idempotency-key"));
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
