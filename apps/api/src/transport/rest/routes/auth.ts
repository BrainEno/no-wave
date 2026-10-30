import type { RestRouteContext, RestRouteHandler } from "./context.ts";
import { readJsonObject, sendJson, sendJsonBodyError, sendServiceError, sendUnavailable } from "../http.ts";

/**
 * Action name to use case.
 *
 * The URL segment is kebab-case and the service method is camelCase; the table
 * keeps that translation in one place instead of in a stringly-typed lookup.
 */
const AUTH_ACTIONS: Readonly<Record<string, (identity: NonNullable<RestRouteContext["identity"]>, body: Record<string, unknown>, ip: string) => Promise<unknown>>> = Object.freeze({
  register: (identity, body, ip) => identity.register(body, ip),
  login: (identity, body, ip) => identity.login(body, ip),
  refresh: (identity, body, ip) => identity.refresh(body, ip),
  logout: (identity, body, ip) => identity.logout(body, ip),
  "forgot-password": (identity, body, ip) => identity.requestPasswordReset(body, ip),
  "reset-password": (identity, body, ip) => identity.resetPassword(body, ip),
  "verify-email": (identity, body, ip) => identity.verifyEmail(body, ip),
});

const AUTH_ACTION_STATUS: Readonly<Record<string, number>> = Object.freeze({
  register: 201,
  "forgot-password": 202,
});

/** Identity endpoints (`auth/*`). Runs before the write rate limiter so credential
 * attempts stay throttled by the identity service, not by the generic policy. */
const AUTH_ROUTE_HANDLERS: Readonly<Record<string, RestRouteHandler>> = Object.freeze({
  "auth": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, identity, routeParams } = ctx;
    if (!identity) { sendUnavailable(response); return; }
    const bodyResult = await readJsonObject(request, 4096);
    if (bodyResult.ok === false) { sendJsonBodyError(response, request, bodyResult); return; }
    try {
      // Never trust X-Forwarded-For supplied by the client. An operator must
      // enforce additional trusted-proxy/edge throttling when behind a proxy.
      const ip = request.socket.remoteAddress ?? "unknown";
      const action = String(routeParams.action ?? "");
      const run = AUTH_ACTIONS[action];
      if (!run) { sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The requested resource was not found." } }); return; }
      const data = await run(identity, bodyResult.value, ip);
      // 202 for "we accepted this and will act on it out of band": a recovery
      // request is never confirmed in the response, by design.
      sendJson(response, AUTH_ACTION_STATUS[action] ?? 200, { data });
    } catch (error: unknown) {
      sendServiceError(response, error);
    }
  },
});

export const AUTH_ROUTE_IDS: readonly string[] = Object.freeze(Object.keys(AUTH_ROUTE_HANDLERS));

export async function handleAuthRoutes(ctx: RestRouteContext): Promise<boolean> {
  const handler = AUTH_ROUTE_HANDLERS[ctx.routeId ?? ""];
  if (!handler) return false;
  await handler(ctx);
  return true;
}
