# Article conditional writes and Notion import version protection

Implemented on top of the database-local revision groundwork from #266. The
writing desk sends a version precondition, and a Notion dry run now returns an
authenticated plan. Both SQLite and PostgreSQL compare the expected state while
holding the write lock that covers the write itself. A warning in the browser is
not the protection; a direct API client receives the same refusal.

## Article updates

Authoring article reads and write responses include `revision`, a canonical
non-negative decimal string in the signed-bigint range. It must not be converted
to a JavaScript number. `PUT /api/v1/articles/{id}` accepts `expectedRevision`;
a mismatch returns `409 ARTICLE_VERSION_CONFLICT` without changing the work,
editions, taxonomies or media references. The precondition is optional for
compatibility with older API clients; the writing desk supplies it. On conflict
the desk retains the open draft and asks the author to copy it before reopening
and merging with the latest version. This is not durable draft recovery.

Migrations 0034 (PostgreSQL) and 0021 (SQLite) provide `articles.import_revision`.
Triggers advance it for work fields, edition writes and taxonomy associations,
including delete/restore; views do not advance it. Rollback rolls the counter
back too. Ordinary writes may advance it more than once: compare for equality,
never interpret it as an edit count or a timestamp. PostgreSQL write responses
read the revision after child-table triggers have run. SQLite journal snapshots
select only portable columns, avoiding number conversion of the int64 revision;
its plan migration also guards against SQLite promoting an exhausted counter to
REAL. Exhaustion rolls back instead of rounding or wrapping on either provider.

## Authenticated preview

`POST /api/v1/imports/notion` is still a dry run by default. It returns
`planToken` and `planExpiresAt`. To apply, send `apply: true`, the unchanged token,
and the exact selected `bundle` from that dry run. A new selection, page order,
source contents or translation grouping requires another preview.

The HMAC-SHA256 token uses a domain-separated authentication secret and binds:

- The authenticated actor and a canonical SHA-256 hash of the complete bundle
  (object key order is immaterial; array/page/selection order is not).
- The grouping and selected source IDs, and all supported-locale source links
  or their absence, including link ownership, target, digest and sync checkpoint.
- The author-scoped primary create-key recovery identity or its absence.
- Target work existence, ownership and revision, including changes to an absent
  translation through the work-wide counter.
- A database-local generation, issuance time and a 15-minute lifetime.

Tokens are at most 512 KiB and plans at most 200 works. The bundle remains limited
to 8 MiB / 200 pages; the request budget separately allows the token and envelope.
Missing, modified, expired, wrong-actor, changed-selection or wrong-generation
plans return `409 IMPORT_PLAN_INVALID` before any import writes. Tokens are signed,
not encrypted: another author's work/owner IDs are excluded, including from the
decoded payload. Do not log tokens or treat them as replacements for login.

## Locked per-work commit

The importer first does a no-write check before copying images, then repeats the
comparison inside the real commit. The first check alone is not sufficient.

- **SQLite:** `BEGIN IMMEDIATE` covers generation, source links, create-key and
  work revision comparison and every business write. The callback is synchronous;
  no connection transaction spans an `await`. Child writers use savepoints.
- **PostgreSQL:** sorted advisory locks serialize all adapter claims of the
  selected Notion page IDs, including claims of an absent locale. Existing source
  rows and the target article are row-locked; the article is read with
  `FOR UPDATE`. Child writers use savepoints in the same transaction. Ordinary
  provenance upserts take the same page lock.
- Compare **once per work**, then write all changed editions, tags, media
  references and provenance together. The primary edition's own revision bump
  cannot make its translation conflict with itself. A create that discovers a
  late idempotency replay is refused, never silently converted to an update.
- Child article/tag/link journal captures use one work transaction ID. A
  provenance or later-edition failure rolls back the whole work, its newly
  created tags and its journal rows. Reading a journal batch must not split it.

A stale work is reported as `refused` with a request to preview again. A failed
write is `failed` and explicitly says the work rolled back. Unrelated works may
still commit: the report and UI distinguish partial import from total rejection;
`applied: true` means apply was attempted, not that every page succeeded.

Historical missing-link imports are recovered through the author-scoped create
key, but only against the version previewed. Deleted works, cross-owner links,
conflicting targets and locale/grouping changes are conservatively refused;
there is no automatic rewrite of historical provenance. Existing addresses are
preserved; automatic create slug collisions retry up to 25 candidates, while an
explicit conflicting slug fails the work.

## Media and cutover boundaries

Image fetching/normalization happens outside the database write lock. An edit or
source-link change during that work is caught by the final locked comparison.
Media storage is not part of the article transaction: successful uploads can
remain as unused assets after a conflict/failure. The report explicitly directs
the author to review the media library, where those assets remain visible and
removable. No article/tag/link is left partially committed.

Migrations 0035 (PostgreSQL) and 0022 (SQLite) create a random database-local
`import_plan_generation`. The provider transfer and replay allowlists exclude
this table and exclude the source article revision. The target keeps its own
generation and revision triggers. Actual SQLite-to-SQLite and
SQLite-to-PostgreSQL transfers reject source-issued plans, even when using the
same signing secret; a new target preview works. When cloning/restoring a whole
database outside these tools, operators must rotate its generation (or signing
secret) before accepting writes if old previews must be invalidated. This does
not add live-cutover fencing or prevent split-brain writes.

## Database-wide ownership after #305

#305 supplied the atomic preview/apply transaction and serialization described
above; those protections are retained. #270 additionally requires every existing
locale row of `(provider, external_id)` to share one owner, even for direct SQL
and independent connections that ignore the advisory locks.

Migrations **0036 PostgreSQL / 0023 SQLite** add that final database authority.
PostgreSQL's named `btree_gist` exclusion compares equal provider/page and unequal
owner; SQLite's INSERT and ownership-key UPDATE triggers run under the engine's
single-writer semantics. Same-owner multi-locale rows remain valid. Foreign
ownership takes precedence over a generic locale mismatch in preview, and a late
ownership violation becomes `refused` with an explicit "another account" reason,
not raw SQL or apparent success. All of the losing work's transactional writes
and capture rows roll back. Unrelated database errors remain `failed`.

See [ADR 0037](decisions/0037-import-provenance.md) for exact constraint/error
identities, legacy-conflict audit and explicit remediation, `btree_gist` privileges
and table-lock prerequisites. The old draft #303 is not the integration baseline:
its non-atomic article/link flow must not replace #305's per-work commit. The
operator seed remains a separate workflow, not a signed preview/apply client.

## Regression evidence

- `apps/api/src/persistence/notion-page-ownership.integration.test.ts`: real
  independent full-import and direct-SQL races, both locale winner directions,
  legacy upgrades, exact provider error translation, eleven rollback stages per
  provider, late constraint violations and owner-only orphan-media management.

- `apps/api/src/transport/rest/import-version-protection.integration.test.ts`:
  real HTTP and stores on both providers; authenticity/expiry/actor/selection,
  post-preview body/rename/taxonomy/new-edition/delete-restore changes, source-link
  removal/metadata/target/new-locale changes without a revision bump, view counts,
  missing-link recovery, late creates and competing previews, multi-edition
  commits, media-preparation races, removable leftover media, journal grouping
  and rollback, and actual provider-transfer plan invalidation.
- The same suite uses independent SQLite worker connections and separate
  PostgreSQL backend PIDs to prove the losing conditional update/source claim
  actually waits on the winner's transaction and then refuses stale state.
- `apps/api/src/transport/rest/article-write.test.ts`: canonical bigint strings,
  malformed/range checks and rejection of update preconditions on creates.
- `apps/api/src/application/notion-import.test.ts`: preview/apply orchestration,
  no-write dry runs, idempotency, recovery and private provenance redaction.
- `apps/api/src/persistence/provider-migration-{transfer,journal}*.test.ts`:
  generation exclusion/preservation, revision exclusion and replay/transfer parity.
- `packages/web-ui/src/lib/notion-import.test.ts`: token-preserving parsing,
  confirmation requires a plan, and honest rejected/partial-result headlines.
- `e2e/notion-import.spec.ts`, `e2e/authoring.spec.ts`: browser confirmation and
  re-preview recovery, a post-preview edit preserved through apply, and a stale
  editor's draft retained after a real conditional-write conflict. Browser,
  PostgreSQL and full-suite gates run in CI.
