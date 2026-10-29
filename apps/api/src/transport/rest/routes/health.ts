import type { RestRouteContext } from "./context.ts";
import { sendJson } from "../http.ts";

/** Liveness/readiness for the API itself (`health`). */
export async function handleHealthRoute(ctx: RestRouteContext): Promise<boolean> {
  const { response, routeId } = ctx;

    if (routeId === "health") {
      sendJson(response, 200, { status: "ok", service: "api", version: "0.1.0" });
      return true;
    }

  return false;
}
