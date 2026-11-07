# ADR 0022: The media library marks orphans; reclamation is a person's decision

- Status: Accepted
- Date: 2026-11-02

## Context

An author uploads images into a Lexical document. The API normalizes each one to WebP, stores the
bytes in an S3-compatible bucket and the metadata in `media_assets` — and then, when the work is
edited and the image is dropped, forgets about it. The bytes stay, the row stays, nobody is told.
What an author had was no way to see their own uploads at all.

The obvious product to build is a reclaimer: a job that finds assets no article references and
deletes them. It is also the wrong one, and not by a small margin.

## Decision

**The library lists the author's own uploads and marks which of them nothing uses. Deleting one is
a button, behind a reference check that runs at the moment of the delete. Nothing deletes anything
on a schedule.**

### What "unused" means

An asset is an **orphan** when `/api/media/<id>` appears in no work's content.

- **Drafts count.** A draft is published eventually, and an image in it is not unused — it is early.
- **Tombstones count.** A deleted work keeps its row and can be restored (ADR 0017's soft delete).
  Restoring a work into broken images is worse than keeping a few bytes nobody links to.
- **Every author's works count, not just the uploader's.** An image is served publicly at
  `/api/media/<id>`, so anyone can have put it in their own work; the check reads all content.

The question is answered from the materialised `article_media_refs` table, which every article
write maintains in its own transaction (#163, below): the library asks about the ids on the page it
is rendering, and the delete asks about one id inside the transaction that would remove it. It is
**not** a narrower scan of the bodies — the table holds what a body actually contains, so a
reference that exists is a reference that is counted.

### Why nothing reclaims on a schedule

The scan is only as good as the bodies it reads. An image sitting in a block type the scan does not
know about, in a draft the author has not finished, or in a tombstone someone will restore, is one
missing pattern away from being called an orphan — and a cron job deletes it without asking. The
failure is silent, permanent and lands on somebody's published work.

So: **a machine that cannot be asked to explain itself does not get to delete an author's images.**
The bytes at stake are worth less than one restored article full of broken images, and the author
who uploaded the image is the one who pays for it and the one who can be shown the reason.

### The delete, and the two things that guard it

`DELETE /api/v1/me/media/:id`:

1. **Re-runs the reference check against the content as it is now.** The badge on the page is a
   statement about the past: between the render and the click, a work may have been saved that uses
   the image. The badge is a hint; this is the decision, and it is the same function
   (`extractMediaReferences`) that produced the badge, so the two cannot drift apart.
2. **Deletes the object first and the row second.** Failing in that order leaves an invisible object
   nobody links to. The other order leaves a work pointing at bytes that are gone.

A refusal is `409 MEDIA_IN_USE` **carrying the works that use it**. "No" without the reason is a
support ticket, not an answer. An asset that is not the caller's answers `404` — the same answer as
one that does not exist, so the endpoint cannot be used to discover which ids exist.

### Deletion is hard, not soft

The row and the object both go. A soft delete would need a `deleted_at` column, a migration, an
"is it really gone" answer for every read, and a second decision nobody has asked for — when the
bytes are finally purged — which is the scheduled reclamation this ADR refuses, arriving by the
back door. The reference check is what makes a hard delete safe enough to offer.

### Not in this slice

- **Bulk delete.** One button, one image: a multi-select is a place to lose a work's cover image in
  a single click, and the check would have to be per item anyway.
- **Cross-author administration.** No admin screen lists other people's uploads; there is no stated
  need for one and it would be a new kind of access to somebody's files.
- **Restoring a deleted asset.** It is gone. The way back is to upload it again.

## Revision 2026-11-02: what the scan missed, and what the refusal said

Three things were wrong, all found in production-shaped data rather than in tests, and all in the
same direction — the check was too willing to call an image unused, and too willing to name the work
that used it.

### 1. The address of an image is not one string

The original scan looked for `/api/media/<id>`. That is the address the **Web** app writes into a
body. A client that talks to the API directly — the Flutter app — stores `/api/v1/media/<id>`, and a
body that was edited or imported elsewhere holds a fully qualified URL. Both resolve. Neither
matched, so every cover saved by such a client read as an orphan, and the delete button was offered
for an image a published work was showing.

The pattern is now `\/media\/<uuid>`: a path suffix, not a prefix. It matches both routes and any
host in front of them, and it errs in the safe direction — a stray match refuses a delete, while a
miss allows one.

### 2. An avatar is a reference too

A profile picture is a media URL on `user_profiles.avatar_url`, in no article body at all. The scan
never looked there, so a member's avatar was always an orphan and always deletable. The scan rows are
now two kinds — `{kind: "work", …}` and `{kind: "avatar"}` — and the avatar is the reason the rows
are a union rather than a list of works.

### 3. The refusal published another author's draft titles

The 409 carried `referencedBy` entries with `title`, `slug` and `state`. Because the scan reads
*every* author's content — which is the point — that body handed one author's unpublished draft
titles to whoever owned the bytes, on demand, from both the library list and the delete error.

A reference is now **described only when it is public or the reader's own**: published works, and
the reader's own drafts and tombstones, keep their title; anything else arrives as
`{kind: "work", redacted: true}` with the identifying fields emptied. The count behind the orphan
badge is unchanged — a redacted reference still blocks the delete — which is the property that
matters: **you may always know that an image is in use, but not always by what.**

### 4. The two guards are now one operation

Re-running the check in the application layer and deleting afterwards leaves a gap: a work saved
between the two statements loses its image. The scan and the delete are now a **single guarded
provider operation** (`deleteUnusedMediaAsset`) that scans and deletes inside one transaction and
returns `usedBy` instead of deleting when anything references the asset. This is the fix for the race
the original decision described but could not close from outside the provider.

The order is consequently **row first, object second** — the reverse of the original decision. Once
the guarded delete commits, nothing can be referencing the row, so a bucket that cannot be reached
leaves *unreferenced bytes*, logged as `media.object_orphaned` with the storage key so they can be
reclaimed. The delete still answers `200`, because the deletion the reader asked for did happen.

## Consequences

- An author can see their uploads and act on the ones nothing uses, at `/write/media`.
- A deployment without object storage says so (`503`) rather than showing an empty library — the
  difference between "you have no images" and "this deployment cannot accept images".
- The cost of a library read is one indexed question about the page it renders, not a pass over the
  archive. The site-wide body scan survives only as the guarded delete's backstop for a reference
  row that was never written (the amendment below), and only when the table answered "nothing".

## Amendment (2026-11-07): the reference table is a fast path, not proof

§4 made the scan and the delete one provider operation and moved the "is anything
using it" question onto `article_media_refs`. That is correct for every reference a
*writer* in this codebase materialised — but the foreign key can only refuse a
delete it can see a row for. [Issue #217](https://github.com/BrainEno/no-wave/issues/217)
found the missing case: a cross-provider replay (or an older writer, or a direct SQL
fix) can leave the body holding the image URL with no reference row, and the guarded
delete then treated the image as unused and removed it.

`deleteUnusedMediaAsset` therefore asks a second question in the same transaction:
does any translation body, or any profile picture URL, still contain this asset id?
The decision (no scheduled reclamation, owner-initiated deletes behind a guarded
operation) is unchanged; what changes is that the guard no longer treats the
materialised table as the answer. A drifted table means a refusal the reader did not
expect, never a deleted image. This does not make a drifted table safe for a provider
cutover — ADR 0010's snapshot, watermark, fence and reconciliation gates are still
required.

## Amendment (2026-11-07): the library asks about its page, not the archive

The original decision assumed the reference question had to be answered by reading every translation
body, and accepted O(all content) as the honest price. It does not: `article_media_refs` is
maintained inside each article write transaction (create, edit, replay, cascade), so both providers
can answer the question by index instead of by reading text.

`GET /me/media` therefore pages first and asks `listReferencesForAssets({ assetIds })` about those
ids only — one question per page, O(page). At twenty thousand works the old path read roughly
77 MiB of JSON to draw twelve thumbnails; the new one reads the rows for twelve ids.

The site-wide scan is not gone, and should not be: `deleteUnusedMediaAsset` still asks
`listMediaScanRows`' equivalent inside its transaction when the table says nothing is using the
asset, because a row that was never written (the replay case above) is exactly the case a table
cannot prove. That is a bounded extra question (`LIMIT 200`) on one human-initiated delete, not a
per-request cost — and it is what keeps a drifted table a refusal rather than a deleted image.

`apps/api/src/application/media-assets.test.ts` guards the split: a library read that touches
`listMediaScanRows` at all fails, and the ids the reference question names must be exactly the ids
on the page.
