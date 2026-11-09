# ADR 0033: Moving a database means an off-line copy, and the target starts empty

- Status: Accepted
- Date: 2026-11-09

## Context

ADR 0010 chose SQLite-first persistence and described an online cutover: a
consistent snapshot, a durable change journal, reconciliation, a writer fence and
a rehearsed switch. The journal half of that exists — session tables, ordered
change envelopes, checkpointed replay, a replayer with an explicit allowlist —
and then stops at the first step it cannot invent: **there is no snapshot**.

The consequence was visible to users of the project rather than to its tests.
Moving a real SQLite site to PostgreSQL meant reading the schema, writing INSERT
statements by hand, and discovering the mistakes later: a JSON column that came
across as text, a `bigint` sequence read as a string, an `article_media_refs`
row nobody remembered because it is not an entity. Nothing in the repository
could produce a complete, verified copy of a database (#247), and no test could
prove that a copy was complete.

An honest online cutover needs change capture, fencing and reverse capture. None
of those can be built on top of a snapshot that does not exist, and shipping a
half-online design would be worse than shipping an offline one that says what it
is.

## Decision

**Ship the snapshot as its own tool, scoped to what it can actually guarantee.**

`pnpm db:transfer` (`apps/api/src/persistence/db-transfer.ts`, the work itself in
`provider-migration-transfer.ts`) copies a whole database into an empty one:

- **One snapshot on the source, one transaction on the target.** SQLite reads
  inside `BEGIN`; PostgreSQL inside `REPEATABLE READ READ ONLY`. The target is
  written inside one transaction, so the outcome is all rows or none. A
  half-copied database is the most dangerous outcome available, because it looks
  finished.
- **The target must be empty.** The check runs before the first write and names
  the first table that is not. Merging into a populated target is the
  conflict-resolution problem the journal protocol has not solved; upserting over
  it would silently choose a winner for every conflicting row.
- **Rows go through the journal's own allowlist.** Every row is validated by
  `prepareMigrationRowPayload`, the function the replayer uses, so the copy
  cannot contain a shape replay would reject, and adding an entity to the
  allowlist without adding it to the transfer fails a test instead of quietly
  leaving a table out.
- **Reconciliation is counts *and* digests.** Each table is hashed over its
  portable columns after normalisation (timestamps to UTC ISO strings, sequences
  to numbers, JSON to parsed documents). This is the part that makes the tool
  worth having: SQLite hands back the text it stored, PostgreSQL hands back
  `Date` and `bigint`-as-string, and a copy that compares raw driver values would
  report a false mismatch, while a copy that compares only counts would pass a
  table with a dropped column.
- **The command is explicit about both ends.** `--from` and `--to` each take
  `provider:target`. A copy where one end is "the environment" is a copy that
  eventually runs against production because a shell had an old `DATABASE_URL` in
  it.

## What this deliberately does not claim

- It is **not** an online cutover. It captures no changes, holds no fence and
  monitors no lag. ADR 0010's "online cross-provider replication/hot cutover: not
  implemented" stands, and the runbook repeats it in the operator's own words.
- It does **not** copy media bytes. Rows reference objects in storage; the
  deployment must reuse or synchronise that backend.
- It does **not** provide rollback once the target accepts writes. Before that
  moment, rollback is switching back to an untouched source — which is why the
  tool never writes to the source.
- It does **not** merge, migrate in the background, or run on a schedule.

## Consequences

- **A maintenance window is required.** Quiesce, copy, verify, switch. Running
  against a live source produces a consistent but *stale* copy, and the only
  signal that it is stale is the operator knowing that.
- **The journal's first precondition becomes satisfiable.** `prepareMigrationReplayTarget`
  refuses a target whose media and identity baselines are not empty; a full copy
  is exactly the state it demands, so incremental replay can start from a
  snapshot this repository can now produce.
- **The reconciliation is reusable for the cutover that does not exist yet.**
  Digest-per-table and normalisation across engines are the comparison half of an
  online migration, written against the same allowlist.
- **One table is not an entity.** `article_media_refs` is written with the
  translation that owns it, as the journal protocol already treats it, and
  reconciled separately. It must not be added to the entity order.
- **The tool refuses more than it does.** Non-empty target, unknown option, same
  file on both ends, unsupported provider: each fails with a code and writes
  nothing. Being the safe default for a person under pressure is the point.
- **Tests pin the behaviour that matters**: SQLite → SQLite (plan, identity,
  media snapshot, self-referencing comments), SQLite → PostgreSQL (cross-engine
  reconciliation, refusal, dry run), and a mid-copy failure leaving the target
  empty on both engines.
