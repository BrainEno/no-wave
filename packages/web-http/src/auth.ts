import { apiUrl, readPayload, type ApiProxyConfig } from "./api.ts";
import { readLimitedJson } from "./body.ts";
import { clearedTokenCookieHeaders, refreshTokenFrom, tokenCookieHeaders } from "./cookies.ts";
import { errorResponse, isRecord, jsonResponse, safeApiError } from "./http.ts";
import { isSameOriginMutation, isTokenEnvelope } from "./policy.ts";

/**
 * Sign-in / register / refresh / logout proxy, framework-neutral.
 *
 * Preserves the verified Next.js behavior instead of re-deriving it:
 * - mutations require an exact same-origin `Origin` (checked against `Host`);
 * - login/register bodies are JSON with a 4 KiB ceiling;
 * - tokens leave the server only as `HttpOnly` cookies; the browser JSON carries
 *   an expiry, never a token value;
 * - upstream failures are passed through with a sanitized error body;
 * - logout is idempotent and always clears cookies, even when the API is down.
 *
 * The same route family also carries the account transitions that have no
 * session to speak of — see `IDENTITY_ACTIONS` below.
 */
export const AUTH_ACTIONS = ["login", "register", "refresh", "logout"] as const;
export type AuthAction = (typeof AUTH_ACTIONS)[number];

/**
 * Recovery and verification: ask for a link, spend a link.
 *
 * They share the route family because the browser posts to the same place and
 * the API serves the same path shape, but they must **not** share the handling:
 * they take a JSON body the way login does, they answer `{ data: { ok: true } }`
 * rather than a token envelope, and they never set a cookie. Putting them
 * through the envelope check below would turn every one of them into a 502.
 */
export const IDENTITY_ACTIONS = ["forgot-password", "reset-password", "verify-email"] as const;
export type IdentityAction = (typeof IDENTITY_ACTIONS)[number];

const LOGIN_BODY_LIMIT_BYTES = 4096;

export function isAuthAction(value: string | undefined): value is AuthAction {
  return typeof value === "string" && (AUTH_ACTIONS as readonly string[]).includes(value);
}

export function isIdentityAction(value: string | undefined): value is IdentityAction {
  return typeof value === "string" && (IDENTITY_ACTIONS as readonly string[]).includes(value);
}

export async function handleAuthRequest(
  request: Request,
  action: string | undefined,
  config: ApiProxyConfig = {},
): Promise<Response> {
  if (!isAuthAction(action) && !isIdentityAction(action)) {
    return errorResponse("NOT_FOUND", "The authentication route was not found.", 404);
  }
  if (!isSameOriginMutation(request.url, request.headers.get("origin"), request.headers.get("host"))) {
    return errorResponse("ORIGIN_REJECTED", "The request origin was rejected.", 403);
  }

  const base = config.apiBaseUrl;
  if (!base) {
    return errorResponse(
      "SERVICE_UNAVAILABLE",
      "The API service is not configured.",
      503,
      action === "logout" ? clearedTokenCookieHeaders(request) : [],
    );
  }

  // Diverted before any session handling: these three neither read nor write
  // credentials, so the token machinery below must never see them.
  if (isIdentityAction(action)) return handleIdentityAction(request, action, base, config);

  let body: string;
  if (action === "login" || action === "register") {
    const parsed = await readLimitedJson(request, LOGIN_BODY_LIMIT_BYTES);
    if (!parsed.ok) return parsed.response;
    body = parsed.text;
  } else {
    const refreshToken = refreshTokenFrom(request);
    if (!refreshToken && action === "logout") {
      return jsonResponse({ data: { ok: true } }, 200, clearedTokenCookieHeaders(request));
    }
    if (!refreshToken) {
      return errorResponse("UNAUTHENTICATED", "Please sign in again.", 401);
    }
    body = JSON.stringify({ refreshToken });
  }

  const fetchImpl = config.fetchImpl ?? fetch;
  let upstream: Response;
  try {
    upstream = await fetchImpl(apiUrl(base, `api/v1/auth/${action}`), {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json; charset=utf-8" },
      body,
      cache: "no-store",
    });
  } catch {
    return errorResponse(
      "SERVICE_UNAVAILABLE",
      "The API service could not be reached.",
      502,
      action === "logout" ? clearedTokenCookieHeaders(request) : [],
    );
  }

  const payload = await readPayload(upstream);

  if (action === "logout") {
    // Logout succeeds locally even if the API rejects the refresh token: the
    // browser's cookies are the only thing this proxy can guarantee.
    if (upstream.status === 401 || upstream.ok) {
      return jsonResponse({ data: { ok: true } }, 200, clearedTokenCookieHeaders(request));
    }
    return jsonResponse(safeApiError(payload, upstream.status), upstream.status, clearedTokenCookieHeaders(request));
  }

  if (!upstream.ok) {
    return jsonResponse(safeApiError(payload, upstream.status), upstream.status);
  }
  if (!isTokenEnvelope(payload)) {
    return errorResponse("INVALID_AUTH_RESPONSE", "The API returned an invalid authentication response.", 502);
  }

  return jsonResponse(
    // The browser learns when the session expires, never what the token is.
    { data: { tokenType: "Bearer", accessExpiresAt: payload.data.accessExpiresAt } },
    upstream.status,
    tokenCookieHeaders(request, payload.data),
  );
}

/**
 * `POST /api/auth/forgot-password`, `/reset-password`, `/verify-email`.
 *
 * A bounded JSON body, an exact-Origin check already applied by the caller, and
 * nothing else: the response carries no token, so no cookie is written. The one
 * case that *removes* cookies is a successful password reset, because the API
 * has just revoked every session of that account — the cookies this browser
 * holds are stale by definition, and leaving them behind turns a recovery into
 * "signed in as whoever refetched first".
 */
async function handleIdentityAction(
  request: Request,
  action: IdentityAction,
  base: string,
  config: ApiProxyConfig,
): Promise<Response> {
  const parsed = await readLimitedJson(request, LOGIN_BODY_LIMIT_BYTES);
  if (!parsed.ok) return parsed.response;

  const fetchImpl = config.fetchImpl ?? fetch;
  let upstream: Response;
  try {
    upstream = await fetchImpl(apiUrl(base, `api/v1/auth/${action}`), {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json; charset=utf-8" },
      body: parsed.text,
      cache: "no-store",
    });
  } catch {
    return errorResponse("SERVICE_UNAVAILABLE", "The API service could not be reached.", 502);
  }

  const payload = await readPayload(upstream);
  if (!upstream.ok) return jsonResponse(safeApiError(payload, upstream.status), upstream.status);

  // Only a successful reset ends sessions; a rejected one changes nothing, so
  // it must not clear cookies the visitor may still be using.
  const cookies = action === "reset-password" ? clearedTokenCookieHeaders(request) : [];
  if (!isRecord(payload) || !isRecord(payload.data)) {
    return errorResponse("INVALID_AUTH_RESPONSE", "The API returned an invalid authentication response.", 502, cookies);
  }
  return jsonResponse({ data: payload.data }, upstream.status, cookies);
}
