import type { RestRouteContext, RestRouteHandler } from "./context.ts";
import { sendJson } from "../http.ts";
import { OPENAPI_DOCUMENT } from "../openapi/index.ts";

/**
 * The contract endpoint (`openapi`).
 *
 * Served, not shipped: a client that can reach the API can read the contract for
 * exactly the version it is talking to, instead of trusting a file from a release
 * page. The document is built once at import — it is a pure function of the route
 * table — so answering is a JSON write and nothing else.
 *
 * Public on purpose. It contains no data, only the shape of the API, and requiring
 * a session to read the shape of the API would make the endpoint useless to the
 * people who need it first.
 */
const OPENAPI_ROUTE_HANDLERS: Readonly<Record<string, RestRouteHandler>> = Object.freeze({
  "openapi": async (ctx: RestRouteContext): Promise<void> => {
    sendJson(ctx.response, 200, OPENAPI_DOCUMENT);
  },
});

export const OPENAPI_ROUTE_IDS: readonly string[] = Object.freeze(Object.keys(OPENAPI_ROUTE_HANDLERS));

export async function handleOpenApiRoute(ctx: RestRouteContext): Promise<boolean> {
  const handler = OPENAPI_ROUTE_HANDLERS[ctx.routeId ?? ""];
  if (!handler) return false;
  await handler(ctx);
  return true;
}
