# ADR 0037: An import remembers where each edition came from, in the database

- Status: Accepted
- Date: 2026-11-09
- Updated: 2026-11-12 — atomic preview/apply from #305 and database-wide page ownership from #270

## Context

ADR 0036 settled the shape: an imported Notion page becomes an ordinary article,
and the mapping between the two is one pure module. Phase 1 shipped that mapping
and an operator seed that writes through the REST API, remembering what it had
already imported in two places — the API's stored `Idempotency-Key`
(`notion-seed:<page id>`, ADR 0019) and a digest file on the operator's disk.

That is enough for one operator with one laptop. It is not enough for the feature
the product needs next: **any signed-in author imports their own database from the
browser** (`POST /api/v1/imports/notion`). Two things break.

1. **A client-supplied memory is not a fact.** If the browser says "page X is
   unchanged since my last import", the server can only believe it. A cleared
   profile, a second browser, a second device, or a malicious client all produce a
   different answer to the same question — and the answer decides whether the
   site rewrites a work or leaves it alone.
2. **`Idempotency-Key` is not provenance.** It makes a repeated *create* a no-op
   for as long as the stored key lives, and it says nothing about where the work
   came from, which locale of the page produced it, or whether a page's content
   has actually changed since. It is also the wrong place to hang a foreign id: an
   idempotency key is a request fingerprint, not a piece of the domain.

Re-import must remain the safe, boring operation ADR 0036 promised: import the
same bundle twice and nothing happens; change a page and the work it already
belongs to is updated, keeping its address; delete a page in Notion and the site
does nothing at all.

The original edition primary key alone did not enforce page ownership across
locales: two accounts could insert different locale rows for the same page.
#305's page locks serialize cooperating importers, but a standalone SQL writer
can bypass those locks. #270 therefore also requires a database invariant, not
just a preview warning or an application lock.

## Decision

**Provenance is a table the server owns, keyed by `(provider, page, locale)`, while
ownership belongs to `(provider, page)` independently of locale. The import is
one endpoint that reports per page and commits per work.**

1. **`external_content_links` is the memory** (migration `0033` PostgreSQL,
   `0020` SQLite). One row per imported *edition*: `(provider, external_id,
   locale)` is the primary key, `article_id` points at the work, `owner_id` records
   the account that imported it, `digest` is the fingerprint of what a reader sees,
   and `synced_at` is when it was last written.

   - **`locale` is part of the edition key, not an ownership namespace.** All
     existing rows for `(provider, external_id)` must have exactly one distinct
     `owner_id`. Multiple locales for that same owner are valid. Locale changes
     must not let another account claim the same page.
   - **The key is global, not per owner.** A Notion page names one work in the
     world. A second account importing an already linked page is *refused*, with
     a reason that names the ownership conflict but never reveals the other
     account's identity, private article ID, or raw database diagnostics.
   - **`ON DELETE CASCADE`**: the link is not a backup. Soft-deleted works retain
     their links and are refused rather than recreated; a permanent purge removes
     their links. Historical create-key recovery also refuses a deleted work.

2. **The digest is computed by the mapping and stored by the server.** It is
   `draftDigest` from `notion-bundle.ts` — over the title, summary, locale, work
   type, sorted tags, publish state, publication instant and the blocks without
   their ids. A page that was merely touched in Notion (a moved cursor, a recoloured
   block) is not a change. Because the comparison happens server-side, "unchanged"
   means the same thing in every client, on every device, after any cache clear.

3. **One endpoint: `POST /api/v1/imports/notion`, dry run by default.** Without
   `apply: true` nothing is written — no works, tags, links or images — and the
   response is the plan. Apply supplies the unchanged bundle and authenticated
   `planToken` from that preview. The token binds actor, selection/grouping,
   source links in every supported locale, create-key recovery, target revision,
   database generation and expiry; it is not permission to overwrite a later edit.
   The answer is a per-page report (`create` / `update` / `skip` / `refused` /
   `failed`) rather than a single success status: an import of forty pages must
   not fail because an unrelated work is empty. See the
   [version-protection design](../notion-import-version-protection.md).

4. **A translation is added to its work, not created beside it.** The plan groups
   pages into works first using the `English` relation only; `Parent item` and
   `Sub-item` describe hierarchy and are not treated as translations. When the
   work is new, its primary page creates the article and the other editions are
   written to that article in their own locale. Counting an added edition as an
   `update` in the report is deliberate: one work, one article. The ownership
   invariant does not relax the planner's conservative locale/grouping checks or
   authorize retargeting a link to a different work.

5. **A re-import never renames anything.** The address of an imported work is the
   one the API chose when it was created (possibly suffixed, possibly authored in
   the `Slug` property). An update writes that address back. The import reads it
   through `getMyArticle({articleId, actorId, locale})` — an author-scoped read,
   because an id is not a permission — instead of storing a copy on the link,
   which would revert a rename the author made in the desk.

6. **Slug resolution belongs to the application/transactional create path.**
   `application/article-create.ts` defines the ordinary create retry policy;
   `persistence/notion-import-transaction.ts` uses that same policy inside the
   import's existing transaction and child savepoints. Derived slug collisions
   retry up to the shared limit, while an explicit conflicting slug fails the
   work. No retry may commit a partial article or evade the signed source state.

7. **Nothing is deleted, unpublished or merged.** A page that disappeared from the
   bundle is not acted on; `publish: false` becomes a draft for a new work, and an
   existing work is never unpublished by an import. There is no sync engine or
   automatic historical ownership reassignment. Notion credentials stay with the
   client; the server only receives content and eligible image URLs.

8. **Historical missing-link creates can recover, but new partial creates cannot
   escape the transaction.** An author-scoped create key can identify a work
   created by an older importer before its provenance write failed. A later dry
   run warns that applying may replace edits; only a matching authenticated apply
   writes the article and link. Deleted works, conflicting targets or owners,
   inconsistent translations and stale revisions are refused. A guarded upsert
   never replaces a different owner or article for an existing edition. A new
   losing import leaves **no** article, translation, new tag, association, media
   reference, provenance row or provider-journal row from that work.

9. **The database is the final page-ownership authority** (new migrations
   **`0036_external_content_owner` PostgreSQL / `0023_external_content_owner`
   SQLite**, after #305's `0035` / `0022` plan-generation migrations).

   - PostgreSQL installs `btree_gist` in `public` and adds the named exclusion
     `external_content_links_page_owner_excl`:
     `EXCLUDE USING gist (provider WITH =, external_id WITH =, owner_id WITH <>)`.
     Exclusion rejects a pair only when **all** operators are true: equal provider
     and page with *unequal* owners. Equal owners across locales do not conflict.
     The index handles concurrent uncommitted claims, direct `INSERT`, and
     ownership-key `UPDATE`; a check-then-insert query would not.
   - SQLite installs `external_content_owner_insert` and
     `external_content_owner_update` triggers. Both check for a different owner
     on the page; UPDATE of provider/page/owner excludes the OLD primary-key row
     so a valid single-row change does not conflict with itself. SQLite's single
     writer makes the checks authoritative for direct SQL as well. The normal
     WAL, busy timeout and `BEGIN IMMEDIATE` behavior is retained: waiting for a
     writer is not a successful second claim.
   - Only PostgreSQL `23P01` **with that exact constraint name**, or SQLite
     `SQLITE_CONSTRAINT_TRIGGER` (`1811`) **with the exact marker**
     `external_content_links_page_owner_conflict`, becomes an ownership-flavored
     `ImportConflictError`. Guarded edition retargeting becomes a provenance
     conflict. Unrelated exclusions, triggers, FK/CHECK, storage and journal
     failures remain failures, not misleading ownership refusals.

## Transaction and media boundaries

Keep #305's `application/notion-import{,-plan}.ts`,
`persistence/notion-import-transaction.ts` and provider import stores. There is
one existing outer database transaction per work, not a second importer or a
post-hoc cleanup protocol. SQLite's synchronous `BEGIN IMMEDIATE` includes the
comparison and every write; no transaction spans an `await`. PostgreSQL uses the
existing sorted page advisory locks, source/article row locks and child
savepoints. The new constraint/triggers protect writers that do **not** cooperate
with those application locks; they do not replace revision/security checks.

All changed editions, article create/update, tags and their translations,
associations, media references, provenance and provider-journal captures commit
or roll back together. Child captures share the outer work's transaction ID;
rollback also undoes the capture sequence allocation. Never delete shared or
pre-existing tags to compensate for a losing import. Unrelated works can still
commit, so `applied: true` means apply was attempted, not universal success.

Image downloads and successful media uploads happen **before** this database
transaction. Uploaded-but-uncommitted assets can survive a later refusal/failure;
the report tells the author to inspect the media library and remove unused
images. The owner can find and delete those orphan assets through existing
management endpoints. Other accounts cannot list/delete them, and any referenced
asset (including a reference by another work/account) remains protected. There
is no silent storage cleanup, ownership relaxation or import rate-limit change.

## Upgrade prerequisites and operator remediation

These migrations are fail-fast, transactional and non-repairing. They do not
renumber or rewrite #305's migrations. Before an approved release, take a tested
backup and inspect the **target database**, with appropriate access controls:

```sql
SELECT provider, external_id, count(DISTINCT owner_id) AS owner_count
FROM external_content_links
GROUP BY provider, external_id
HAVING count(DISTINCT owner_id) > 1;
```

This portable read-only query intentionally omits private account/article IDs.
If it returns any rows, stop and have an authorized operator inspect the affected
links and works privately, determine the legitimate owner, and obtain approval
for explicit provenance repair. Preserve the content and an auditable backup;
do not auto-select the earliest owner, bulk reassign accounts, delete articles,
or delete unrelated tags/media. Repeat the audit until it returns no rows, then
retry the normal explicit migration command (`pnpm db:migrate` with the selected
provider configured). A migration failure is not permission to repair production
data or deploy.

- **PostgreSQL:** the server must ship the `btree_gist` extension. The migration
  role must be able to install that trusted extension in `public` (database and
  schema creation privileges as required by the deployment), or a DBA must
  preinstall it there: `CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public`.
  Ensure `public` is in the migration search path so the extension's operator
  classes resolve; do not install it into a disposable application schema.
  An existing extension elsewhere needs DBA review, not an automatic relocation.
  Runtime writers do not need extension-install privileges. Legacy validation
  takes `SHARE ROW EXCLUSIVE` to block concurrent DML; adding the exclusion may
  require a stronger table lock and scans existing rows. Plan a bounded maintenance
  window for large tables. Contradictions raise a clear `23514` diagnostic pointing
  here, before the constraint or migration-history success row is committed.
- **SQLite:** use the ordinary migration runner, which takes `BEGIN IMMEDIATE`
  around validation, trigger installation and its history row. Contradictory
  legacy rows abort with the same remediation pointer; temporary validation
  objects are rolled back too. WAL permits readers, not two simultaneous writers;
  allow the existing busy timeout or quiesce writers for the release. A failed
  attempt changes neither provenance nor the success history. An explicit repair
  followed by retry installs both triggers; a second successful run is a no-op.

Apply migrations to a transfer/replay target before copying rows. The portable
`external_content_links` row shape and `media-identity-snapshots-v2` replay schema
are unchanged; target constraints also reject contradictory imported provenance.
This does not provide live-cutover fencing or authorize dual writers.

## Consequences

- **The seed's local state file remains legacy.** `scripts/notion-seed.ts` still
  writes through HTTP as an operator and keeps its digest file. The link table
  is the API importer's authoritative memory; the seed is not an authenticated
  preview/apply client.
- **The `imports` persistence slice owns provenance and per-work commit.**
  `getExternalContentLink`, `listExternalContentLinks` and
  `upsertExternalContentLink` remain alongside `getImportPlanGeneration` and
  `commitNotionImportWork`. Transfer/replay includes provenance but excludes the
  database-local generation and source article revision. A new target preview
  is required after cutover.
- **REST compatibility stays intact.** The existing `IMPORT_CONFLICT` code and
  per-page `refused`/`failed` actions are retained. The report gives ownership
  conflicts a distinct safe explanation; no owner IDs or raw SQL leak through it.
- **Limits stay in force:** 200 pages, an 8 MiB bundle, the separate authenticated
  plan/envelope budget, and ten imports per ten minutes per account. No test-only
  production behavior or rate-limit increase is needed.
- **Images, hierarchy and export are separate concerns.** Eligible Notion file
  images use the bounded existing copy path; covers, nesting and `Rank` remain
  reported limitations. The existing export endpoint reads the same provenance.
  An imported work remains an ordinary article for Web and Flutter clients.

## Regression evidence

`persistence/notion-page-ownership.integration.test.ts` uses both real providers:
independent SQLite worker connections to one file-backed WAL database and distinct
PostgreSQL backend PIDs with observed blocking. Both locale winner directions,
independent direct SQL transactions, INSERT/UPDATE protection, same-owner locales,
exact error classification, legacy failure/retry, eleven rollback stages per
provider and HTTP orphan-media visibility/removal are covered. Failures protect
pre-existing/shared tags, works, media references and journal state.

The #305 `transport/rest/import-version-protection.integration.test.ts` and
existing application/REST/provider-transfer suites remain in the inventory;
they cover signed preview binding, stale edits, recovery, repeated imports,
incomplete-image retries, journal grouping and database-local cutover protection.
The UI helper suite covers Chinese ownership and leftover-media guidance.
Actual results belong to the PR's verification ledger and CI checks, not to an
assumption that a PostgreSQL test skipped without `TEST_DATABASE_URL` passed.
