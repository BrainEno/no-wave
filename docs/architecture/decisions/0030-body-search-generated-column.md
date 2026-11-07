# ADR 0030: Body search reads a generated column, not the JSON blocks

- Status: Accepted
- Date: 2026-11-07

## Context

`listPublishedArticles` searches a work by title, summary and body. Titles and
summaries were made indexable in migration 0009 with `pg_trgm` GIN indexes, which
is what turns `ILIKE '%term%'` from a scan into a bitmap index lookup. The body
was not.

The body lives in `article_translations.content_blocks`, a JSONB array of blocks.
The query matched it block by block:

```sql
EXISTS (
  SELECT 1 FROM jsonb_array_elements(t.content_blocks) AS block(value)
  WHERE jsonb_typeof(block.value) = 'object' AND (block.value->>'text') ILIKE $2
)
```

A set-returning function inside the predicate cannot be served by an index: the
planner has to expand the array for every candidate row and compare each block.
So every body search — which is every search with a term — scanned every
published translation of the locale and walked its JSON. The engineering review
(F-23) recorded it as the last search defect after title/summary were indexed.

Two properties had to survive, because a contract test pins both: the body adds
hits without replacing title/summary, and the *storage* is not *content* — a
search for `paragraph` finds nothing, because it appears in the JSON keys and
block types, not in what a reader wrote.

## Decision

The text of the blocks is materialised in a **stored generated column**,
`article_translations.content_search_text`, and indexed with `pg_trgm`
(migration 0027). The query searches the column instead of expanding the array.

```sql
content_search_text text
  GENERATED ALWAYS AS (
    jsonb_path_query_array(COALESCE(content_blocks, '[]'::jsonb), '$[*].text')::text
  ) STORED
```

Why a generated column rather than the alternatives:

- **A column the application writes** would be the third place that has to know
  about blocks (create, update, and every replay path in the provider-migration
  machinery), and the failure mode is silent: a stale index row means a work
  stops being findable, and nothing errors. `GENERATED ALWAYS` cannot drift —
  whichever path writes `content_blocks`, PostgreSQL recomputes the column.
- **An expression index** (`CREATE INDEX … ON ((jsonb_path_query_array(…)::text))`)
  needs no schema change, but the query must then repeat the expression exactly.
  Two copies of one expression is the bug this decision is trying to avoid; a
  column has one definition and one name.
- **A trigger** also keeps the column current, but it is procedural code plus a
  backfill, where the generated column is a data definition the planner
  understands.
- **Full-text search** (`to_tsvector` + `ts_zh`/`ts_en`) would change what a
  search *means*: word-boundary matching with stemming instead of substring
  matching, and Chinese tokenisation without a dictionary. That is a product
  decision, not a performance fix, and the current contract test asserts substring
  behaviour (`雨` matches `下着雨`) that a tokeniser would not guarantee. Not taken
  here — and if it is ever taken, it is a new ADR, not a migration.

## Consequences

- **Search is indexable again**: the query names `content_search_text`, the
  planner can answer it from `article_translations_content_search_trgm_idx`, and
  a PostgreSQL integration test asserts both the column definition and that the
  planner uses the index when sequential scans are disabled.
- **Storage grows**: the table now holds the body text twice, once as JSON and
  once as a string. It is TOAST-compressed like the JSON, and it is the price of
  not walking that JSON per row per search.
- **Two narrow behaviour differences**, both documented in the migration and both
  narrower than the scan they replace: a term can no longer match across two
  blocks (the old query compared one block at a time, so it could not either), and
  a term containing a double quote inside a single block is escaped in the
  materialised text and will not match.
- **SQLite keeps scanning.** A single-host SQLite file has no trigram operator
  class, and an FTS5 side table would have to be kept in step with every write
  path for a search whose cost is bounded by one machine's content. The contract
  suite runs every search test against both adapters, so the two agree on
  *results*; they differ only in how the PostgreSQL one is found.
- **The column is not portable domain data.** The provider-migration protocol
  copies the columns a row carries, and this one is computed from another of them,
  so it is declared as a *derived* column in the migration entity spec: capture
  does not read it, replay does not write it, and a migration into SQLite leaves
  no trace of it. The schema-parity test still compares each provider's real
  column list against "portable plus derived", so a column cannot appear in
  either schema without being declared somewhere.
- **Deployments need the `pg_trgm` extension**, which migration 0009 already
  required for titles and summaries. Managed providers enable it with the
  migration's `CREATE EXTENSION`; a restricted host must pre-install it or the
  migration fails at the same point it always did.
