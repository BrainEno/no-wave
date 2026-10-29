import { NextRequest, NextResponse } from "next/server";
import { resolveApiBaseUrl } from "./api-content.ts";
import {
  ACCESS_TOKEN_COOKIE,
  isSameOriginMutation,
  isTokenEnvelope,
  REFRESH_TOKEN_COOKIE,
  tokenMaxAge,
  type TokenSet,
} from "./authoring-proxy-policy.ts";

const NO_STORE = { "cache-control": "no-store, max-age=0" };
const ACCESS_COOKIE_PATH = "/api/authoring";
const REFRESH_COOKIE_PATH = "/api";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cookieOptions(request: NextRequest, path: string, maxAge: number) {
  return {
    httpOnly: true,
    secure: request.nextUrl.protocol === "https:",
    sameSite: "lax" as const,
    path,
    maxAge,
  };
}

function applyTokenCookies(response: NextResponse, request: NextRequest, tokens: TokenSet): void {
  response.cookies.set(ACCESS_TOKEN_COOKIE, tokens.accessToken, cookieOptions(
    request, ACCESS_COOKIE_PATH, tokenMaxAge(tokens.accessExpiresAt, Date.now(), 24 * 60 * 60),
  ));
  response.cookies.set(REFRESH_TOKEN_COOKIE, tokens.refreshToken, cookieOptions(
    request, REFRESH_COOKIE_PATH, tokenMaxAge(tokens.refreshExpiresAt),
  ));
}

function clearTokenCookies(response: NextResponse, request: NextRequest): void {
  response.cookies.set(ACCESS_TOKEN_COOKIE, "", cookieOptions(request, ACCESS_COOKIE_PATH, 0));
  response.cookies.set(REFRESH_TOKEN_COOKIE, "", cookieOptions(request, REFRESH_COOKIE_PATH, 0));
}

function apiUrl(base: string, path: string): string {
  return new URL(path.replace(/^\/+/, ""), base.replace(/\/+$/, "") + "/").toString();
}

async function callApi(base: string, path: string, method: string, body: BodyInit | undefined, token?: string, contentType = "application/json; charset=utf-8", idempotencyKey?: string | null): Promise<Response> {
  const headers = new Headers({ accept: "application/json" });
  if (body !== undefined) headers.set("content-type", contentType);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (idempotencyKey !== undefined && idempotencyKey !== null) headers.set("idempotency-key", idempotencyKey);
  return fetch(apiUrl(base, path), {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    cache: "no-store",
  });
}

async function readPayload(response: Response): Promise<unknown> {
  try { return await response.clone().json() as unknown; }
  catch { return null; }
}

function safeApiError(value: unknown, status: number): { error: { code: string; message: string } } {
  const fallbackCode = status >= 500 ? "SERVICE_UNAVAILABLE" : "AUTHENTICATION_FAILED";
  const fallbackMessage = status >= 500 ? "The authentication service is temporarily unavailable." : "The authentication request was rejected.";
  if (!isRecord(value) || !isRecord(value.error)) {
    return { error: { code: fallbackCode, message: fallbackMessage } };
  }
  const code = typeof value.error.code === "string" && /^[A-Z0-9_]{1,80}$/.test(value.error.code)
    ? value.error.code : fallbackCode;
  const message = typeof value.error.message === "string" && value.error.message.length <= 240
    ? value.error.message : fallbackMessage;
  return { error: { code, message } };
}

export async function readLimitedJsonObject(
  request: NextRequest,
  maximumBytes = 2_000_000,
): Promise<{ ok: true; text: string } | { ok: false; response: NextResponse }> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return { ok: false, response: NextResponse.json({ error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "A JSON request body is required." } }, { status: 415, headers: NO_STORE }) };
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    return { ok: false, response: NextResponse.json({ error: { code: "PAYLOAD_TOO_LARGE", message: "The request body is too large." } }, { status: 413, headers: NO_STORE }) };
  }
  let text: string;
  try { text = await request.text(); }
  catch {
    return { ok: false, response: NextResponse.json({ error: { code: "BAD_USER_INPUT", message: "The request body could not be read." } }, { status: 400, headers: NO_STORE }) };
  }
  if (new TextEncoder().encode(text).byteLength > maximumBytes) {
    return { ok: false, response: NextResponse.json({ error: { code: "PAYLOAD_TOO_LARGE", message: "The request body is too large." } }, { status: 413, headers: NO_STORE }) };
  }
  let value: unknown;
  try { value = JSON.parse(text) as unknown; }
  catch {
    return { ok: false, response: NextResponse.json({ error: { code: "BAD_USER_INPUT", message: "The request body must be valid JSON." } }, { status: 400, headers: NO_STORE }) };
  }
  if (!isRecord(value)) {
    return { ok: false, response: NextResponse.json({ error: { code: "BAD_USER_INPUT", message: "The request body must be a JSON object." } }, { status: 400, headers: NO_STORE }) };
  }
  return { ok: true, text };
}

export async function handleAuthPost(
  request: NextRequest,
  action: "login" | "register" | "refresh" | "logout",
): Promise<NextResponse> {
  if (!isSameOriginMutation(request.url, request.headers.get("origin"))) {
    return NextResponse.json({ error: { code: "ORIGIN_REJECTED", message: "The request origin was rejected." } }, { status: 403, headers: NO_STORE });
  }
  let body: string;
  if (action === "login" || action === "register") {
    const parsed = await readLimitedJsonObject(request, 4096);
    if (!parsed.ok) return parsed.response;
    body = parsed.text;
  } else {
    const refreshToken = request.cookies.get(REFRESH_TOKEN_COOKIE)?.value;
    if (!refreshToken && action === "logout") {
      const response = NextResponse.json({ data: { ok: true } }, { status: 200, headers: NO_STORE });
      clearTokenCookies(response, request);
      return response;
    }
    if (!refreshToken) {
      return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Please sign in again." } }, { status: 401, headers: NO_STORE });
    }
    body = JSON.stringify({ refreshToken });
  }

  let base: string | undefined;
  try { base = resolveApiBaseUrl(); } catch { base = undefined; }
  if (!base) {
    const response = NextResponse.json({ error: { code: "SERVICE_UNAVAILABLE", message: "The API service is not configured." } }, { status: 503, headers: NO_STORE });
    if (action === "logout") clearTokenCookies(response, request);
    return response;
  }

  let upstream: Response;
  try {
    upstream = await callApi(base, `api/v1/auth/${action}`, "POST", body);
  } catch {
    const response = NextResponse.json({ error: { code: "SERVICE_UNAVAILABLE", message: "The API service could not be reached." } }, { status: 502, headers: NO_STORE });
    if (action === "logout") clearTokenCookies(response, request);
    return response;
  }

  const payload = await readPayload(upstream);
  if (!upstream.ok) {
    const response = NextResponse.json(safeApiError(payload, upstream.status), { status: upstream.status, headers: NO_STORE });
    if (action === "logout") {
      clearTokenCookies(response, request);
      if (upstream.status === 401) {
        const loggedOut = NextResponse.json({ data: { ok: true } }, { status: 200, headers: NO_STORE });
        clearTokenCookies(loggedOut, request);
        return loggedOut;
      }
    }
    return response;
  }

  if (action === "logout") {
    const response = NextResponse.json({ data: { ok: true } }, { status: 200, headers: NO_STORE });
    clearTokenCookies(response, request);
    return response;
  }
  if (!isTokenEnvelope(payload)) {
    return NextResponse.json({ error: { code: "INVALID_AUTH_RESPONSE", message: "The API returned an invalid authentication response." } }, { status: 502, headers: NO_STORE });
  }
  const response = NextResponse.json({ data: { tokenType: "Bearer", accessExpiresAt: payload.data.accessExpiresAt } }, { status: upstream.status, headers: NO_STORE });
  applyTokenCookies(response, request, payload.data);
  return response;
}

export async function forwardAuthoringApi(
  request: NextRequest,
  path: string,
  method: "GET" | "POST" | "PUT",
  body?: BodyInit,
  contentType = "application/json; charset=utf-8",
): Promise<NextResponse> {
  let base: string | undefined;
  try { base = resolveApiBaseUrl(); } catch { base = undefined; }
  if (!base) {
    return NextResponse.json({ error: { code: "SERVICE_UNAVAILABLE", message: "The API service is not configured." } }, { status: 503, headers: NO_STORE });
  }

  const refreshToken = request.cookies.get(REFRESH_TOKEN_COOKIE)?.value;
  let accessToken = request.cookies.get(ACCESS_TOKEN_COOKIE)?.value;
  let rotated: TokenSet | null = null;
  let clearCookies = false;
  let upstream: Response;
  try {
    upstream = await callApi(base, path, method, body, accessToken, contentType, request.headers.get("idempotency-key"));
    if (upstream.status === 401 && refreshToken) {
      const refreshed = await callApi(base, "api/v1/auth/refresh", "POST", JSON.stringify({ refreshToken }));
      const refreshedPayload = await readPayload(refreshed);
      if (refreshed.ok && isTokenEnvelope(refreshedPayload)) {
        rotated = refreshedPayload.data;
        accessToken = rotated.accessToken;
        upstream = await callApi(base, path, method, body, accessToken, contentType, request.headers.get("idempotency-key"));
      } else if (refreshed.status === 400 || refreshed.status === 401) {
        clearCookies = true;
      }
    }
  } catch {
    return NextResponse.json({ error: { code: "SERVICE_UNAVAILABLE", message: "The API service could not be reached." } }, { status: 502, headers: NO_STORE });
  }

  const headers = new Headers(NO_STORE);
  headers.set("content-type", upstream.headers.get("content-type") ?? "application/json; charset=utf-8");
  const response = new NextResponse(await upstream.text(), { status: upstream.status, headers });
  if (rotated) applyTokenCookies(response, request, rotated);
  else if (clearCookies) clearTokenCookies(response, request);
  return response;
}
