import { createHmac } from "node:crypto";
import { WriteRateLimitError } from "../domain/errors.ts";

export type RateLimitBucket = {
  key: string;
  limit: number;
  windowSeconds: number;
};
export type RateLimitStore = {
  consumeRateLimit(input: RateLimitBucket): Promise<{ allowed: boolean; resetAt: string }>;
  pruneExpiredIdentityState?: () => Promise<unknown>;
};
export type WriteRateLimitPolicy = {
  endpoint: string;
  windowSeconds: number;
  ipLimit: number;
  userLimit: number;
};

const DEFAULT_POLICY = Object.freeze({ windowSeconds: 60, ipLimit: 120, userLimit: 60 });
const POLICIES: Readonly<Record<string, Omit<WriteRateLimitPolicy, "endpoint">>> = Object.freeze({
  "article.create": { windowSeconds: 60 * 60, ipLimit: 30, userLimit: 10 },
  "article.update": { windowSeconds: 60 * 60, ipLimit: 60, userLimit: 20 },
  "comment.create": { windowSeconds: 60, ipLimit: 60, userLimit: 20 },
  "comment.delete": { windowSeconds: 60, ipLimit: 120, userLimit: 60 },
  "message.send": { windowSeconds: 60, ipLimit: 120, userLimit: 30 },
  "user.follow": { windowSeconds: 60, ipLimit: 120, userLimit: 60 },
  "user.unfollow": { windowSeconds: 60, ipLimit: 120, userLimit: 60 },
  "article.like.set": { windowSeconds: 60, ipLimit: 120, userLimit: 60 },
  "profile.update": { windowSeconds: 60 * 60, ipLimit: 60, userLimit: 20 },
  "taxonomy.create": { windowSeconds: 60, ipLimit: 60, userLimit: 30 },
  "taxonomy.delete": { windowSeconds: 60, ipLimit: 60, userLimit: 30 },
});

function endpointFor(method: string, pathname: string): string | null {
  if (method === "POST" && pathname === "/api/v1/articles") return "article.create";
  if (method === "PUT" && /^\/api\/v1\/articles\/[^/]+$/.test(pathname)) return "article.update";
  if (method === "PUT" && /^\/api\/v1\/me\/profile$/.test(pathname)) return "profile.update";
  if (method === "DELETE" && pathname === "/api/v1/me/session") return "session.revoke";
  if (method === "POST" && /^\/api\/v1\/users\/[^/]+\/follow$/.test(pathname)) return "user.follow";
  if (method === "DELETE" && /^\/api\/v1\/users\/[^/]+\/follow$/.test(pathname)) return "user.unfollow";
  if (method === "PUT" && /^\/api\/v1\/articles\/[^/]+\/like$/.test(pathname)) return "article.like.set";
  if (method === "POST" && /^\/api\/v1\/articles\/[^/]+\/comments$/.test(pathname)) return "comment.create";
  if (method === "DELETE" && /^\/api\/v1\/comments\/[^/]+$/.test(pathname)) return "comment.delete";
  if (method === "POST" && (pathname === "/api/v1/tags" || pathname === "/api/v1/taxonomies")) return "taxonomy.create";
  if (method === "DELETE" && /^\/api\/v1\/taxonomies\/[^/]+$/.test(pathname)) return "taxonomy.delete";
  if (method === "POST" && pathname === "/api/v1/conversations") return "conversation.create";
  if (method === "POST" && /^\/api\/v1\/conversations\/[^/]+\/messages$/.test(pathname)) return "message.send";
  if (method === "PATCH" && /^\/api\/v1\/conversations\/[^/]+\/participants$/.test(pathname)) return "conversation.participants.update";
  if (method === "DELETE" && /^\/api\/v1\/conversations\/[^/]+$/.test(pathname)) return "conversation.delete";
  if (method === "PUT" && /^\/api\/v1\/conversations\/[^/]+\/read$/.test(pathname)) return "conversation.read";
  if (method === "PUT" && /^\/api\/v1\/me\/notifications\/[^/]+\/read$/.test(pathname)) return "notification.read";
  if (method === "POST" && pathname === "/api/v1/me/notifications/read-all") return "notification.read-all";
  return null;
}

/**
 * Return a canonical route-level policy. Resource IDs/slugs never enter rate
 * limit keys, preventing attackers from evading limits or creating unbounded
 * buckets by varying path segments. Authentication endpoints keep their
 * existing dedicated, stricter policies in the identity use case.
 */
export function resolveWriteRateLimitPolicy(method: string, pathname: string): WriteRateLimitPolicy | null {
  const endpoint = endpointFor(method.toUpperCase(), pathname);
  if (!endpoint) return null;
  const policy = POLICIES[endpoint] ?? DEFAULT_POLICY;
  return { endpoint, ...policy };
}

function bucketKey(secret: string, endpoint: string, scope: "user" | "ip", subject: string): string {
  const namespace = createHmac("sha256", secret).update("bot-thk:write-rate-limit:v1").digest();
  return createHmac("sha256", namespace).update(JSON.stringify([endpoint, scope, subject])).digest("hex");
}

function retryAfterSeconds(resetAt: string, windowSeconds: number): number {
  const reset = new Date(resetAt).getTime();
  if (!Number.isFinite(reset)) throw new Error("Rate limiter returned an invalid reset time.");
  return Math.max(1, Math.ceil((reset - Date.now()) / 1000)) || windowSeconds;
}

export function createRateLimitService({ store, env }: { store: RateLimitStore; env: NodeJS.ProcessEnv }) {
  let rateOperations = 0;

  return Object.freeze({
    async checkWrite(input: {
      method: string;
      pathname: string;
      ip: string;
      actorId: string | null;
    }): Promise<void> {
      const policy = resolveWriteRateLimitPolicy(input.method, input.pathname);
      if (!policy) return;

      // All successful private writes already require a valid JWT configuration.
      // During a misconfigured startup, leave the existing authentication path
      // to fail closed with its established error instead of masking it here.
      const secret = env.AUTH_JWT_SECRET;
      if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) return;

      rateOperations += 1;
      if (rateOperations >= 128) {
        rateOperations = 0;
        if (typeof store.pruneExpiredIdentityState === "function") {
          await store.pruneExpiredIdentityState();
        }
      }

      // Charge the authenticated user's route bucket first. A blocked user
      // therefore cannot consume the shared IP allowance for other users.
      const buckets: RateLimitBucket[] = [];
      if (input.actorId) {
        buckets.push({
          key: bucketKey(secret, policy.endpoint, "user", input.actorId),
          limit: policy.userLimit,
          windowSeconds: policy.windowSeconds,
        });
      }
      buckets.push({
        key: bucketKey(secret, policy.endpoint, "ip", input.ip || "unknown"),
        limit: policy.ipLimit,
        windowSeconds: policy.windowSeconds,
      });

      for (const bucket of buckets) {
        const result = await store.consumeRateLimit(bucket);
        if (!result || typeof result.allowed !== "boolean" || typeof result.resetAt !== "string") {
          throw new Error("Rate limiter returned an invalid response.");
        }
        if (!result.allowed) {
          throw new WriteRateLimitError(retryAfterSeconds(result.resetAt, policy.windowSeconds));
        }
      }
    },
  });
}
