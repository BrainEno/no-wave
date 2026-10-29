import { NextResponse, type NextRequest } from "next/server";
import {
  forwardAuthoringRequest,
  handleAuthRequest,
  readLimitedJson,
  type ForwardMethod,
} from "@bot-thk/web-http";
import { resolveApiBaseUrl } from "./api-content.ts";

/**
 * Next.js adapter for the framework-neutral HTTP seam (`@bot-thk/web-http`).
 *
 * Phase 2 of ADR 0012 moved the behavior — cookie policy, exact-Origin check,
 * bounded bodies, token refresh/retry, error sanitization — into the shared
 * package, and this file became the only Next-specific part: it resolves the API
 * origin (including the transitional Vercel `API_SERVICE_URL` binding) and
 * converts a standard `Response` back into a `NextResponse`.
 *
 * Nothing here should grow behavior. If a rule belongs to the proxy, it belongs
 * in the package, where the React Router resource routes and the contract tests
 * can reach it too.
 */

function apiConfig(): { apiBaseUrl: string | undefined } {
  try {
    // `resolveApiBaseUrl` validates the value and prefers the explicit
    // `API_BASE_URL`; a malformed value is treated as "not configured" so the
    // route answers 503 instead of throwing a framework 500.
    return { apiBaseUrl: resolveApiBaseUrl() };
  } catch {
    return { apiBaseUrl: undefined };
  }
}

function toNextResponse(response: Response): NextResponse {
  const body = response.status === 204 || response.status === 304 ? null : response.body;
  const next = new NextResponse(body, { status: response.status });
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") next.headers.set(name, value);
  });
  for (const cookie of response.headers.getSetCookie()) next.headers.append("set-cookie", cookie);
  return next;
}

const FORWARD_METHODS = new Set<ForwardMethod>(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function forwardMethod(method: string): ForwardMethod {
  return FORWARD_METHODS.has(method as ForwardMethod) ? (method as ForwardMethod) : "GET";
}

export async function handleAuthPost(
  request: NextRequest,
  action: "login" | "register" | "refresh" | "logout",
): Promise<NextResponse> {
  return toNextResponse(await handleAuthRequest(request, action, apiConfig()));
}

export async function forwardAuthoringApi(
  request: NextRequest,
  path: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  body?: BodyInit,
  contentType = "application/json; charset=utf-8",
): Promise<NextResponse> {
  return toNextResponse(
    await forwardAuthoringRequest(request, path, forwardMethod(method), apiConfig(), body, contentType),
  );
}

export type LimitedJsonObjectResult =
  | { ok: true; text: string }
  | { ok: false; response: NextResponse };

/**
 * Bound a JSON request body before proxying it. Kept as a Next-flavored wrapper
 * because every route handler returns `NextResponse` on the failure path.
 */
export async function readLimitedJsonObject(
  request: NextRequest,
  maximumBytes = 2_000_000,
): Promise<LimitedJsonObjectResult> {
  // `NextRequest` extends the standard `Request`, so it can be passed straight
  // through; only the failure response needs converting.
  const result = await readLimitedJson(request, maximumBytes);
  if (!result.ok) return { ok: false, response: toNextResponse(result.response) };
  return { ok: true, text: result.text };
}
