# Read-only single-provider media materialization audit

## Purpose and safety boundary

This is an **opt-in internal diagnostic for one database**, not a repair, deletion check, reconciliation protocol or cutover gate. Unlike the separate [cross-provider comparison](provider-migration-media-comparison.md), it reads article bodies and avatar URLs to identify some inconsistencies between those values, asset IDs and materialized references *within that database*. In particular, it can report a reference omitted on both providers, which two equal reference tables alone cannot reveal. Run it separately on each disposable database; the results are not a synchronized source/target comparison.

`auditProviderMediaMaterialization` in `apps/api/src/persistence/provider-migration-media-audit.ts` has no HTTP route, UI, CLI or automatic invocation. A trusted test harness passes either `{ provider: "sqlite", sqliteFilename }` for an existing SQLite file or `{ provider: "postgres", postgres }` for a `PgDatabase` pool. The caller chooses the intended database and trusted schema/search path, owns the pool, and must close it. Use only isolated, disposable fixtures for now; this has **not** been qualified at production scale and is not a production runbook.

A zero count is **not** evidence that media can be deleted, that either database is complete, that a target is caught up, or that production cutover is safe. There is no initial snapshot importer, complete write capture, source watermark, coordinated snapshot, writer fencing, repair or rollback here. It does not verify schema/trigger or foreign-key definitions, source ownership, permissions, account/role identity, other tables, file bytes or object-store availability. [#217](https://github.com/BrainEno/no-wave/issues/217) remains open.

## What is counted

The result is tagged `media-materialization-audit`, identifies the provider, and contains aggregate counts only. It includes all selected translation rows, including drafts and tombstoned articles, without joining `articles`. A profile is selected if `avatar_url` **or** `avatar_media_id` is non-null, including an empty URL; a profile with both null is excluded.

`scanned` reports selected `assets`, `translations`, `articleReferences`, and `profiles`. The other counters have these precise meanings:

| Counter | Unit and meaning |
| --- | --- |
| `articles.missingReferences` | Per translation and distinct matched ID: the asset exists, but no `(article_id, locale, asset_id)` row exists. |
| `articles.unexpectedReferences` | Per materialized row with a matching translation: its exact asset ID is not among the IDs matched in that translation's body. A dangling row may also be unexpected. |
| `articles.referencesWithoutTranslation` | Per materialized row with no matching `(article_id, locale)` translation. These rows are **not** also counted as unexpected; a missing article is included in this category, not separately diagnosed. |
| `articles.missingAssets` | Per translation and distinct matched ID: the ID is absent from `media_assets`, regardless of whether a dangling materialized row exists. |
| `articles.danglingAssets` | Per materialized row: its exact asset ID is absent from `media_assets`, including rows without a matching translation. |
| `avatars.missingReferences` | Per selected profile and distinct matched ID: the asset exists, but the single `avatar_media_id` is not that ID. |
| `avatars.unexpectedLinks` | Per selected profile: a non-null `avatar_media_id` does not occur among the IDs matched in its URL, including when the URL is null. A dangling link may also be unexpected. |
| `avatars.missingAssets` | Per selected profile and distinct matched ID: the ID is absent from `media_assets`. |
| `avatars.danglingAssets` | Per selected profile: a non-null `avatar_media_id` is absent from `media_assets`. |

Counters can overlap and need not add up to the number of scanned rows. Repeated occurrences of an ID in one body or URL count once; the same ID in two translations counts once for each translation. No ID, title, slug, body, URL, asset metadata or row is returned.

Matching deliberately uses the application's shared, case-insensitive `/media/<uuid>` pattern over the entire serialized body or URL, with matched IDs lowercased. It is a **text match**, not an image-block parser or a URL fetch: it can match in code, text or an external host's URL, and an unrelated external URL with that path can produce an unresolved or missing-reference count. Percent-encoded paths and other unrecognized representations are not discovered. A URL containing multiple matched IDs can produce multiple `avatars.missingReferences` even though the schema stores only one ID. The existing avatar writer uses a `LIKE` match and `LIMIT 1`, not this multi-ID audit rule, so such a count is not by itself proof that the writer violated its own selection rule.

After validating array syntax, SQLite scans its stored JSON text and PostgreSQL scans the server's `content_blocks::text` JSONB rendering, matching their respective raw media-store scans. For example, JSON-escaped slashes are invisible to SQLite's literal-text scan but may become visible after PostgreSQL JSONB decoding. The article writers instead scan their input serialization when materializing references; this audit compares the current persisted representation, not the historical input used at write time. It validates array syntax, not each block's full domain semantics. All asset IDs must be canonical lowercase 36-character UUIDs supported by the shared pattern (version nibble 1–8, variant 8/9/a/b); unsupported historical IDs fail the entire run rather than being silently omitted. Materialized dangling IDs themselves need not be canonical and are counted as exact strings.

## Privacy, snapshots and failure handling

The audit reads private unpublished and deleted content, URL strings, IDs and reference keys **into server-process memory**. It does not deliberately log or return them, and `ProviderMediaAuditError` retains no underlying database error, cause, SQL parameters or path. Nonetheless, aggregate counts may reveal sensitive operational information. Restrict who can invoke the function and receive or retain results; never expose it via an unauthenticated endpoint or indiscriminately log counts. Use a dedicated least-privileged pool with driver query/debug/notice logging disabled or sanitized. Database/server audit logs, custom policies/functions and caller instrumentation are outside this function's control and may still expose data.

- SQLite uses a new read-only connection, `query_only`, and a read transaction pinned by a real table read. It rejects in-memory and `file:` URI paths and does not create a missing database. It rolls back and closes on success or failure. SQLite/WAL may still use filesystem sidecars; read-only refers to database data.
- PostgreSQL uses one `REPEATABLE READ READ ONLY` transaction. Before pinning it takes read-compatible `ACCESS SHARE` locks on `media_assets`, `article_media_refs`, `user_profiles` and `article_translations`; normal writes can proceed, but DDL and `TRUNCATE` cannot replace an unread table during the scan. `row_security = off` makes a role subject to row filtering fail rather than silently auditing a filtered subset. This is not a verification of grants, policies or schema provenance. The caller needs appropriate read privileges and is responsible for the trusted search path.
- SQLite text is decoded as strict UTF-8, and SQLite database plus PostgreSQL server/client encodings must be UTF-8. Malformed, oversized, unsupported or non-array bodies fail closed. All failures return a fixed error (`INVALID_OPTIONS`, `INVALID_DATA`, `ROW_LIMIT_EXCEEDED`, `REFERENCE_LIMIT_EXCEEDED`, `TIME_LIMIT_EXCEEDED`, or `DATABASE_READ_FAILED`), **never a partial result**. A database statement timeout can report `DATABASE_READ_FAILED`; the elapsed deadline is best-effort.

## Resource limits

The asset ID membership set is capped by the per-table row limit; sorted translation and reference cursors are merged without retaining all articles. A translation cursor page holds at most one body. Defaults and hard maxima are:

| Bound | Default | Maximum |
| --- | ---: | ---: |
| Rows per selected table | 100,000 | 100,000 |
| Rows per ordinary page | 100 | 500 |
| UTF-8 bytes per serialized body | 4,194,304 | 4,194,304 |
| Distinct matched IDs per body or URL | 5,000 | 5,000 |
| Elapsed time | 30 seconds | 30 seconds |

These can be lowered through `maxRowsPerTable`, `pageSize`, `maxBodyBytes`, `maxReferencesPerDocument` and `maxDurationMs`. Other selected text fields are capped at 16 KiB. SQL-side guards reject oversized values before returning them to the client, and cursor positioning does not send content or private IDs as query parameters. Decoding and JSON parsing can create additional transient copies, so the body limit is not a total process-memory limit.

The database may still scan or sort more than the row limit, generate large JSONB text, use temporary storage, or retain WAL/MVCC history while the snapshot is open. The elapsed deadline cannot interrupt a synchronous SQLite operation, an in-flight PostgreSQL statement or waiting for a pool connection. SQLite's busy wait is capped at two seconds; PostgreSQL statements are capped at ten seconds unless the connection already imposes a stricter timeout. These are guardrails, **not** bounded database work or a production performance guarantee. Investigate failures in an appropriately protected environment; never treat an incomplete run as a clean result.
