# Web article authoring

## Article authoring

The authenticated writing desk is available at `/write`. It supports draft creation/saving, reopening work, editing published articles and publishing through the existing REST contract. The Lexical editor supports paragraph text, h2–h4 headings, quotes without attributions, flat ordered/unordered lists, inline marks, links, code blocks and approved image nodes.

## Image storage and upload

Uploads use an S3-compatible object store; the API never stores source image bytes in SQLite or PostgreSQL. Configure all four required server-only variables:

- `MEDIA_S3_BUCKET`: bucket name.
- `MEDIA_S3_REGION`: bucket region.
- `MEDIA_S3_ACCESS_KEY_ID`: restricted service credential.
- `MEDIA_S3_SECRET_ACCESS_KEY`: restricted service secret.

Optional configuration: `MEDIA_S3_ENDPOINT` for an S3-compatible service or local development endpoint, and `MEDIA_S3_FORCE_PATH_STYLE=true|false` (defaults to path-style when a custom endpoint is set). Never expose these variables with a `NEXT_PUBLIC_` prefix. Use a dedicated bucket with public object access blocked; requests are proxied through the API, so object keys and credentials are not exposed to browsers.

When all `MEDIA_S3_*` variables are unset, image uploads return `503 MEDIA_STORAGE_UNAVAILABLE` while text-only writing remains available. A partial required configuration fails during startup rather than silently disabling a partially configured store.

The API accepts JPEG, PNG and WebP bodies up to 8 MiB. It verifies declared MIME against file signatures, rejects animation/multipage files and unsafe dimensions, rotates according to orientation, scales to at most 2560×2560, and re-encodes as WebP. Re-encoding removes source metadata such as EXIF. The normalized output, checksum, dimensions and owner are recorded in `media_assets`; the object is removed best-effort if metadata persistence fails. API-side write-rate limits apply per socket IP and authenticated user.

Public image URLs use `/api/media/:uuid`; the Web same-origin proxy fetches media from the configured API service. This endpoint serves a normalized WebP object with immutable cache headers, an ETag and `nosniff`. The API validates stored bytes against persisted size and SHA-256 before serving them. Deploy both services with TLS in production.

Before deploying, run the versioned database migrations. SQLite uses `apps/api/src/persistence/migrations/sqlite/0007_media_assets.sql`; PostgreSQL uses `apps/api/src/persistence/migrations/0015_media_assets.sql`. The metadata rows participate in the provider migration change journal like other business entities. Ensure the object bucket is available and backed up separately from the SQL metadata.

## The media library

`GET /api/v1/me/media` lists the signed-in author's own uploads, newest first, 24
at a time (up to 60 with `?limit=`), walked with the `nextCursor` a response
carries. The page is `/write/media`, linked from the writing desk, and it answers
`503 MEDIA_STORAGE_UNAVAILABLE` when the `MEDIA_S3_*` variables are unset — which
the page reports as "this deployment has no image storage" rather than as an
empty library.

Each item carries `orphan` and `referencedBy`. An asset is an **orphan** when
nothing points at its media address: not a draft that will be published later, not
a tombstone that can be restored, just bytes being paid for and shown to nobody.

Two kinds of use are counted, and missing either one marked a live image as an
orphan:

- **A work's content**, whatever address it stores the image under. The scan
  matches the path suffix `/media/<uuid>`, so it sees the Web app's
  `/api/media/<id>`, the API's own `/api/v1/media/<id>` — what a client that talks
  to the API directly stores — and a fully qualified URL. All three resolve to the
  same object.
- **A member's avatar** (`user_profiles.avatar_url`), which is a media URL in no
  article body at all.

`DELETE /api/v1/me/media/:id` deletes an unused asset. The reference check and the
delete are **one guarded operation inside the provider**, so a work saved between
the page render and the click is found instead of losing its image. On success the
row is deleted first and the object second: once the row is gone nothing can be
referencing it, so an unreachable bucket leaves unreferenced bytes rather than a
work pointing at bytes that are gone. That case answers `200` and logs
`media.object_orphaned` with the storage key, so the leftovers can be reclaimed
from the bucket by hand. A refusal is `409 MEDIA_IN_USE` carrying the works that
use it. An asset that is not the caller's answers `404`, the same as one that does
not exist.

**A use is counted even when it is not described.** The scan reads every author's
content, so naming what it finds would hand one author's unpublished draft titles
to whoever owns the bytes. References the API will not name arrive as
`{kind: "work", redacted: true}` with the identifying fields emptied — and they
still block the delete. The rule is: you may always know that an image is in use,
but not always by what.

### Deletion is off in both tiers by default

Two independent switches, and they do different jobs:

- **`MEDIA_DELETE_ENABLED`** (API, default off). Unset, empty and unrecognised
  values all mean off. When off, `DELETE /api/v1/me/media/:id` answers
  `409 MEDIA_DELETE_DISABLED` after authentication and *before* the reference scan
  runs — a refused request must not cost a full-catalogue read. This is the switch
  that matters: it is the only one a Flutter build or a `curl` cannot walk around.
- **`DELETE_ENABLED`** in
  `packages/web-ui/src/components/authoring/media-library.tsx` (default `false`)
  decides only whether the button is offered. Turning it on while the API switch
  is off shows a button whose press is refused.

Why the API refuses by default: the guard above is correct within one transaction,
but on PostgreSQL that transaction runs at READ COMMITTED and takes no lock on the
`media_assets` row. A concurrent `createArticle` / `upsertAuthorProfile` that writes
a reference to the same image can commit *between* the scan and the delete, and both
transactions then succeed — leaving a work whose images are permanently gone (#156).
The fix is the materialised reference table in #163, with `ON DELETE RESTRICT`
enforced by the database rather than by a scan.

**So turning this on re-enables a known data-loss race.** Set it only on an
instance where you accept that risk — for example SQLite, where the delete is
synchronous and serialised — and turn it back off when #163 lands and the guard no
longer depends on a scan.

The Web-side switch is documented here rather than in the Web app's own notes
because the two have to be read together: one decides what is offered, the other
decides what is allowed.

**Nothing reclaims storage on a schedule, and nothing should.** The scan that
decides "unused" is only as good as the body it reads: an image sitting in a
draft, in a tombstone someone will restore, or in a block type the scan does not
know about is one bad regex away from being called an orphan. A cron job is a
decision about somebody's work taken by a machine that cannot be asked to
explain itself, and the bytes it frees are worth less than one restored article
full of broken images. Reclamation is therefore a button, behind the same check,
pressed by the author who uploaded the image.

The check costs one pass over every work's content per library read — O(all
content), which is the point: knowing that nothing uses an image means looking at
everything that could. If that ever matters, the fix is a `media_references`
table maintained on save, **not** a narrower scan, which would silently decide
that some references do not count.

See [ADR 0022](../architecture/decisions/0022-media-library-without-scheduled-reclamation.md).

## Comments

Article comments use a deliberately smaller Lexical configuration: paragraphs, bold, italic, underline, strikethrough and links only. The browser calls same-origin comment routes; create requests require an exact `Origin` match and use the authenticated API. Rich comment blocks are validated by the existing application-owned v1 comment contract. Images, headings, lists and code are not accepted in comments.

## Authentication boundary

The browser never receives the access or refresh token in JSON. The Next.js same-origin auth route writes them to HttpOnly cookies; the access cookie is scoped to `/api/authoring`, and the refresh cookie is scoped to `/api`. Cookies use SameSite=Lax and Secure on HTTPS. Mutating requests require the exact request origin. The server-side proxy attaches the Bearer token, rotates refresh tokens on an API 401, retries once, and clears cookies after an invalid or expired refresh token.

This does not complete the account lifecycle: email verification, password recovery, operational abuse controls and full production security review remain separate work. Configure `API_BASE_URL` or the Vercel service binding, and keep the API reachable only via the intended network boundary.

## Contract

Article writes send a Lexical `editorState` plus `contentBlocksVersion: 1` to `POST /api/v1/articles` or `PUT /api/v1/articles/:id`. The existing API adapter validates and converts the state into the application-owned `contentBlocks` contract; the database does not store Lexical's internal state format. Drafts and published work list through `GET /api/v1/me/articles`. API-side compatibility tests validate the Web serializer against the real content adapter.

Deletion is a tombstone, not a row removal: `DELETE /api/v1/articles/:id` stamps `deleted_at` and returns the work to draft, so every published read already excludes it, and releases its slug so rewriting the same title cannot collide with the tombstone. The desk shows the author's own tombstones under `GET /api/v1/me/articles/deleted`, each with the moment it will be swept, and `POST /api/v1/articles/:id/restore` brings one back — as a draft, never as published, because republishing is the author's decision to make again. `ARTICLE_TOMBSTONE_RETENTION_DAYS` (default 30) decides how long a tombstone survives; the sweep runs bounded and opportunistically on the desk's own writes, and the author has no "delete forever" action. Purging removes the row and, through the foreign keys, the translations, likes, comments and taxonomy links that referred to it — the one irreversible step in the slice. Because that cost falls on readers who commented, the desk states it twice: the delete confirmation names the recycle bin as the way back and says that the comments go when the sweep runs, and each tombstone in the recycle bin shows its own deadline together with how many comments it still carries. Those readers are told as well: deleting a work writes each distinct commenter one notification (`article.deleted`, carrying the article id and the date the sweep will run), capped at 200 per deletion and never able to fail the deletion itself. There is no scheduler to warn them the day before, so the deletion is the only moment the system can reach them.

## The reader's inbox

A notification nobody can read is a ledger entry rather than a message, so the desk carries the screen. Four same-origin routes back it — `GET /api/authoring/notifications` (`limit`, 1–100, default 50), `GET /api/authoring/notifications/unread-count`, `PUT /api/authoring/notifications/:id/read` and `POST /api/authoring/notifications/read-all` — implemented once in `packages/web-http/src/notifications.ts` and reached from the `api.authoring.notifications*.ts` resource routes of the Web application (they were mirrored by `apps/web/src/app/api/authoring/notifications/*` until that app was deleted in 2026-11-01). They sit under `/api/authoring/` because that is the path the access cookie is scoped to: a browser sends the token there and nowhere else, so an inbox at `/api/notifications` would have to reach it through the refresh-and-retry path instead — a token rotation every time the desk opens. Reads are `no-store` like every other private call; the writes are origin-checked, and the notification id is shape-checked *after* the origin check, so a cross-origin caller cannot use the status code to learn which ids exist.

The screen is a section at the top of `/write`, the only private page the product has today: the unread count in its heading, one row per notice, and a control to mark one notice — or the whole inbox — read. A notice whose type the screen does not recognise is dropped rather than rendered as a blank row, so the inbox keeps working after the API learns a second kind of notice.

Two limits, both deliberate:

- The notice carries the work's **id**, not its title, so the sentence says "a work you commented on" instead of naming it. Naming it means writing the title into the payload at deletion time — the reader keeps the notice after the sweep has removed everything that title pointed at.
- The inbox is read **when the desk opens**. There is no polling and no push, so a reader hears about another author's deletion the next time they open their own desk. The end-to-end journey asserts the whole loop — comment, delete, read the notice, mark it read — in a real browser, against both frameworks.
