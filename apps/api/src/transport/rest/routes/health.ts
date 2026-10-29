import type { RestRouteContext, RestRouteHandler } from "./context.ts";
import { sendJson } from "../http.ts";

/** Liveness/readiness for the API itself (`health`). */
const HEALTH_ROUTE_HANDLERS: Readonly<Record<string, RestRouteHandler>> = Object.freeze({
  "health": async (ctx: RestRouteContext): Promise<void> => {
    const { response } = ctx;
    sendJson(response, 200, { status: "ok", service: "api", version: "0.1.0" });
  },
});

export const HEALTH_ROUTE_IDS: readonly string[] = Object.freeze(Object.keys(HEALTH_ROUTE_HANDLERS));

export async function handleHealthRoute(ctx: RestRouteContext): Promise<boolean> {
  const handler = HEALTH_ROUTE_HANDLERS[ctx.routeId ?? ""];
  if (!handler) return false;
  await handler(ctx);
  return true;
}
