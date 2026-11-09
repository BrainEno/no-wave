# Copying a database to another engine (off-line)

`pnpm db:transfer` copies one whole database into an **empty** database of the
other engine — SQLite → PostgreSQL, PostgreSQL → SQLite, or either into a fresh
copy of itself. It reads the source inside a single snapshot, writes the target
inside a single transaction, and ends by comparing every table with the source.
If anything disagrees it rolls back and says so.

It is **not** a cutover. It does not capture changes made on the source while it
runs, it does not fence writes, it does not move media bytes, and it does not
merge into a database that already holds rows. Read
[What this does not do](#what-this-does-not-do) before planning a switch; the
online migration pipeline ADR 0010 asks for is still unimplemented
([#217](https://github.com/BrainEno/no-wave/issues/217)).

## Before you start

1. **Know both endpoints.** `--from` and `--to` each take `provider:target`:

   | Endpoint | Means |
   | --- | --- |
   | `sqlite:./data/no-wave.sqlite` | a SQLite file (created and migrated if absent) |
   | `postgres:postgres://user@host/db` | a PostgreSQL database |
   | `sqlite` | `DATABASE_PATH`, else `./data/no-wave.sqlite` |
   | `postgres` | `DATABASE_URL` |

2. **Stop the writer, or accept the snapshot edge.** The copy is internally
   consistent, but it ends where it started. With the API still accepting writes
   the rows written after the snapshot are simply not in the copy, and nothing
   announces that. Stop the API (and the notification worker) first: this command
   is for a maintenance window, not for a live site.
3. **Give the target its own empty database.** The transfer only migrates the
   target's schema and refuses to write a target that already contains
   application rows. Do not point `--to` at a database another environment uses.
4. **Point media at a storage backend that already has the objects.** Media rows
   are copied; bytes are not. Either reuse the same bucket/prefix or synchronise
   the objects separately, or every image in the copy will 404.
5. **Take a backup of the source anyway.** A copy that misreads its source cannot
   repair it, and a copy is not a backup.

## Rehearse on a disposable copy

```bash
# 1. Snapshot the source while nothing is writing (SQLite: copy the file).
cp ./data/no-wave.sqlite /tmp/rehearsal.sqlite

# 2. Validate the source without writing anything.
pnpm --filter @bot-thk/api db:transfer \
  --from sqlite:/tmp/rehearsal.sqlite \
  --to postgres:postgres://user@localhost/no_wave_rehearsal \
  --dry-run

# 3. Copy for real into a fresh database.
createdb no_wave_rehearsal      # or: CREATE DATABASE no_wave_rehearsal;
pnpm --filter @bot-thk/api db:transfer \
  --from sqlite:/tmp/rehearsal.sqlite \
  --to postgres:postgres://user@localhost/no_wave_rehearsal
```

A successful run prints one line per table and ends with:

```
  table                         rows     target
  auth_accounts                    1 ->       1  ok
  …
        9 rows in 25 tables
  0 media assets (the rows only — storage objects are not copied)

  Copied and reconciled: every table matches the source.
```

`--json` prints the same report as a machine-readable object (one entry per
table, with the source and target row counts and digests) and suppresses the
per-table progress lines.

## The real run

```bash
# 1. Stop the API and the workers. Nothing may write to the source.
# 2. Copy.
pnpm --filter @bot-thk/api db:transfer \
  --from sqlite:./data/no-wave.sqlite \
  --to postgres:postgres://user@production-host/no_wave

# 3. Verify (see below), then start the API with the target configured:
DATABASE_PROVIDER=postgres DATABASE_URL=postgres://… pnpm --filter @bot-thk/api start
```

`pnpm db:transfer` is the same command as
`pnpm --filter @bot-thk/api db:transfer`; the root script exists so nobody has to
remember the filter.

The target schema is migrated by the transfer before any row is written. Pass
`--no-migrate` only when you have already applied migrations as a separate
release step — the two do the same thing, and the flag exists for operators whose
process forbids a tool from touching schema.

## Reading the report

Each table is reported with a row count **and** a digest of its portable column
values, computed the same way on both sides: timestamps as UTC ISO strings,
sequences as numbers, JSON columns as parsed documents, `null` as `null`. A row
count alone would pass a copy that dropped a column or wrote a timestamp in
another shape; the digest is what catches that.

The run fails, and rolls back, when:

| Failure | Meaning |
| --- | --- |
| `TARGET_NOT_EMPTY` | the named table already has rows; nothing was written |
| `RECONCILIATION_MISMATCH` | a table's count or digest differs; nothing was kept |
| `SOURCE_READ_FAILED` | the source changed mid-copy, or a row could not be read |

Exit codes: `0` copied and reconciled (or a clean dry run), `1` refused or
failed, `2` bad usage. A `1` never leaves a partially copied target: the whole
write is one transaction.

## Verifying a copy by hand

The transfer's own reconciliation is the strongest check it can make — it
compares what it wrote against what it read. Two things it cannot know:

1. **Does the application work on the target?** Start it against the target and
   walk the journeys that matter: sign in, open an article, post a comment, list
   a conversation, upload an avatar. The integration suite already exercises the
   PostgreSQL adapter, so this is a smoke test, not a substitute for the suite.
2. **Are the media objects there?** Request a few `/media/<id>` URLs from the new
   deployment. The rows and the bytes live in different systems; only a request
   proves both.

Spot-check counts against the source with ordinary SQL if you want a third
opinion:

```sql
SELECT count(*) FROM articles;         -- compare with the report
SELECT count(*) FROM article_comments; -- the self-referencing table
```

## Rollback

**Before the new deployment accepts writes, rollback is switching back.** Keep
the source database file (or a copy of it) untouched: the transfer never writes
to the source, so it remains a valid, current database until the target accepts
its first write. Stop the new deployment, restore the old `DATABASE_PROVIDER` and
source configuration, start, and verify.

**After the target accepts writes, there is no rollback in this tool.** The copy
is one-way and off-line; it cannot reverse-capture changes from the target back
into the source. Recovering means restoring the source from its pre-cutover
backup and losing every write the target accepted since — a data-loss decision,
not an operator step. ADR 0010 lists reverse change capture and a controlled
maintenance window as the accepted options, and neither is implemented.

## What this does not do

- **No online cutover.** No change capture, no watermark, no writer fence, no
  lag monitoring. ADR 0010 remains the binding record: online cross-provider
  migration is not implemented, and changing `DATABASE_PROVIDER` is not a data
  migration.
- **No merge into a populated target.** Conflicts need a person; upserting over
  them would hide exactly the rows that matter.
- **No media bytes.** `media_assets` rows are copied, not objects.
- **No attachments outside the database.** Anything the deployment keeps beside
  the database (logs, uploads on a local disk, `.env` files) is out of scope.
- **No scheduling.** Run it yourself, in a window you chose, and read the report.

## Related

- [ADR 0033](../architecture/decisions/0033-off-line-database-copy.md) — why the
  copy is off-line and refuses a non-empty target.
- [ADR 0010](../architecture/decisions/0010-sqlite-first-and-online-provider-cutover.md)
  — the online cutover this does not claim to be.
- [Provider deployment guidance](./persistence-provider-guidance.md) — choosing a
  provider in the first place.
- [Migration plan](../architecture/postgres-migration-plan.md) — the full
  snapshot/capture/reconcile/fence protocol.
