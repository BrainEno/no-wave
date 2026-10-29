import type { IncomingMessage, ServerResponse } from "node:http";
import type { createIdentityService } from "../../../application/identity.ts";
import type { createRateLimitService } from "../../../application/rate-limit.ts";
import type { MediaAssetsPort, RestServices } from "../http.ts";

/**
 * Everything a route group may touch, resolved once per request by
 * `createRestHandler`.
 *
 * The point of this object is structural: route groups are plain async functions
 * of one dependency bag, so they can be split across files, reordered behind an
 * explicit list, and unit-tested without a live HTTP server or a fake framework
 * request object.
 */
export type RestRouteContext = {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly url: URL;
  /** The matched route id, or `null` when no route matched and the request is a read. */
  readonly routeId: string | null;
  readonly routeParams: Readonly<Record<string, string>>;
  readonly services: RestServices | null;
  readonly env: NodeJS.ProcessEnv;
  readonly mediaAssets: MediaAssetsPort | null;
  readonly identity: ReturnType<typeof createIdentityService> | null;
  readonly writeRateLimiter: ReturnType<typeof createRateLimitService> | null;
};

/**
 * A route group owns a set of route ids. Returning `true` means it wrote a
 * response; `false` means "not mine", and dispatch continues with the next group.
 */
export type RestRouteGroup = (context: RestRouteContext) => Promise<boolean>;

/**
 * One route id's handler inside a group.
 *
 * Handlers are `Promise<void>`, not `Promise<boolean>`: a matched route always
 * writes exactly one response, so the boolean was pure noise (`return true` on
 * every exit path). The group owns the claim, the handler owns the response.
 */
export type RestRouteHandler = (context: RestRouteContext) => Promise<void>;
