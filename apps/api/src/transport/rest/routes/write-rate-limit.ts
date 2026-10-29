import type { RestRouteContext } from "./context.ts";
import { optionalViewerId, sendServiceError } from "../http.ts";
import { resolveWriteRateLimitPolicy } from "../../../application/rate-limit.ts";

/** The generic write rate-limit middleware, dispatched as a group so a throttled
 * write is rejected before any route body reads a body or touches persistence. */
export async function enforceWriteRateLimit(ctx: RestRouteContext): Promise<boolean> {
  const { request, response, url, services, env, writeRateLimiter } = ctx;

    const writePolicy = resolveWriteRateLimitPolicy(request.method ?? "GET", url.pathname);

    if (writePolicy && writeRateLimiter && services) {
      try {
        const actorId = await optionalViewerId(request, services, env);
        // Use only the TCP peer address. X-Forwarded-For is untrusted unless a
        // separately configured trusted proxy has already enforced this policy.
        await writeRateLimiter.checkWrite({
          method: request.method ?? "GET",
          pathname: url.pathname,
          ip: request.socket.remoteAddress ?? "unknown",
          actorId,
        });
      } catch (error: unknown) {
        sendServiceError(response, error);
        return true;
      }
    }

  return false;
}
