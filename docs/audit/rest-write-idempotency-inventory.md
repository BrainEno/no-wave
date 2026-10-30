# REST write idempotency inventory

- Status: implementation inventory for Issue #71; review against the current handler before adding a new mutation.
- Updated 2026-10-30: creates now carry keys (works, comments, conversations, messages). The normative contract — key
  format, digests, replay semantics, retention and what is deliberately deferred — lives in
  [docs/architecture/rest-idempotency.md](../architecture/rest-idempotency.md); this file remains the per-operation list.
- Scope: `apps/api/src/transport/rest/handler.ts`, persistence contracts, and the public REST contract.
- Rule: never require a key for an operation that is already a repeat-safe state-setting operation. For non-idempotent creates, bind the digest to the verified actor, canonical method/route and request fingerprint. Store no raw key. Commit the deduplication record in the same transaction as domain state and outbox intent. Exact retries must replay the original sanitized status/body; a different fingerprint must return `409 IDEMPOTENCY_CONFLICT`.

## Operation inventory

| Operation | Current route | Classification | Current evidence / next action |
|---|---|---|---|
| Register account | `POST /api/v1/auth/register` | Non-idempotent create | Duplicate account may be rejected by uniqueness, but this is not replay semantics. Decide whether replay is needed without exposing account-existence signals. |
| Login | `POST /api/v1/auth/login` | Conditionally idempotent | Creates/rotates session material. A retry can issue another token family; audit session side effects and safe response replay separately. |
| Refresh session | `POST /api/v1/auth/refresh` | Non-idempotent security transition | Rotation/reuse detection is security-sensitive. Do not blindly replay old refresh tokens; preserve family-revocation semantics and define a dedicated retry contract. |
| Logout | `POST /api/v1/auth/logout` | Naturally repeat-safe if revocation is monotonic | Confirm repeated revocation response contract; no key required if already idempotent. |
| Create article | `POST /api/v1/articles` | Non-idempotent create | **Done, key optional.** Hashed key + fingerprint on `articles` (migrations `0019` / sqlite `0011`), replay returns the work itself. Optional because the desk does not mint keys yet; make it required once it does. |
| Update article | `PUT /api/v1/articles/:articleId` | Conditionally idempotent | State replacement is naturally idempotent only if no repeated version/event side effects; audit persistence/outbox behavior before deciding. |
| Update profile | `PUT /api/v1/me/profile` | Conditionally idempotent | State-setting route; verify it does not emit duplicate side effects before exempting it. |
| Revoke current session | `DELETE /api/v1/me/session` | Naturally repeat-safe if revocation is monotonic | Confirm repeated delete response and session-family behavior. |
| Follow / unfollow | `POST/DELETE /api/v1/users/:userId/follow` | Conditionally idempotent | Relationship state should be repeat-safe; ensure duplicate requests do not create duplicate notifications/outbox events. |
| Set article like | `PUT /api/v1/articles/:slug/like` | Naturally idempotent state-setting | Request carries explicit `liked` state; do not require a key if repeated calls only converge on the same state. Verify notifications are transition-only. |
| Create comment | `POST /api/v1/articles/:slug/comments` | Non-idempotent create | **Done, key optional.** Hashed key + fingerprint on `article_comments` (migrations `0016` / sqlite `0008`), replay is transactional and concurrent-safe on both adapters. Remaining gap: bounded retention window (shared with every other key). |
| Delete comment | `DELETE /api/v1/comments/:commentId` | Naturally repeat-safe only if delete is monotonic | Confirm retry after deletion has stable contract and no repeated side effects. |
| Create tag / taxonomy | `POST /api/v1/tags`, `POST /api/v1/taxonomies` | Non-idempotent create | **Next.** Both reject a duplicate name/slug with `409` today and both are operator-facing; bring them under the same contract before any new create is added. |
| Delete taxonomy | `DELETE /api/v1/taxonomies/:id` | Naturally repeat-safe only if delete is monotonic | Confirm not-found behavior on repeat and event emission. |
| Create conversation | `POST /api/v1/conversations` | Non-idempotent create | **Done, key required.** Hashed key + fingerprint on `conversations` (migrations `0018` / sqlite `0010`); a retry reopens the conversation the first attempt made and its participants/outbox intent are written in one transaction. |
| Send message | `POST /api/v1/conversations/:id/messages` | Non-idempotent create | **Done, key required.** REST validates the header (1–300 trimmed) and forwards it to the store, which deduplicates on `(sender_id, idempotency_key)` with a request fingerprint; message, notification and outbox intent are one transaction. |
| Update participants | `PATCH /api/v1/conversations/:id/participants` | Conditionally idempotent | Inspect whether request is set replacement or additive/removal commands; repeated notifications must be suppressed. |
| Mark conversation read | `PUT /api/v1/conversations/:id/read` | Naturally idempotent state-setting | Confirm timestamp semantics do not create duplicate outbox events. |
| Mark notification read | `PUT /api/v1/me/notifications/:id/read` | Naturally idempotent state-setting | Confirm repeat-safe update and no repeated external side effects. |
| Mark all notifications read | `POST /api/v1/me/notifications/read-all` | Conditionally idempotent bulk state-setting | Though method is POST, semantics are state-setting; ensure repeat-safe count/side effects and do not demand a key unnecessarily. |
| Upload media | `POST /api/v1/me/media` | Non-idempotent create | **Deferred, on purpose.** Bytes are already content-addressed by SHA-256; whether a reused key replaces or conflicts, and who owns an asset several works reference, is a product decision — see the contract document. |
| Other profile/session writes | `PUT /api/v1/me/profile`, `DELETE /api/v1/me/session` | See rows above | Do not classify based on HTTP method alone. |

## Required follow-up sequence

1. ~~Complete comment semantics~~ done (transactional replay, concurrency covered on both adapters).
2. ~~Conversation creation~~ done (key required, replayed in one transaction).
3. ~~Message sending~~ done (REST requires and forwards the key; message + outbox are atomic).
4. ~~Article creation~~ done (key optional, replayed; make it required once the desk mints keys).
5. **Bounded retention:** the digests live in the row they created and die with it, so a key stays
   replayable as long as that row does. Decide the window and the purge (which needs a scheduler
   this API does not run), and document it in the contract.
6. **Tag and taxonomy creation:** the remaining non-idempotent creates that are not deferred by
   design.
7. **Audit the remaining convergent writes** (profile replacement, follow/like, participant
   updates, read-state, deletes): confirm each converges without duplicate notifications or outbox
   events rather than reaching for a key. Preserve repeat-safe state-setting routes without keys.
8. **Media, register/login/refresh:** deferred by design, reasons in the contract document.

## Guardrails
## Guardrails

- Never store raw `Idempotency-Key` values.
- Scope key digests to verified actor and canonical method/route; include the normalized request fingerprint.
- Do not return another actor's stored response.
- Persist idempotency and domain/outbox changes atomically.
- Do not wrap the entire REST handler in a broad rewrite as part of this issue.
- Keep Issue #71 open until the inventory and acceptance criteria are satisfied.
