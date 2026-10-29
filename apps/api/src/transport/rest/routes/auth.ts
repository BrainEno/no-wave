import type { RestRouteContext, RestRouteHandler } from "./context.ts";
import { readJsonObject, sendJson, sendJsonBodyError, sendServiceError, sendUnavailable } from "../http.ts";

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
      const action = routeParams.action as "register" | "login" | "refresh" | "logout";
      const data = await identity[action](bodyResult.value, ip);
      sendJson(response, action === "register" ? 201 : 200, { data });
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
