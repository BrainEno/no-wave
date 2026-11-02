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

The check is one pass over `article_translations.content_blocks` per library read — O(all content).
That is the honest cost of the question: knowing that nothing uses an image means looking at
everything that could use it. If it ever matters, the answer is a `media_references` table
maintained on save. It is **not** a narrower scan, which would quietly decide that some references
do not count.

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

## Consequences

- An author can see their uploads and act on the ones nothing uses, at `/write/media`.
- A deployment without object storage says so (`503`) rather than showing an empty library — the
  difference between "you have no images" and "this deployment cannot accept images".
- The cost of a library read grows with the size of the whole archive. Documented, bounded by the
  page size, and fixable with a table when it is a problem rather than a worry.
