# ADR 0011: Persistent API write rate limits

- Status: Accepted
- Date: 2026-10-28
- Related: ADR 0008 (self-hosted API identity), Issue #65

## Context

The identity endpoints already had durable throttling, but article, comment, follow, like, conversation, message, and notification write routes did not. Process-local counters are insufficient for multiple API instances and disappear on restart. A client-controlled forwarding header cannot be used as the IP identity because an attacker could rotate it.

## Decision

1. Expose a transport-neutral `consumeRateLimit` persistence operation shared by authentication and business writes. SQLite and PostgreSQL implement it atomically using the existing durable rate-limit counter table.
2. Enforce two route-specific dimensions: a verified, non-revoked user ID bucket when authentication is valid, and the TCP socket peer IP bucket for every write attempt. Check the user bucket first so a user already over quota does not consume the shared IP allowance. Client-supplied `X-Forwarded-For` is never trusted.
3. Use canonical operation names in buckets rather than resource identifiers, so changing a slug, article ID, or conversation ID cannot bypass a route policy or create unbounded path-specific buckets. HMAC the bucket key with the server-only JWT secret; never store the raw user ID or IP.
4. Return HTTP `429 RATE_LIMITED` with a positive `Retry-After` header. Do not return raw persistence errors or identifiers in the response. When rate-limit persistence fails, reject the write rather than silently accepting it.
5. Keep registration/login/refresh/logout on their existing stricter policies. Public read routes are not covered by this issue's write limiter. The limits are initial abuse-prevention defaults, not a claim that a complete community moderation/quota system exists.
6. Behind a reverse proxy, enforce additional edge throttling and preserve a trusted socket peer configuration. The application does not infer trusted proxy hops from unverified headers.

## Initial limits

| Operation | User bucket | IP bucket | Window |
| --- | ---: | ---: | --- |
| Create article | 10 | 30 | 1 hour |
| Update article | 20 | 60 | 1 hour |
| Update profile | 20 | 60 | 1 hour |
| Create comment | 20 | 60 | 1 minute |
| Send message | 30 | 120 | 1 minute |
| Follow/unfollow and article-like state | 60 | 120 | 1 minute |
| Create/delete taxonomy | 30 | 60 | 1 minute |
| Delete comment | 60 | 120 | 1 minute |
| Other conversation/session/notification writes | 60 | 120 | 1 minute |

## Validation

Unit tests assert canonical route policies, opaque bucket keys, route-specific limits, user-before-IP ordering, positive retry intervals, and no user bucket for anonymous calls. HTTP tests assert 429/Retry-After and verify that changing `X-Forwarded-For` does not change the source IP bucket. The complete CI suite must validate the same persistence contract on SQLite and PostgreSQL before merge.

## Follow-up boundary

Idempotency keys for write operations that do not currently accept them, per-new-account publishing cooldowns, abuse reports, moderation queues, role-based moderation, soft deletion, and appeals are separate follow-up work. This ADR does not imply those capabilities are implemented.
