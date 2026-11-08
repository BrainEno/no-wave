# ADR 0031: A comment edit replaces the words and nothing else

- Status: Accepted
- Date: 2026-11-08

## Context

A reader who mistypes a comment has two options in the shipped product: leave the
mistake, or delete the comment and post it again. The second is worse than it
looks. The reply the mistake provoked loses its parent, the thread is reordered as
if the thought were new, and any reader who was notified is notified twice about
one comment.

The API already owns everything an edit needs: comments have an `author_id`, a
`content` column plus the versioned `content_blocks` document, and a delete that
is owner-only. What it did not have was a way to change the text — the only write
after creation was `DELETE`, and a correction meant destroying the row.

Three shapes were possible:

1. **Edit in place.** `PATCH /api/v1/comments/:id` replaces the text and stamps
   when it happened.
2. **Revision history.** Keep every version, show a diff.
3. **Delete-and-repost on the client.** No API change; the client deletes and
   reposts, and the thread pretends it did not happen.

## Decision

**Edit in place, text only, with a marker.** `PATCH /api/v1/comments/:id` accepts
the same body the create route accepts (`content`, or `contentBlocks` /
`editorState` with `contentBlocksVersion`), replaces the words, and sets a new
nullable `edited_at` column (migration 0028 on PostgreSQL, 0018 on SQLite). The
serialized comment carries `editedAt`, so a reader is told the text changed.

The columns an edit may not touch are the substance of the decision:

- **`parent_comment_id` is rejected, not ignored.** A body carrying a non-null
  `parentCommentId` answers `400`. An edit that could move a reply would rewrite
  the thread the reply answered; choosing a parent stays a property of creation,
  where the API can check that the parent is a comment on the same work.
- **`created_at` never moves.** The comment keeps its place in a thread that is
  read newest-first, so an edit does not republish it and does not reorder it.
- **`author_id` never moves.** The row is updated only when the caller is the
  author, checked inside the write transaction with the row locked; somebody
  else's comment raises the same `ArticleAuthorizationError` the delete raises, so
  the two answers for "not yours" cannot diverge and an id cannot be probed by
  watching which refusal comes back.
- **The idempotency columns are not read.** Comment *creation* is idempotency-keyed
  (ADR 0011's pattern, migration 0016). An edit needs no key: replaying the same
  edit writes the same text and re-stamps `edited_at`, which is not a second
  effect a client could be surprised by. Requiring a key would have made the edit
  path the only write a caller could not make twice by accident, for no gain.
- **No notification.** Creating a comment notifies the work's author and the
  parent comment's author. Editing one notifies nobody: a notification is a page
  to a person, and re-notifying on every edit would let an author page an entire
  thread at will by editing one comment in a loop. The cost is that a reader who
  was already notified sees the corrected text only when they return to it — which
  is what an edit is: a fix for the record, not an announcement.

**No revision history.** The previous text is not stored. Keeping it would mean a
second table, a retention rule, a decision about whether a deleted comment keeps
its revisions, and an interaction with the moderation tombstone (ADR 0024's
delete-in-place shape) that this decision has no reason to open. A reader sees the
current text and a marker saying it changed; what it said before is not part of
the product. If it ever becomes one, that is a new ADR and a new migration, not a
flag on this one.

**`edited_at` is nullable, and the marker is the only difference.** Legacy
comments and comments nobody has corrected answer `editedAt: null` and are
otherwise identical on the wire. Nothing has to be backfilled, so the migration is
one `ALTER TABLE … ADD COLUMN` on both providers and a migration into SQLite
leaves no trace of a value it never had.

## Consequences

- **The thread is stable.** Editing cannot change what a comment answers, when it
  appeared, or who wrote it, so nothing downstream of the thread read has to
  re-sort, re-link or re-notify.
- **REST and the Web app agree by construction.** The edit route is one operation
  in the generated OpenAPI document (`PATCH comments.item`), and the browser
  reaches it through `PATCH /api/comments/:id` in `packages/web-http`, which
  validates the id and locale locally, checks the origin, bounds the body and
  attaches the session cookie. The API still decides who may edit; the browser
  only decides whether *to offer* the button.
- **The write rate-limit table had to grow.** Editing is a write, and the table's
  boot check (`assertWriteRateLimitsCoverRoutes`) refused to start until the route
  had a policy. It shares the delete's budget rather than the create's: an edit
  writes one row and sends no notification.
- **An edit is a second write that the audit journal sees.** Both adapters record
  the update in the provider-migration journal, so a later cutover replays the
  corrected text rather than the original.
- **Two refusals, two different meanings.** `404` means no such comment, `403`
  means it exists and is not yours. That is the same pair `DELETE` answers, and it
  is deliberate: keeping the pair identical means the edit endpoint cannot be used
  to learn which ids exist from a second angle.
- **A retracted correction is not recoverable** from the product. The author can
  edit again, but nobody can read what the first draft said — the price of "no
  revision history", stated here so it is a decision and not a surprise.
