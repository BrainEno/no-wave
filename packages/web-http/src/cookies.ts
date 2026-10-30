import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  SESSION_MARKER_COOKIE,
  tokenMaxAge,
  type TokenSet,
} from "./policy.ts";

export type { TokenSet };

/**
 * Cookie contract for the browser-facing session.
 *
 * The values below are security parameters, not conveniences: the access cookie
 * is scoped to `/api/authoring` so it is never sent to page routes, the refresh
 * cookie is scoped to `/api` so it can renew without reaching pages, both are
 * `HttpOnly` + `SameSite=Lax`, and `Secure` follows the browser-facing scheme so
 * a TLS-terminating proxy does not silently drop the cookie.
 *
 * The third cookie carries no token at all — see `SESSION_MARKER_COOKIE`. It is
 * scoped to `/` because its only job is to be visible to a page render, which is
 * precisely what the token cookies must not be.
 */
export const ACCESS_COOKIE_PATH = "/api/authoring";
export const REFRESH_COOKIE_PATH = "/api";
export const SESSION_COOKIE_PATH = "/";

export type CookieOptions = { path: string; maxAgeSeconds: number; secure: boolean };

/**
 * `secure` must describe the browser's connection, not this hop. Behind a TLS
 * proxy the request itself is plain HTTP, so `x-forwarded-proto` wins when it is
 * present and well formed.
 */
export function isSecureRequest(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim().toLowerCase();
    if (first === "https") return true;
    if (first === "http") return false;
  }
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const attributes = [
    `${name}=${value}`,
    `Path=${options.path}`,
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (options.secure) attributes.push("Secure");
  return attributes.join("; ");
}

/**
 * The marker's value: when the session can no longer be renewed.
 *
 * Stored as whole seconds so a page render can compare it with `Date.now()`
 * without parsing a date, and so its content stays obviously non-secret. An
 * unparseable expiry falls back to the cookie's own lifetime rather than to
 * `0`, which would log the visitor out on the spot.
 */
function sessionMarkerValue(refreshExpiresAt: string, now: number, maxAgeSeconds: number): string {
  const expiry = Date.parse(refreshExpiresAt);
  if (Number.isFinite(expiry)) return String(Math.max(0, Math.floor(expiry / 1000)));
  // No readable expiry: fall back to the lifetime the cookie jar is being given,
  // and to "none" when that is zero too. An unparseable date must never become
  // an open-ended private page.
  return maxAgeSeconds > 0 ? String(Math.floor((now + maxAgeSeconds * 1000) / 1000)) : "0";
}

export function tokenCookieHeaders(request: Request, tokens: TokenSet, now = Date.now()): string[] {
  const secure = isSecureRequest(request);
  const refreshMaxAge = tokenMaxAge(tokens.refreshExpiresAt, now);
  return [
    serializeCookie(ACCESS_TOKEN_COOKIE, tokens.accessToken, {
      path: ACCESS_COOKIE_PATH,
      maxAgeSeconds: tokenMaxAge(tokens.accessExpiresAt, now, 24 * 60 * 60),
      secure,
    }),
    serializeCookie(REFRESH_TOKEN_COOKIE, tokens.refreshToken, {
      path: REFRESH_COOKIE_PATH,
      maxAgeSeconds: refreshMaxAge,
      secure,
    }),
    serializeCookie(SESSION_MARKER_COOKIE, sessionMarkerValue(tokens.refreshExpiresAt, now, refreshMaxAge), {
      path: SESSION_COOKIE_PATH,
      maxAgeSeconds: refreshMaxAge,
      secure,
    }),
  ];
}

export function clearedTokenCookieHeaders(request: Request): string[] {
  const secure = isSecureRequest(request);
  return [
    serializeCookie(ACCESS_TOKEN_COOKIE, "", { path: ACCESS_COOKIE_PATH, maxAgeSeconds: 0, secure }),
    serializeCookie(REFRESH_TOKEN_COOKIE, "", { path: REFRESH_COOKIE_PATH, maxAgeSeconds: 0, secure }),
    // The marker goes with them: leaving it behind would keep private pages
    // rendering their shell for a session the API has already refused, which is
    // the one thing a visitor can read as "I am still signed in".
    serializeCookie(SESSION_MARKER_COOKIE, "", { path: SESSION_COOKIE_PATH, maxAgeSeconds: 0, secure }),
  ];
}

/** Read a single cookie from a request header without depending on a framework. */
export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

export function accessTokenFrom(request: Request): string | undefined {
  return readCookie(request, ACCESS_TOKEN_COOKIE);
}

export function refreshTokenFrom(request: Request): string | undefined {
  return readCookie(request, REFRESH_TOKEN_COOKIE);
}

export function sessionMarkerFrom(request: Request): string | undefined {
  return readCookie(request, SESSION_MARKER_COOKIE);
}

/**
 * Whether a page render may treat the visitor as possibly signed in.
 *
 * This decides **one** thing: render the private shell, or redirect to sign-in.
 * It is not authentication. The visitor proves who they are by presenting the
 * access token to the API, which happens on `/api/authoring/session` from the
 * browser; everything the shell renders comes from that answer.
 *
 * Anything unreadable counts as signed out — a marker that cannot be parsed has
 * no business keeping a private page open.
 */
export function hasUsableSession(value: string | undefined, now = Date.now()): boolean {
  if (typeof value !== "string" || !/^\d{1,15}$/.test(value)) return false;
  return Number(value) * 1000 > now;
}
