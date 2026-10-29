# REST write idempotency inventory

- Status: implementation inventory for Issue #71; review against the current handler before adding a new mutation.
- Scope: `apps/api/src/transport/rest/handler.ts`, persistence contracts, and the public REST contract.
- Rule: never require a key for an operation that is already a repeat-safe state-setting operation. For non-idempotent creates, bind the digest to the verified actor, canonical method/route and request fingerprint. Store no raw key. Commit the deduplication record in the same transaction as domain state and outbox intent. Exact retries must replay the original sanitized status/body; a different fingerprint must return `409 IDEMPOTENCY_CONFLICT`.

## Operation inventory

| Operation | Current route | Classification | Current evidence / next action |
|---|---|---|---|
| Register account | `POST /api/v1/auth/register` | Non-idempotent create | Duplicate account may be rejected by uniqueness, but this is not replay semantics. Decide whether replay is needed without exposing account-existence signals. |
| Login | `POST /api/v1/auth/login` | Conditionally idempotent | Creates/rotates session material. A retry can issue another token family; audit session side effects and safe response replay separately. |
| Refresh session | `POST /api/v1/auth/refresh` | Non-idempotent security transition | Rotation/reuse detection is security-sensitive. Do not blindly replay old refresh tokens; preserve family-revocation semantics and define a dedicated retry contract. |
| Logout | `POST /api/v1/auth/logout` | Naturally repeat-safe if revocation is monotonic | Confirm repeated revocation response contract; no key required if already idempotent. |
| Create article | `POST /api/v1/articles` | Non-idempotent create | Add deduplication record in the same transaction as article + outbox events; replay sanitized 201 response. |
| Update article | `PUT /api/v1/articles/:articleId` | Conditionally idempotent | State replacement is naturally idempotent only if no repeated version/event side effects; audit persistence/outbox behavior before deciding. |
| Update profile | `PUT /api/v1/me/profile` | Conditionally idempotent | State-setting route; verify it does not emit duplicate side effects before exempting it. |
| Revoke current session | `DELETE /api/v1/me/session` | Naturally repeat-safe if revocation is monotonic | Confirm repeated delete response and session-family behavior. |
| Follow / unfollow | `POST/DELETE /api/v1/users/:userId/follow` | Conditionally idempotent | Relationship state should be repeat-safe; ensure duplicate requests do not create duplicate notifications/outbox events. |
| Set article like | `PUT /api/v1/articles/:slug/like` | Naturally idempotent state-setting | Request carries explicit `liked` state; do not require a key if repeated calls only converge on the same state. Verify notifications are transition-only. |
| Create comment | `POST /api/v1/articles/:slug/comments` | Non-idempotent create | Partial implementation in PR #79: hashed key + request fingerprint and concurrent deduplication. Remaining gaps: sanitized response replay, expiry/cleanup, and end-to-end atomicity/rollback coverage. |
| Delete comment | `DELETE /api/v1/comments/:commentId` | Naturally repeat-safe only if delete is monotonic | Confirm retry after deletion has stable contract and no repeated side effects. |
| Create tag / taxonomy | `POST /api/v1/tags`, `POST /api/v1/taxonomies` | Non-idempotent create | Audit duplicate conflict behavior and outbox side effects; add key-based replay if clients can retry after ambiguous outcomes. |
| Delete taxonomy | `DELETE /api/v1/taxonomies/:id` | Naturally repeat-safe only if delete is monotonic | Confirm not-found behavior on repeat and event emission. |
| Create conversation | `POST /api/v1/conversations` | Non-idempotent create | Add actor+route scoped key and replay conversation creation response. |
| Send message | `POST /api/v1/conversations/:id/messages` | Non-idempotent create | Existing persistence API has message-level idempotency. Verify REST requires/forwards the key and exact sanitized response semantics; ensure message + outbox intent are atomic. |
| Update participants | `PATCH /api/v1/conversations/:id/participants` | Conditionally idempotent | Inspect whether request is set replacement or additive/removal commands; repeated notifications must be suppressed. |
| Mark conversation read | `PUT /api/v1/conversations/:id/read` | Naturally idempotent state-setting | Confirm timestamp semantics do not create duplicate outbox events. |
| Mark notification read | `PUT /api/v1/me/notifications/:id/read` | Naturally idempotent state-setting | Confirm repeat-safe update and no repeated external side effects. |
| Mark all notifications read | `POST /api/v1/me/notifications/read-all` | Conditionally idempotent bulk state-setting | Though method is POST, semantics are state-setting; ensure repeat-safe count/side effects and do not demand a key unnecessarily. |
| Upload media | `POST /api/v1/me/media` | Non-idempotent create | Audit blob upload + metadata write; require a key or deterministic upload identity so retry cannot orphan/duplicate assets. |
| Other profile/session writes | `PUT /api/v1/me/profile`, `DELETE /api/v1/me/session` | See rows above | Do not classify based on HTTP method alone. |

## Required follow-up sequence

1. **Complete comment semantics (PR #79):** return the original sanitized response on exact retry, define bounded retention/expiry and cleanup, and test rollback plus same-key concurrency on SQLite and PostgreSQL.
2. **Conversation creation:** add REST-level key propagation and response replay around the existing persistence behavior; ensure participant/outbox writes are in the same transaction.
3. **Message sending:** reconcile the current store-level `idempotencyKey` / `request_hash` contract with the REST handler and proxy; test one message and one outbox intent under concurrent retries.
4. **Article and media creation:** implement one shared persistence primitive only after transaction boundaries and response payloads are understood; do not build a generic abstraction that cannot atomically cover outbox intent.
5. **Audit all remaining writes:** register/login/refresh/logout, article/profile replacement, follow/like, tag/taxonomy, delete, participant updates, and read-state operations. Preserve repeat-safe state-setting routes without imposing keys.
6. **Expiry and retention:** specify a configurable, documented retention window. Expired keys must not silently replay stale private response bodies; cleanup must be bounded and safe under both providers.
7. **Acceptance tests:** operation inventory reviewed; success replay; mismatch `409`; concurrent requests; expiry; transaction rollback; outbox count; sanitized response replay; SQLite and PostgreSQL adapter contract tests.

## Guardrails

- Never store raw `Idempotency-Key` values.
- Scope key digests to verified actor and canonical method/route; include the normalized request fingerprint.
- Do not return another actor's stored response.
- Persist idempotency and domain/outbox changes atomically.
- Do not wrap the entire REST handler in a broad rewrite as part of this issue.
- Keep Issue #71 open until the inventory and acceptance criteria are satisfied.
