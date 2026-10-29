import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE, tokenMaxAge, type TokenSet } from "./policy.ts";

export type { TokenSet };

/**
 * Cookie contract for the browser-facing session.
 *
 * The values below are security parameters, not conveniences: the access cookie
 * is scoped to `/api/authoring` so it is never sent to page routes, the refresh
 * cookie is scoped to `/api` so it can renew without reaching pages, both are
 * `HttpOnly` + `SameSite=Lax`, and `Secure` follows the browser-facing scheme so
 * a TLS-terminating proxy does not silently drop the cookie.
 */
export const ACCESS_COOKIE_PATH = "/api/authoring";
export const REFRESH_COOKIE_PATH = "/api";

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

export function tokenCookieHeaders(request: Request, tokens: TokenSet, now = Date.now()): string[] {
  const secure = isSecureRequest(request);
  return [
    serializeCookie(ACCESS_TOKEN_COOKIE, tokens.accessToken, {
      path: ACCESS_COOKIE_PATH,
      maxAgeSeconds: tokenMaxAge(tokens.accessExpiresAt, now, 24 * 60 * 60),
      secure,
    }),
    serializeCookie(REFRESH_TOKEN_COOKIE, tokens.refreshToken, {
      path: REFRESH_COOKIE_PATH,
      maxAgeSeconds: tokenMaxAge(tokens.refreshExpiresAt, now),
      secure,
    }),
  ];
}

export function clearedTokenCookieHeaders(request: Request): string[] {
  const secure = isSecureRequest(request);
  return [
    serializeCookie(ACCESS_TOKEN_COOKIE, "", { path: ACCESS_COOKIE_PATH, maxAgeSeconds: 0, secure }),
    serializeCookie(REFRESH_TOKEN_COOKIE, "", { path: REFRESH_COOKIE_PATH, maxAgeSeconds: 0, secure }),
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
