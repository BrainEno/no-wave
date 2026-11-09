# Reading further down a comment thread

`GET /api/v1/articles/:slug/comments` returns a published work's comment thread,
oldest first. The response is a plain array under `data` — the same shape it has
always had, each top-level comment carrying its `replies` — and one extra query
parameter, `cursor`, continues the thread past the first page. Without a cursor
the request is the first page, exactly as before.

```sh
# First page
curl -s "https://api.example.com/api/v1/articles/a-work/comments?locale=zh-CN&limit=20"

# Next page: the cursor names the last top-level comment of the page above
curl -s "https://api.example.com/api/v1/articles/a-work/comments?locale=zh-CN&limit=20&cursor=$CURSOR"
```

## What one page contains

**`limit` counts top-level comments, not replies.** Each top-level comment arrives
with its whole reply tree, however many answers it has, so a page boundary can
only fall between two roots — never between a comment and the answers to it. A
root with thirty replies is one page item.

## The order

`(createdAt ASC, id ASC)` — oldest first, and, when two comments share a
timestamp, the smaller id first. The id is a UUID and the tie-break is part of the
contract, not an implementation detail: without it a page boundary inside one
millisecond would either repeat a comment or skip one.

This is the same order the single-page read has always used, so a client that
never sends a cursor sees no change at all.

## Building the cursor

Take the **last top-level comment** of the page you already have — not the last
reply inside it — and encode its two sort keys:

```text
cursor = base64url("<createdAt>|<id>")
```

`<createdAt>` is the string the API returned, byte for byte
(`2026-06-01T00:00:00.123Z`). Do not re-format it through a local timezone or a
`DateTime` with fewer digits: the cursor is compared against the stored value, and
anything the API did not produce is a different place in the thread.

```js
// JavaScript (browser or Node): base64url without padding, matching the API.
function nextCursor(lastTopLevelComment) {
  const raw = `${lastTopLevelComment.createdAt}|${lastTopLevelComment.id}`;
  return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

// Dart/Flutter equivalent, for clients that do not get a cursor helper.
String nextCursor(Map<String, dynamic> last) {
  final raw = '${last['createdAt']}|${last['id']}';
  return base64Url.encode(utf8.encode(raw)).replaceAll('=', '');
}
```

The format is stable and documented rather than opaque, because a plain-array
response has no `nextCursor` field to hand back: the client builds the next cursor
from the row it holds. That is also why an invalid cursor is a `400` (see below)
rather than a silently different page.

## Knowing when to stop

**An empty page is the end of the thread.** There is no `hasMore` flag and no
count of the remainder. Request pages until one comes back as `{"data": []}`, then
stop.

A page shorter than `limit` means the thread is exhausted — unlike the
notification inbox, this list is ordered oldest first and a new comment is always
appended at the far end, so nothing can appear inside a page already read.

## Comments that arrive while the reader is paging

A comment posted after the cursor was taken is newer than every root the
remaining pages will return, so it never appears in them: no duplicates, no
shifted boundary, nothing skipped. It becomes visible the next time the client
reads the **first** page — which is what a refresh of the top of the thread is.
A reply posted mid-read likewise appears under its own root, never on a later page
of its own.

## Errors

| Status | Code | When |
| --- | --- | --- |
| `400` | `BAD_USER_INPUT` | `cursor` is not `base64url("<millisecond ISO timestamp>|<uuid>")`, is longer than 512 characters, or `limit` is not an integer in `1..100` |
| `400` | `BAD_USER_INPUT` | `locale` is not one of the supported locales, or the slug is malformed |

Messages: `Invalid comment cursor.` and `Invalid comment limit.`. A malformed
cursor is never compared against the database — it cannot be, it is half of a sort
key — so it is refused before the read rather than surfacing as a server error.

A slug that is not a published work reads as `{"data": []}` with or without a
cursor: the public read answers "nothing here", not an error.

## Time precision

The cursor carries milliseconds, because that is what the API returns
(`Date.toISOString()`). Both providers store comment times at exactly that
precision:

- **SQLite** writes the schema default `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  which is milliseconds.
- **PostgreSQL** used `now()` — microseconds — until migration
  `0031_comment_created_at_millisecond_precision.sql`, which truncated existing
  rows, changed the column default to `date_trunc('milliseconds', now())` and
  added a `CHECK` that keeps it that way.

Without that migration a cursor naming `…:00.123Z` would compare against a stored
`…:00.123456Z` as *greater than* the cursor, so the comment inside the boundary
millisecond would be skipped on the next page and returned twice on the previous
one — a duplicate and a gap, with no error anywhere. The same fix was applied to
works and media in migration 0023 and to notifications in 0030. If a deployment
upgrades from a schema older than 0031, run migrations before serving traffic.

## Limits and scope

- `limit` stays `1..100`, default `50`, counted in top-level comments.
- The whole reply tree of every root on the page is included; that is the point.
- Out of scope here: comment likes, client-chosen sorting (newest first, most
  liked), and the Flutter client's thread UI. This document is the server
  contract those clients will use.

## Where this is implemented

| Piece | File |
| --- | --- |
| Route, cursor validation | `apps/api/src/transport/rest/routes/articles.ts` (`articles.comments`) |
| Cursor encoding/decoding | `apps/api/src/domain/cursor.ts` |
| SQLite keyset read | `apps/api/src/persistence/sqlite-engagement-store.ts` |
| PostgreSQL keyset read | `apps/api/src/persistence/postgres-engagement-store.ts` |
| Millisecond guarantee | `apps/api/src/persistence/migrations/0031_comment_created_at_millisecond_precision.sql` |
| Browser proxy pass-through | `packages/web-http/src/comments.ts` |
| Decision record | `docs/architecture/decisions/0034-comment-thread-pagination.md` |
| Contract tests (both engines) | `apps/api/src/persistence/persistence-adapter-contract.test.ts` |
| PostgreSQL HTTP-level walk | `apps/api/src/persistence/postgres-cursor-pagination.integration.test.ts` |
