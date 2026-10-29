import type { RestRouteContext } from "./context.ts";
import { readJsonObject, sendJson, sendJsonBodyError, sendServiceError, sendUnavailable } from "../http.ts";

/** Identity endpoints (`auth/*`). Runs before the write rate limiter so credential
 * attempts stay throttled by the identity service, not by the generic policy. */
export async function handleAuthRoutes(ctx: RestRouteContext): Promise<boolean> {
  const { request, response, identity, routeParams, routeId } = ctx;

    if (routeId === "auth") {
      if (!identity) { sendUnavailable(response); return true; }
      const bodyResult = await readJsonObject(request, 4096);
      if (bodyResult.ok === false) { sendJsonBodyError(response, request, bodyResult); return true; }
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
      return true;
    }

  return false;
}
