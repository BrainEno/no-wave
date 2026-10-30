import type { IncomingMessage, ServerResponse } from "node:http";
import { createIdentityService } from "../../application/identity.ts";
import { createRateLimitService, type RateLimitBucket, type RateLimitStore } from "../../application/rate-limit.ts";
import { resolveRestRoute } from "./routes.ts";
import { REST_ROUTE_GROUPS } from "./routes/index.ts";
import type { RestRouteContext } from "./routes/context.ts";
import { hasDuplicateQueryParameters, NO_ROUTE_PARAMS, sendBadInput, sendJson, type MediaAssetsPort, type RestServices } from "./http.ts";

/**
 * The REST entry point.
 *
 * This file owns only the request-level concerns that must run exactly once,
 * before any route body: the `/api/v1` prefix check, repeated query parameters,
 * route resolution (including the derived 405 allow-list) and assembly of the
 * per-request {@link RestRouteContext}. Everything else lives in `./routes/*.ts`
 * behind the ordered `REST_ROUTE_GROUPS` list (issue #58).
 */
export function createRestHandler({ services, env = process.env, mediaAssets = null, onMailDelivery = null }: { services: RestServices | null; env?: NodeJS.ProcessEnv; mediaAssets?: MediaAssetsPort | null; onMailDelivery?: ((sample: { purpose: string; outcome: string; durationMs: number; code?: string; message?: string }) => void) | null }) {
  // The facade is assembled dynamically from the validated persistence ports.
  // `ApplicationServices` already carries the identity store methods
  // (`createIdentityAccount`, `findIdentityAccount`, ...), so no assertion is
  // needed to reach them (issue #66).
  const identity = services ? createIdentityService({ store: services, env, onMailDelivery }) : null;
  const rateLimitStore: RateLimitStore | null = services && typeof services.consumeRateLimit === "function"
    ? {
        consumeRateLimit: (input: RateLimitBucket) => services.consumeRateLimit!(input),
        pruneExpiredIdentityState: typeof services.pruneExpiredIdentityState === "function"
          ? () => services.pruneExpiredIdentityState!()
          : undefined,
      }
    : null;
  const writeRateLimiter = rateLimitStore ? createRateLimitService({ store: rateLimitStore, env }) : null;

  return async function handleRest(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/v1" && !url.pathname.startsWith("/api/v1/")) return false;

    // Every current REST query parameter is scalar. Reject duplicates rather
    // than silently accepting URLSearchParams' first-value interpretation.
    // Close the connection because a rejected write request may still have an unread body.
    if (hasDuplicateQueryParameters(url.searchParams)) {
      request.pause();
      response.shouldKeepAlive = false;
      response.setHeader("connection", "close");
      sendBadInput(response, "Query parameters must not be repeated.");
      return true;
    }

    // One parse per request. The route table owns every path, the methods each one
    // accepts, and therefore the 405 allow-list; nothing below re-derives them.
    const route = resolveRestRoute(url.pathname, request.method ?? "GET");
    if (route.kind === "method_not_allowed") {
      response.setHeader("allow", route.allow);
      sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "The HTTP method is not supported for this endpoint." } });
      return true;
    }

    const context: RestRouteContext = Object.freeze({
      request,
      response,
      url,
      routeId: route.kind === "matched" ? route.id : null,
      routeParams: route.kind === "matched" ? route.params : NO_ROUTE_PARAMS,
      services,
      env,
      mediaAssets,
      identity,
      writeRateLimiter,
    });

    for (const group of REST_ROUTE_GROUPS) {
      if (await group(context)) return true;
    }

    sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The API route was not found." } });
    return true;
  };
}
