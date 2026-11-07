import type { RestRouteContext } from "./context.ts";
import { optionalViewerId, sendServiceError } from "../http.ts";
import { resolveWriteRateLimitPolicy } from "../../../application/rate-limit.ts";

/** The generic write rate-limit middleware, dispatched as a group so a throttled
 * write is rejected before any route body reads a body or touches persistence. */
export async function enforceWriteRateLimit(ctx: RestRouteContext): Promise<boolean> {
  const { request, response, services, env, writeRateLimiter, routeId } = ctx;

    // Resolved from the matched route id, never from the path: the policy table
    // is keyed by the route table's own identity, so a renamed path cannot stop
    // being throttled and no resource id can enter a bucket key.
    const writePolicy = resolveWriteRateLimitPolicy(request.method ?? "GET", routeId);

    if (writePolicy && writeRateLimiter && services) {
      try {
        const actorId = await optionalViewerId(request, services, env);
        // Use only the TCP peer address. X-Forwarded-For is untrusted unless a
        // separately configured trusted proxy has already enforced this policy.
        await writeRateLimiter.checkWrite({
          policy: writePolicy,
          ip: ctx.clientAddress,
          actorId,
        });
      } catch (error: unknown) {
        sendServiceError(response, error);
        return true;
      }
    }

  return false;
}
