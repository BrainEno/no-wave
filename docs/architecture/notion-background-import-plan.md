# Notion background import: implementation plan

Status: **foundation only; not connected to the API or UI**. The synchronous
import and its eight-download limit remain in effect. This document is not an
accepted ADR or a claim that jobs survive restarts.

## Goal and invariants

An author starts an import after reviewing the existing dry run and sees progress
and a per-page result. A worker handles images in bounded batches; a page is never
reported complete with an unverified image. Images that cannot be copied, including
expired URLs, are omitted and reported as incomplete, as in the synchronous path.
Already copied images from an earlier *different* bundle are only reuse hints: the
new URL must be downloaded and normalized before the old asset is used. An exact
incomplete bundle may reuse its earlier checkpoint under the existing semantics.

Refreshing a bundle during a job must not silently replace its input: create a new
job or explicitly restart the affected page. An import does not fetch fresh Notion
URLs itself and never stores a Notion credential. A fresh bundle's URLs can still
expire before the job reaches them; that must be reported rather than called a
success. Identical URLs may still hide changed bytes, as documented for the current
importer.

## Required next slices

1. **Persistence and secret lifecycle.** Define SQLite and PostgreSQL storage for
   owner-scoped jobs, bounded input, progress, page reports and checkpoints. Signed
   URLs are bearer secrets: never return them in status, logs, errors or telemetry;
   bound retention and delete them on completion/expiry. Decide and document the
   encryption/key and crash-recovery policy before persisting bundle input; the
   status state machine in `notion-import-job.ts` intentionally stores no bundle.
   `notion-import-job-payload.ts` provides an unconnected AES-256-GCM envelope
   bound to job, owner and expiry; it neither manages keys nor stores or deletes
   payloads. The 24-hour maximum is an upper bound, not a guarantee that Notion
   image URLs remain valid that long. Define deployment key provisioning, rotation,
   loss and deletion/backup policies before enabling durable jobs. Never put a
   Notion credential in the envelope. Impose per-owner and global queue/input limits.
2. **Claiming and fencing.** Implement atomic claim, lease renewal and versioned
   compare-and-swap on both databases, including multiple-worker tests. A stale
   lease must not commit article, provenance, or checkpoint writes: the pure state
   transitions are not a substitute for transactional fencing around those side
   effects. Specify how media objects created before a failed or fenced write are
   cleaned up. Preserve ownership and provenance conflict checks at write time.
3. **Worker and checkpoints.** Process a bounded number of downloads per batch,
   save verified progress for the exact input and resume after crash. Never expose
   an old, unverified image as current while a refreshed input is being validated.
   Define cancellation, concurrent imports of the same page, retries and partial
   failures; do not allow old jobs to overwrite newer author edits silently.
4. **Transport and desk.** Add authenticated owner-scoped start/status endpoints,
   safe polling and clear progress, final reports and expiration/retry instructions
   in the authoring UI. Keep dry run side-effect-free and preserve synchronous API
   compatibility until migration is explicit. Update OpenAPI and proxy timeouts.
5. **Verification.** Exercise process restart, lease takeover, duplicate workers,
   concurrent jobs, URL expiry, refreshed signatures on more than eight images,
   image and storage failures, authorization, cleanup and both persistence
   adapters. Add HTTP and browser coverage, including the existing e2e shards.

The current pure transition helpers are a small first slice: a persistence adapter
must compare the expected version atomically and fence writes; invoking them on
stale in-memory snapshots alone does not provide safety.
