# Reading an old notification inbox

`GET /api/v1/me/notifications` returns the signed-in reader's notifications,
newest first. The response is a plain array under `data` — the same shape it has
always had — and one extra query parameter, `cursor`, continues the list
backwards. Without a cursor the request is the first page, exactly as before.

```sh
# First page
curl -s "https://api.example.com/api/v1/me/notifications?limit=20" -H "Authorization: Bearer $TOKEN"

# Next page: the cursor names the last notification of the page above
curl -s "https://api.example.com/api/v1/me/notifications?limit=20&cursor=$CURSOR" -H "Authorization: Bearer $TOKEN"
```

A client that only wants the newest notices can keep sending the request it
sends today: nothing about the response body, the authentication or the unread
count changed.

## The order

`(createdAt DESC, id DESC)` — newest first, and, when two notifications share a
timestamp, the larger id first. The id is a UUID and the tie-break is part of the
contract, not an implementation detail: without it a page boundary inside one
millisecond would either repeat a notification or skip one.

`readAt` is not part of the order. Marking notifications read — one or all — never
moves a row, so a cursor taken before a "mark all read" still continues after the
same notification afterwards.

## Building the cursor

Take the **last** element of the page you already have and encode its two sort
keys:

```text
cursor = base64url("<createdAt>|<id>")
```

`<createdAt>` is the string the API returned, byte for byte (`2026-06-01T00:00:00.123Z`).
Do not re-format it through a local timezone or a
`DateTime` with fewer digits: the cursor is compared against the stored value, and
anything the API did not produce is a different place in the list.

```js
// JavaScript (browser or Node): base64url without padding, matching the API.
function nextCursor(lastNotification) {
  const raw = `${lastNotification.createdAt}|${lastNotification.id}`;
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

**An empty page is the end of the inbox.** There is no `hasMore` flag and no
count of the remainder. Request pages until one comes back as `{"data": []}`, then
stop — the next request with that final cursor would answer an empty page again.

A page shorter than `limit` is a strong hint that the end is near, but it is not
the rule: a notification created while the reader is paging sits *above* the
cursor, so a short page can still be followed by an older one only if rows were
deleted in between. Empty is the signal.

## Notifications that arrive while the reader is paging

A notification created after the cursor was taken is newer than every row the
remaining pages will return, so it never appears in them: no duplicates, no
shifted boundary, nothing skipped. It becomes visible the next time the client
reads the **first** page — which is what a refresh of the inbox top is.

That is a deliberate trade: an inbox is read top-down and rarely scrolled to its
end, so the newest page is the one worth refreshing, and the older pages are
append-only history.

## Errors

| Status | Code | When |
| --- | --- | --- |
| `400` | `BAD_USER_INPUT` | `cursor` is not `base64url("<millisecond ISO timestamp>|<uuid>")`, is longer than 512 characters, or `limit` is not an integer in `1..100` |
| `401` | `UNAUTHENTICATED` | no valid session |

Messages: `Invalid cursor query parameter.` and `Invalid limit query parameter.`.
A malformed cursor is never compared against the database — it cannot be, it is
half of a sort key — so it is refused before the read rather than surfacing as a
server error.

The recipient is always the verified session. There is no parameter that names
another account's inbox, with or without a cursor.

## Time precision

The cursor carries milliseconds, because that is what the API returns
(`Date.toISOString()`). Both providers store notification times at exactly that
precision:

- **SQLite** writes the schema default `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  which is milliseconds.
- **PostgreSQL** used `now()` — microseconds — until migration
  `0030_notification_created_at_millisecond_precision.sql`, which truncated
  existing rows, changed the column default to `date_trunc('milliseconds', now())`
  and added a `CHECK` that keeps it that way.

Without that migration a cursor naming `…:00.123Z` would compare *below* a stored
`…:00.123456Z`, and every notification inside the boundary millisecond would sort
above the cursor and never be returned — a gap with no error and no trace. The
same fix was applied to works and media in migration 0023; notifications were the
table left behind. If a deployment upgrades from a schema older than 0030, run
migrations before serving traffic.

## Limits and scope

- `limit` stays `1..100`, default `50`. There is no offset mode for this list.
- The unread **count** is always the whole inbox, not the page.
- Out of scope here: push delivery, live updates, and the Flutter client's inbox
  UI. This document is the server contract those clients will use.

## Where this is implemented

| Piece | File |
| --- | --- |
| Route, cursor validation | `apps/api/src/transport/rest/routes/notifications.ts` |
| Cursor encoding/decoding | `apps/api/src/domain/cursor.ts` |
| SQLite keyset read | `apps/api/src/persistence/sqlite-notification-store.ts` |
| PostgreSQL keyset read | `apps/api/src/persistence/postgres-notification-store.ts` |
| Millisecond guarantee | `apps/api/src/persistence/migrations/0030_notification_created_at_millisecond_precision.sql` |
| Browser proxy pass-through | `packages/web-http/src/notifications.ts` |
| Contract tests (both engines) | `apps/api/src/persistence/persistence-adapter-contract.test.ts` |
| PostgreSQL HTTP-level walk | `apps/api/src/persistence/postgres-cursor-pagination.integration.test.ts` |
