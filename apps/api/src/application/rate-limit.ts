import { createHmac } from "node:crypto";
import { WriteRateLimitError } from "../domain/errors.ts";
import { runReportedTask, type BackgroundFailureReporter } from "./background-tasks.ts";

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

/**
 * One entry per mutating route, keyed by `<METHOD> <route id>`.
 *
 * The key is the route table's identity, not a path. That matters twice:
 *
 * - a renamed path keeps its bucket, so renaming a route cannot silently stop
 *   throttling it (the previous resolution was a hand-written list of path
 *   regexes — a second route table nothing could keep honest);
 * - there is no default entry. An unknown route does not fall back to "some
 *   limits": `assertWriteRateLimitsCoverRoutes` refuses to boot, and
 *   `resolveWriteRateLimitPolicy` answers `null` for anything it does not name.
 *
 * `endpoint` is the canonical operation name the HMAC bucket keys are derived
 * from (ADR 0011 §3). Two routes that are one operation on the product level —
 * `POST tags` and `POST taxonomies` — deliberately share it, and the two methods
 * of one route (`PUT` vs `DELETE` on an article) deliberately do not.
 */
const POLICIES: Readonly<Record<string, WriteRateLimitPolicy>> = Object.freeze({
  "POST articles": { endpoint: "article.create", windowSeconds: 3600, ipLimit: 30, userLimit: 10 },
  "PUT articles.item": { endpoint: "article.update", windowSeconds: 3600, ipLimit: 60, userLimit: 20 },
  // Deleting a work is the most expensive write in the API: it also writes one
  // notification per commenter (bounded, but real work), so it is throttled like
  // a creation rather than like a click.
  "DELETE articles.item": { endpoint: "article.delete", windowSeconds: 60, ipLimit: 60, userLimit: 20 },
  "POST articles.restore": { endpoint: "article.restore", windowSeconds: 60, ipLimit: 60, userLimit: 20 },
  "PUT articles.like": { endpoint: "article.like.set", windowSeconds: 60, ipLimit: 120, userLimit: 60 },
  // A view beacon: the dedupe key already limits one hit per reader per day, and
  // this is what stops a caller who does not bother inventing new readers.
  "POST articles.views": { endpoint: "article.view", windowSeconds: 60, ipLimit: 120, userLimit: 60 },
  "POST articles.comments": { endpoint: "comment.create", windowSeconds: 60, ipLimit: 60, userLimit: 20 },
  // An edit writes one row and sends no notification, so it is throttled like the
  // delete next to it rather than like a creation.
  "PATCH comments.item": { endpoint: "comment.update", windowSeconds: 60, ipLimit: 120, userLimit: 60 },
  "DELETE comments.item": { endpoint: "comment.delete", windowSeconds: 60, ipLimit: 120, userLimit: 60 },
  "POST me.media": { endpoint: "media.upload", windowSeconds: 3600, ipLimit: 20, userLimit: 10 },
  // Every media (row) delete is guarded by a reference check; since #217 that
  // check can also scan bodies, so it costs more than the row it removes.
  "DELETE me.media.item": { endpoint: "media.delete", windowSeconds: 60, ipLimit: 60, userLimit: 20 },
  "PUT me.profile": { endpoint: "profile.update", windowSeconds: 3600, ipLimit: 60, userLimit: 20 },
  // Editorial writes: few callers, whole-site consequences.
  "PUT featured": { endpoint: "featured.set", windowSeconds: 60, ipLimit: 30, userLimit: 10 },
  "PUT users.role": { endpoint: "user.role.set", windowSeconds: 60, ipLimit: 30, userLimit: 10 },
  "POST users.follow": { endpoint: "user.follow", windowSeconds: 60, ipLimit: 120, userLimit: 60 },
  "DELETE users.follow": { endpoint: "user.unfollow", windowSeconds: 60, ipLimit: 120, userLimit: 60 },
  "POST tags": { endpoint: "taxonomy.create", windowSeconds: 60, ipLimit: 60, userLimit: 30 },
  "POST taxonomies": { endpoint: "taxonomy.create", windowSeconds: 60, ipLimit: 60, userLimit: 30 },
  "DELETE taxonomies.item": { endpoint: "taxonomy.delete", windowSeconds: 60, ipLimit: 60, userLimit: 30 },
  "POST conversations": { endpoint: "conversation.create", windowSeconds: 60, ipLimit: 120, userLimit: 60 },
  "POST conversations.messages": { endpoint: "message.send", windowSeconds: 60, ipLimit: 120, userLimit: 30 },
  "PATCH conversations.participants": { endpoint: "conversation.participants.update", windowSeconds: 60, ipLimit: 120, userLimit: 60 },
  "PUT conversations.read": { endpoint: "conversation.read", windowSeconds: 60, ipLimit: 120, userLimit: 60 },
  "DELETE conversations.item": { endpoint: "conversation.delete", windowSeconds: 60, ipLimit: 120, userLimit: 60 },
  "DELETE me.session": { endpoint: "session.revoke", windowSeconds: 60, ipLimit: 120, userLimit: 60 },
  "PUT me.notifications.read": { endpoint: "notification.read", windowSeconds: 60, ipLimit: 120, userLimit: 60 },
  "POST me.notifications.read-all": { endpoint: "notification.read-all", windowSeconds: 60, ipLimit: 120, userLimit: 60 },
});

/** Methods that can change state, and therefore need a policy or an exemption. */
const WRITE_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Write routes the generic limiter deliberately does not cover.
 *
 * These are throttled by the identity service instead, which runs *before* this
 * one and keeps its own durable per-account and per-address buckets. They are
 * named here — by route id, like the policy table — so
 * `assertWriteRateLimitsCoverRoutes` can tell "handled elsewhere" from
 * "forgotten". Without the list those two states look identical: neither has a
 * generic policy.
 */
export const IDENTITY_THROTTLED_ROUTE_IDS: readonly string[] = Object.freeze([
  "auth",
  "me.password",
  "me.email",
  "me.email-verification",
  "me.sessions",
  "me.sessions.item",
]);

/** The table key for one route and method. */
function writeRateLimitPolicyKey(method: string, routeId: string): string {
  return `${method.toUpperCase()} ${routeId}`;
}

/**
 * The policy for a request the transport already matched.
 *
 * `routeId` is the matched route's id (`null` when nothing matched), so resource
 * ids and slugs are never part of the lookup and can never become part of a
 * bucket key. An unknown route answers `null`: unthrottled by *this* limiter,
 * never silently throttled by some default. Every such case has to be listed in
 * `IDENTITY_THROTTLED_ROUTE_IDS` or given a policy — the boot check below and its
 * test are what make that a requirement rather than a hope.
 */
export function resolveWriteRateLimitPolicy(method: string, routeId: string | null): WriteRateLimitPolicy | null {
  if (typeof routeId !== "string" || routeId.length === 0) return null;
  return POLICIES[writeRateLimitPolicyKey(method, routeId)] ?? null;
}

type RateLimitedRoute = { id: string; methods: readonly string[] };

/**
 * Refuse to start when the policy table and the route table disagree.
 *
 * This is the structural half of the fix: the old resolver was a second,
 * hand-written route list, and nothing could tell "throttled elsewhere" from
 * "forgotten" — five write routes had shipped unthrottled before a test noticed.
 * Called by the transport (which owns the route table) at module load, so a route
 * added, renamed or deleted without its policy fails at boot instead of going
 * quietly unthrottled. The unit test calls it too, so a failure is reported as a
 * readable assertion rather than an import-time stack.
 */
export function assertWriteRateLimitsCoverRoutes(routes: readonly RateLimitedRoute[]): void {
  const mutating = new Map<string, string>();
  for (const route of routes) {
    for (const method of route.methods) {
      if (WRITE_METHODS.has(method)) mutating.set(writeRateLimitPolicyKey(method, route.id), route.id);
    }
  }

  const problems: string[] = [];
  for (const [key, routeId] of mutating) {
    if (key in POLICIES) {
      if (IDENTITY_THROTTLED_ROUTE_IDS.includes(routeId)) {
        problems.push(`${key} has a generic policy but is also throttled by the identity service`);
      }
      continue;
    }
    if (IDENTITY_THROTTLED_ROUTE_IDS.includes(routeId)) continue;
    problems.push(`${key} has no policy and no identity-service exemption`);
  }
  for (const key of Object.keys(POLICIES)) {
    if (!mutating.has(key)) problems.push(`${key} has a policy but is not a mutating route`);
  }
  for (const routeId of IDENTITY_THROTTLED_ROUTE_IDS) {
    const anyMutating = [...mutating.values()].some((id) => id === routeId);
    if (!anyMutating) problems.push(`${routeId} is exempt from the generic limiter but is not a mutating route`);
  }

  if (problems.length > 0) {
    throw new Error(`The write rate-limit table does not match the route table: ${problems.join("; ")}.`);
  }
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

export function createRateLimitService({ store, env, onBackgroundFailure = null }: {
  store: RateLimitStore;
  env: NodeJS.ProcessEnv;
  /** Where a failed expired-state prune goes (audit F-22). */
  onBackgroundFailure?: BackgroundFailureReporter;
}) {
  let rateOperations = 0;

  return Object.freeze({
    /**
     * Charge the buckets for one already-matched write.
     *
     * The caller resolves the policy from the route id, so this function never
     * re-derives an operation name from a path — a second opinion about what a
     * request is, which is how the two lists drifted apart in the first place.
     */
    async checkWrite(input: {
      policy: WriteRateLimitPolicy;
      ip: string;
      actorId: string | null;
    }): Promise<void> {
      const policy = input.policy;

      // All successful private writes already require a valid JWT configuration.
      // During a misconfigured startup, leave the existing authentication path
      // to fail closed with its established error instead of masking it here.
      const secret = env.AUTH_JWT_SECRET;
      if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) return;

      // Opportunistic expired-state cleanup, every 128 checks. It is a supplement
      // to the scheduled `runMaintenance`, not the trigger: an instance with no
      // writes never reaches this line.
      rateOperations += 1;
      if (rateOperations >= 128) {
        rateOperations = 0;
        if (typeof store.pruneExpiredIdentityState === "function") {
          // Reported and swallowed. This used to be awaited bare, so a failed
          // prune answered the *user's write* with a 500 — a maintenance problem
          // charged to whoever happened to be writing at the time.
          await runReportedTask({
            task: "identity-prune",
            report: onBackgroundFailure,
            work: () => store.pruneExpiredIdentityState!(),
          });
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
