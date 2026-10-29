import { resolveApiBaseUrl } from "@/lib/api-content.ts";
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  isSameOriginMutation,
  isTokenEnvelope,
  tokenMaxAge,
} from "@/lib/authoring-proxy-policy.ts";

/**
 * Framework-neutral authentication proxy.
 *
 * ADR 0012 requires this boundary to be portable, so the whole handler is
 * written against standard `Request`/`Response`/`Headers` and reads everything
 * it needs from explicit inputs. The React Router resource route in
 * `app/routes/api.auth.ts` is a three-line adapter over `handleAuthRequest`, and
 * the Next.js route handler keeps working independently until cutover.
 *
 * Behavior mirrored from the verified Next.js implementation
 * (`apps/web/src/lib/authoring-proxy.ts`), not translated mechanically:
 * exact same-origin check for mutations, JSON-only bodies with a byte ceiling,
 * `HttpOnly` + `SameSite=Lax` cookies on the documented paths, no token value in
 * any browser-visible JSON, sanitized upstream errors and the same status codes.
 */
const NO_STORE = "no-store, max-age=0";
const ACCESS_COOKIE_PATH = "/api/authoring";
const REFRESH_COOKIE_PATH = "/api";
const LOGIN_BODY_LIMIT_BYTES = 4096;

export const AUTH_ACTIONS = ["login", "register", "logout"] as const;
export type AuthAction = (typeof AUTH_ACTIONS)[number];

function isAuthAction(value: string | undefined): value is AuthAction {
  return typeof value === "string" && (AUTH_ACTIONS as readonly string[]).includes(value);
}

function json(body: unknown, status: number, cookies: readonly string[] = []): Response {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": NO_STORE },
  });
  // `set-cookie` must be appended, never joined: a combined header value is a
  // single malformed cookie that browsers discard.
  for (const cookie of cookies) response.headers.append("set-cookie", cookie);
  return response;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Browsers only send `Origin` on cross-origin and same-origin POSTs, so an
 * absent header is treated as hostile. `request.url` is the real request URL
 * under any Node adapter, and `Host` is the authority the browser used.
 */
function mutationIsSameOrigin(request: Request): boolean {
  return isSameOriginMutation(request.url, request.headers.get("origin"), request.headers.get("host"));
}

/**
 * `secure` must follow the browser-facing scheme. Behind a TLS-terminating
 * proxy the hop itself is plain HTTP, so `x-forwarded-proto` wins when present.
 */
function isSecureRequest(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0]?.trim() === "https";
  return new URL(request.url).protocol === "https:";
}

function serializeCookie(
  request: Request,
  name: string,
  value: string,
  path: string,
  maxAgeSeconds: number,
): string {
  const attributes = [
    `${name}=${value}`,
    `Path=${path}`,
    `Max-Age=${maxAgeSeconds}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (isSecureRequest(request)) attributes.push("Secure");
  return attributes.join("; ");
}

function tokenCookies(request: Request, accessToken: string, refreshToken: string, accessExpiresAt: string, refreshExpiresAt: string): string[] {
  const now = Date.now();
  return [
    serializeCookie(request, ACCESS_TOKEN_COOKIE, accessToken, ACCESS_COOKIE_PATH, tokenMaxAge(accessExpiresAt, now, 24 * 60 * 60)),
    serializeCookie(request, REFRESH_TOKEN_COOKIE, refreshToken, REFRESH_COOKIE_PATH, tokenMaxAge(refreshExpiresAt, now)),
  ];
}

function clearedTokenCookies(request: Request): string[] {
  return [
    serializeCookie(request, ACCESS_TOKEN_COOKIE, "", ACCESS_COOKIE_PATH, 0),
    serializeCookie(request, REFRESH_TOKEN_COOKIE, "", REFRESH_COOKIE_PATH, 0),
  ];
}

function cookieValue(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

function safeApiError(value: unknown, status: number): { error: { code: string; message: string } } {
  const fallbackCode = status >= 500 ? "SERVICE_UNAVAILABLE" : "AUTHENTICATION_FAILED";
  const fallbackMessage = status >= 500
    ? "The authentication service is temporarily unavailable."
    : "The authentication request was rejected.";
  if (!isRecord(value) || !isRecord(value.error)) return { error: { code: fallbackCode, message: fallbackMessage } };
  const code = typeof value.error.code === "string" && /^[A-Z0-9_]{1,80}$/.test(value.error.code) ? value.error.code : fallbackCode;
  const message = typeof value.error.message === "string" && value.error.message.length <= 240 ? value.error.message : fallbackMessage;
  return { error: { code, message } };
}

/** Read a bounded JSON object body. Returns a ready-to-send failure response otherwise. */
async function readJsonBody(request: Request, maximumBytes: number): Promise<{ ok: true; text: string } | { ok: false; response: Response }> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return { ok: false, response: json({ error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "A JSON request body is required." } }, 415) };
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    return { ok: false, response: json({ error: { code: "PAYLOAD_TOO_LARGE", message: "The request body is too large." } }, 413) };
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maximumBytes) {
    return { ok: false, response: json({ error: { code: "PAYLOAD_TOO_LARGE", message: "The request body is too large." } }, 413) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, response: json({ error: { code: "BAD_USER_INPUT", message: "The request body must be valid JSON." } }, 400) };
  }
  if (!isRecord(parsed)) {
    return { ok: false, response: json({ error: { code: "BAD_USER_INPUT", message: "The request body must be a JSON object." } }, 400) };
  }
  return { ok: true, text };
}

export async function handleAuthRequest(request: Request, action: string | undefined): Promise<Response> {
  if (!isAuthAction(action)) {
    return json({ error: { code: "NOT_FOUND", message: "Unknown authentication action." } }, 404);
  }
  if (!mutationIsSameOrigin(request)) {
    return json({ error: { code: "ORIGIN_REJECTED", message: "The request origin was rejected." } }, 403);
  }

  let base: string | undefined;
  try {
    base = resolveApiBaseUrl();
  } catch {
    base = undefined;
  }
  if (!base) {
    const cookies = action === "logout" ? clearedTokenCookies(request) : [];
    return json({ error: { code: "SERVICE_UNAVAILABLE", message: "The API service is not configured." } }, 503, cookies);
  }

  let body: string;
  if (action === "logout") {
    const refreshToken = cookieValue(request, REFRESH_TOKEN_COOKIE);
    if (!refreshToken) return json({ data: { ok: true } }, 200);
    body = JSON.stringify({ refreshToken });
  } else {
    const parsed = await readJsonBody(request, LOGIN_BODY_LIMIT_BYTES);
    if (!parsed.ok) return parsed.response;
    body = parsed.text;
  }

  let upstream: Response;
  try {
    upstream = await fetch(new URL(`api/v1/auth/${action}`, `${base.replace(/\/+$/, "")}/`), {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json; charset=utf-8" },
      body,
      cache: "no-store",
    });
  } catch {
    return json({ error: { code: "SERVICE_UNAVAILABLE", message: "The API service could not be reached." } }, 502);
  }

  const payload: unknown = await upstream.json().catch(() => null);

  if (action === "logout") {
    return json({ data: { ok: true } }, 200, clearedTokenCookies(request));
  }
  if (!upstream.ok) {
    return json(safeApiError(payload, upstream.status), upstream.status);
  }
  if (!isTokenEnvelope(payload)) {
    return json({ error: { code: "INVALID_AUTH_RESPONSE", message: "The API returned an invalid authentication response." } }, 502);
  }

  const tokens = payload.data;
  return json(
    // The browser never receives the token values; they only travel in cookies.
    { data: { tokenType: "Bearer", accessExpiresAt: tokens.accessExpiresAt } },
    upstream.status,
    tokenCookies(request, tokens.accessToken, tokens.refreshToken, tokens.accessExpiresAt, tokens.refreshExpiresAt),
  );
}
