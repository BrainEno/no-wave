# Notion import: target-version protection (not yet implemented)

A dry run currently returns a report but no binding to the target state. Apply
replans independently, then updates articles. An edit made after preview can be
replaced without warning; see the characterization test in
`apps/api/src/application/notion-import.test.ts`. The desk warns about this risk,
but the warning is not conflict protection. Direct API clients get no warning.

## Required implementation

* Preview must bind the authenticated actor, the exact selected bundle, grouping,
  all relevant source links and the target work's version (including the absence
  of a target or translation). Apply must reject missing, altered or stale plans
  before writing. A client-supplied version alone is not authority: use a
  server-authenticated token or server-side stored plan, with bounded size and
  lifetime; never expose another author's IDs. Preserve per-work results without
  claiming the entire multi-work import is atomic.
* Use a durable monotonic work revision, not `updated_at` or a hash read outside
  a transaction. Timestamps have provider-dependent precision and may collide.
  All writes affecting imported fields, editions, status, slug and taxonomy must
  advance it, including delete/restore and other write paths. Migrations, provider
  transfer and replay must preserve the invariant on SQLite and PostgreSQL.
* Check the expected revision while holding the work's write lock in the same
  transaction as the article, translation and taxonomy writes. SQLite's write
  transaction and PostgreSQL's `FOR UPDATE` must cover the comparison and write.
  Multiple editions in one work must use one work-level operation or carry each
  newly committed revision forward; a self-update must not look like an external
  conflict. A preflight check by itself leaves a check-to-write race.
* A planned create needs an atomic claim of the source identity, as does adding
  an absent translation. Create-key recovery and cross-locale provenance need to
  participate in the same concurrency design; an article appearing after preview
  must not silently turn create into update. Handle interrupted link writes and
  existing historical conflicts without changing historical data automatically.
* Check before tag creation or image copying where possible. If media preparation
  must precede the locked write, a late conflict must never write the article and
  must report any possible orphan asset. A conflict should explicitly ask the
  author to preview again, and distinguish partial success from total rejection.

## Minimum verification

Exercise edit, rename, delete/restore, taxonomy and new-translation changes both
between preview and apply and concurrently after the initial check. Include two
simultaneous imports, multi-edition works, two authors, recovery after missing
links, tampered/expired plans and changed selection. Assert no stale overwrite on
both database providers, no conflict-created tag or link where feasible, and the
correct UI explanation. Run browser and provider-migration tests in CI.

## Progress: database-local revision groundwork

Migrations 0034 (PostgreSQL) and 0021 (SQLite) add `articles.import_revision`.
Triggers advance it for work fields, edition writes, and taxonomy links; view
counts do not advance it, and transaction rollback rolls it back. The importer
**does not read or compare it yet**, so this does not prevent overwrites. Normal
writes may increment it more than once, which is fine: callers must compare for
equality, not infer edit counts. Provider transfer/replay currently does not
preserve this counter as an externally portable identity. Before using it in a
plan, bind plans to a database/deployment generation so pre-cutover plans cannot
be accepted against a different database, and test migration/replay thoroughly.
