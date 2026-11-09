# ADR 0034: A thread pages by top-level comment, and a reply travels with its root

- Status: Accepted
- Date: 2026-11-09

## Context

`GET /api/v1/articles/:slug/comments` has always taken a `limit`, and that
`limit` has always counted **top-level** comments. It had no second parameter.
On a work whose thread outgrew its page — 50 roots by default — the remaining
comments existed in the database and in no reachable place: the reader saw the
first page, a fresh request returned the same first page, and the rest was
write-only. Article lists, taxonomy pages, the media library and the notification
inbox all learned to page; the comment thread was the projection left behind, and
ADR 0032 had already promised that everything the write path accepts comes back.

Paging a thread is not paging a list, though. A comment is not a row with a
position: it is a node whose replies are only meaningful next to it, and cutting
between a root and its answers would rebuild the exact defect ADR 0032 removed —
a comment that was accepted and then not shown.

## Decision

**The page unit is the top-level comment, and a page carries each root's whole
reply tree.**

```sql
root_comments AS (
  SELECT … FROM article_comments c
  WHERE c.parent_comment_id IS NULL
    AND (… keyset predicate on (created_at, id) …)
  ORDER BY c.created_at ASC, c.id ASC
  LIMIT $limit
)
```

A reply is never a page item, never counted against `limit`, and never returned
without its root. A root with forty replies is one page item and forty rows in
the payload; a page boundary can therefore fall only between two top-level
comments, which is the only boundary a reader can lose nothing at.

**The order is oldest first — the reading order of a conversation — and the
cursor continues forward from it.**

```text
cursor = base64url("<createdAt>|<id>")        # the last top-level comment shown
next   = created_at > cursor.at
      OR (created_at = cursor.at AND id > cursor.id)
```

The direction is the first clause of the predicate, and it is deliberately the
opposite of the notification inbox: an inbox is read from the newest end and
pages backwards, a thread is read from the top and pages forwards. Both use the
same encoder (`domain/cursor.ts`), so a client implements one function and uses
it twice.

Without a cursor the request is the first page, byte for byte what it returned
before this decision. `limit` is unchanged (`1..100`, default `50`) and still
counts roots.

**Comment times are stored at the precision the cursor can name.**

The cursor is built from the `createdAt` the API returned, which is a
`Date.toISOString()`: milliseconds. PostgreSQL's `article_comments.created_at`
defaulted to `now()`, which is microseconds. A cursor naming `…:00.123Z` compares
against a stored `…:00.123456Z` as *greater than* the cursor, so the reply inside
the boundary millisecond would be skipped — and the roots before it would come
back twice on the previous page. Migration
`0031_comment_created_at_millisecond_precision.sql` truncates existing rows,
changes the default to `date_trunc('milliseconds', now())` and adds a `CHECK`
that keeps it there. This is the third and, as far as the schema goes, last table
of this family: 0023 fixed works and media, 0030 fixed notifications.

**A malformed cursor is the client's mistake, answered as one.**
`decodeCursor` returns `null` for anything that is not
`base64url("<millisecond ISO timestamp>|<uuid>")` (or is longer than 512
characters), and the route answers `400 BAD_USER_INPUT` — `Invalid comment
cursor.` — before the store is asked anything. A cursor is half of a sort key; an
unusable half can only fail inside the query, and a typo must not read as a
server error.

## Consequences

- **One statement serves both pages.** The cursor's two halves arrive as nullable
  parameters and the predicate is guarded by `IS NULL`, rather than a second,
  nearly identical CTE per provider. Two copies of a twenty-line recursive query
  are two places for SQLite and PostgreSQL to drift apart; one statement with a
  null-guarded predicate is one place.
- **The wrong half of the cursor is not a rewind.** Sending a cursor from a
  different work returns that work's roots after the named position — the read is
  scoped by slug, and the cursor only narrows it.
- **A reply posted mid-read is not lost, and does not shift the walk.** It is
  newer than the cursor, so it cannot appear on a later page; it appears under its
  own root, which is either already on a page the reader has or on no page at all
  this pass. The alternative — a cursor over every comment rather than roots —
  would page through answers separated from the question.
- **The response shape does not change.** `{ data: Comment[] }`, each comment with
  its `replies`; there is no `nextCursor` and no `hasMore`. An empty page is the
  end of the thread, exactly as the inbox ends.
- **A deep thread costs one page of roots, not one page of nodes.** `limit` is a
  bound on top-level comments, so a thread of 50 roots with 50 replies each is
  still one request. This is intentional — the alternative truncates trees — and
  is documented for clients that size their buffers (ADR 0032 keeps the depth,
  and therefore the worst case, bounded at 9 levels).
- **The browser proxy forwards the two parameters it understands.** `limit` and
  `cursor` are re-validated in `packages/web-http/src/comments.ts` and everything
  else in the query string is dropped, so a local mistake is a `400` next to the
  page rather than an upstream one.
