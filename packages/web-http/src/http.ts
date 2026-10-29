/**
 * Response primitives shared by every framework-neutral handler.
 *
 * These are plain `Response` objects on purpose: the Next.js route handlers, the
 * React Router resource routes and the contract tests all consume the same
 * objects, so no framework request/response type can leak into the policy code.
 */

/** Every proxied auth/authoring response is private by construction. */
export const NO_STORE = "no-store, max-age=0";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Build a JSON response.
 *
 * `set-cookie` values are **appended**, never joined: a combined header value is
 * one malformed cookie that browsers discard, which silently turns a successful
 * sign-in into a signed-out session.
 */
export function jsonResponse(body: unknown, status: number, cookies: readonly string[] = []): Response {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": NO_STORE },
  });
  for (const cookie of cookies) response.headers.append("set-cookie", cookie);
  return response;
}

export function errorResponse(code: string, message: string, status: number, cookies: readonly string[] = []): Response {
  return jsonResponse({ error: { code, message } }, status, cookies);
}

/**
 * Sanitize an upstream error body so internal details cannot reach the browser.
 *
 * Client errors (4xx) pass through only a well-formed `code` and a short
 * `message`, because those are user-facing by contract. Server errors never
 * relay upstream text at all: a 5xx body is an internal detail by definition
 * (`DATABASE_URL`, a stack frame, a driver error), so it is replaced wholesale.
 */
export function safeApiError(value: unknown, status: number): { error: { code: string; message: string } } {
  const fallbackCode = status >= 500 ? "SERVICE_UNAVAILABLE" : "AUTHENTICATION_FAILED";
  const fallbackMessage = status >= 500
    ? "The authentication service is temporarily unavailable."
    : "The authentication request was rejected.";
  if (status >= 500) return { error: { code: fallbackCode, message: fallbackMessage } };
  if (!isRecord(value) || !isRecord(value.error)) return { error: { code: fallbackCode, message: fallbackMessage } };
  const code = typeof value.error.code === "string" && /^[A-Z0-9_]{1,80}$/.test(value.error.code)
    ? value.error.code
    : fallbackCode;
  const message = typeof value.error.message === "string" && value.error.message.length <= 240
    ? value.error.message
    : fallbackMessage;
  return { error: { code, message } };
}
