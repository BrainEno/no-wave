# REST write idempotency contract

- Status: normative contract for the public REST API. Written against `main` after the slice that
  added create-time idempotency for works and conversations (issue #71).
- Scope: every state-changing route under `/api/v1`, both persistence adapters.
- Related: [the operation inventory](../audit/rest-write-idempotency-inventory.md) lists each
  mutation with its classification; this document defines the rules the classification refers to.

## Why this exists

A client cannot tell the difference between "the request never arrived" and "the request arrived
and the response was lost". On a flaky mobile connection the user presses send twice, and the
question is whether the system now holds one message or two. For a conversation or a published
work the second copy is not a harmless duplicate: the older conversation quietly stops being the
one anybody answers, and a duplicated work is a public-facing mistake the author has to clean up.

So the contract is not "be idempotent everywhere". It is: **each write states which class it is in,
and a write that creates something new must be able to recognise its own retry.**

## The request contract

| | |
|---|---|
| Header | `Idempotency-Key: <opaque client string>` |
| Accepted values | 1–300 characters, no leading/trailing whitespace |
| Malformed or missing where required | `400` with `error.code = "BAD_USER_INPUT"` |
| Reused with a *different* request body | `409` with `error.code = "IDEMPOTENCY_CONFLICT"` |
| Reused with the *same* request body | the recorded outcome is replayed, not a second write |

A key is **required** where a retry would create a duplicate the user cannot easily undo, and
**optional** where an existing client would break if we started demanding one. The table below is
the authority on which is which; adding a new create means adding a row to it.

## What the server stores

Only digests, never the key itself — clients put e-mail addresses and internal identifiers in this
header, and the database has no reason to hold them.

```
key digest     = sha256(canonical method + route + verified actor id + raw key)
fingerprint    = sha256(normalized request body, arrays sorted)
```

- Both digests live in the row the write creates (`articles`, `article_comments`, `conversations`,
  `messages`), in the same transaction as the domain state and its outbox/provider-migration
  intent. A rolled-back transaction leaves no deduplication record behind.
- The unique index is `(actor, key digest)` and is partial (`WHERE idempotency_key_hash IS NOT
  NULL`), so rows written without a key never collide with each other.
- The digest is scoped to the verified actor, never to the body's claimed identity: two users may
  reuse the same key string and each get their own row.
- Concurrent duplicates: one writer inserts, the others block on the unique index and then read
  back what the winner committed (`ON CONFLICT … DO NOTHING` on PostgreSQL, `BEGIN IMMEDIATE` on
  SQLite). Two rows are never created.

## Replay semantics

An exact retry returns the same resource the first attempt created. It is deliberately **not** a
frozen copy of the first response: the replay re-reads the row, so a conversation that gained a
participant since answers with its current participants. Replaying stale bytes would be a lie
about state the client can already see.

A key reused with a different body is a client bug, not a replay — hence `409` rather than a
silently wrong answer.

## Operation table

| Operation | Class | Key | State |
|---|---|---|---|
| `POST /api/v1/conversations` | non-idempotent create | **required** | implemented — `conversations.idempotency_key_hash` (migrations `0018` / sqlite `0010`) |
| `POST /api/v1/conversations/:id/messages` | non-idempotent create | **required** | implemented — `messages.idempotency_key` + `request_hash`, unique per sender |
| `POST /api/v1/articles` | non-idempotent create | optional | implemented — `articles.idempotency_key_hash` (migrations `0019` / sqlite `0011`) |
| `POST /api/v1/articles/:slug/comments` | non-idempotent create | optional | implemented — `article_comments.idempotency_key_hash` (migrations `0016` / sqlite `0008`) |
| `PUT /api/v1/articles/:articleId` | conditional state replacement | not required | convergent — a repeat writes the same state |
| `PUT /api/v1/me/profile` | state replacement | not required | convergent |
| `PUT /api/v1/articles/:slug/like` | state-setting (`liked` in the body) | not required | convergent, notifications are transition-only |
| `POST` / `DELETE /api/v1/users/:userId/follow` | relationship state | not required | convergent, no duplicate notifications |
| `PUT /api/v1/conversations/:id/read`, `PUT /api/v1/me/notifications/:id/read`, `POST /api/v1/me/notifications/read-all` | read-state | not required | convergent |
| `DELETE /api/v1/comments/:id`, `DELETE /api/v1/taxonomies/:id`, `DELETE /api/v1/conversations/:id` | monotonic delete | not required | second delete is a stable not-found/tombstone outcome |
| `POST /api/v1/tags`, `POST /api/v1/taxonomies` | non-idempotent create | not yet | **deferred** — see below |
| `POST /api/v1/auth/register`, `login`, `refresh` | security transition | not accepted | **deferred** — see below |
| `POST /api/v1/me/media` | non-idempotent create | not yet | **deferred** — see below |

"Convergent" means the operation sets a state rather than appending to a history, so a repeat
produces the same end state and no extra side effects. Requiring a key there would be ceremony:
the rule from the inventory is to never demand one for an operation that is already repeat-safe.

## Deliberately deferred

- **Media upload.** The bytes are already content-addressed by their SHA-256 digest, so a repeat
  upload of the same file lands on the same object; what is *not* decided is whether a second
  upload of different bytes under a reused key should replace the first asset or conflict, and who
  owns an asset that several works reference. That is a product decision, not a transport one, and
  guessing wrong orphans or silently swaps an image inside somebody's published work.
- **Register / login / refresh.** Replaying a credential response is worse than the duplicate it
  prevents: a stored token body would be handed to whoever replays the key, which is an account
  takeover waiting for a leaked key string. These need a retry contract of their own, designed
  with the session-family rules in ADR 0008.
- **Tag and taxonomy creation.** Both are small, both reject a duplicate name/slug with `409`
  today, and both are operator-facing rather than reader-facing. They are the next creates to
  bring under this contract, not a reason to hold it up.

## Retention

There is no separate key-expiry table and no scheduled cleanup: the digests live in the row the
write created and are removed with it (including by the tombstone sweep that purges deleted
works). The consequence is stated rather than hidden — **a key is reusable for as long as the row
it created exists**, so a client that reuses a UUID months later replays an old outcome instead of
creating something new. Clients are expected to mint a fresh key per user intent; a bounded
retention window with a scheduled purge is the honest next improvement, and it belongs with a
scheduler, which this API does not run.

## Client guidance

- Mint one key per user intent (a UUID is fine) *before* the first attempt, and reuse it only for
  retries of that same intent.
- Retry only on transport failures, `429`, and `5xx`. A `4xx` other than `429` is an answer, not a
  reason to try again.
- The browser is not exempt: `packages/web-http` forwards `Idempotency-Key` verbatim through the
  authoring proxy, so the desk gets replay protection for free once it starts minting keys. It does
  not yet do so, which is why the article route treats the header as optional.

## Adding a new mutation

1. Classify it: non-idempotent create, convergent state-setting, or monotonic delete.
2. If it is a create, add the two digest columns and the partial unique index in a migration pair
   (`migrations/00NN_*.sql` **and** `migrations/sqlite/00NN_*.sql`), and add the version to both
   applied-migration assertions so a forgotten counterpart fails the build.
3. Hash and replay in the store, inside the same transaction as the domain write — not in the
   route, and not in a separate round trip.
4. Add one adapter-contract test that covers: exact retry, mismatched body, and concurrency. The
   contract suite runs against SQLite locally and PostgreSQL in CI; a test added to it covers both.
5. Add a row to this table and to the inventory.
