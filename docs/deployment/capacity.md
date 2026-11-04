# Capacity: what one instance actually does

This document states a measured ceiling and how it was derived, so an operator can
answer "is one instance enough for my readership" without guessing, and so the
ceiling is visible when a future change moves it.

Everything here comes from `pnpm perf:baseline` (see
[the performance baseline](../testing/strategy.md#performance-baseline) for what it
measures and why writes are driven in-process). Reproduce with:

```bash
pnpm perf:baseline --json
```

## The short version

| Workload | Throughput on one instance | p50 | p95 |
| --- | --- | --- | --- |
| Public list read, page of 20 | **~510–600 req/s** | 11–12 ms | 24–29 ms |
| Authenticated write (create work) | **~2,200 writes/s** | 0.3 ms | 0.6 ms |
| Message send (incl. outbox, worker running) | **~4,400 messages/s** | 0.2 ms | 0.3 ms |

Measured on the SQLite provider, one process, one database file on local disk, over
three consecutive runs of the same commit. The repository's CI runner is slower; do
not copy these numbers into a capacity plan without re-running on the hardware you
will actually deploy.

## How read capacity moved when the serializer stopped amplifying

The first version of this baseline (before #162) found read throughput **flat** in
concurrency: c=1 already produced ~172 req/s and c=8 produced ~186, while p50 grew
from 6 ms to 43 ms. Adding readers bought only waiting, because each read performed
`1 + 3N` synchronous statements — the serializer asked three questions per article
(author, categories, tags), so a page of 20 blocked the event loop 61 times.

#162 replaced that with a prefetch: one statement for the page's distinct authors,
one for its category links, one for its tags — three prepares at any page size. The
measured effect:

| | Before #162 | After #162 |
| --- | --- | --- |
| Statements for a page of 20 | 61 | 4 (1 list + 3 prefetch) |
| Statements for a page of 100 | 301 | 4 |
| p50 at c=8 | 44.9 ms | 11.0 ms |
| p95 at c=8 | 102.8 ms | 23.6 ms |
| Throughput at c=8 | 143 req/s | 600 req/s |
| Ladder | flat from c=1 | rises to c=2, then flat |

The ladder is the interesting part:

```
c= 1    511 req/s     <- used to be the ceiling
c= 2    649 req/s
c= 4    653 req/s
c= 8    633 req/s
```

Saturation moved from "a single request in flight" to `c=2`. Concurrency now buys
capacity up to that point instead of only queueing. It still flattens afterwards, so
the structural statement from the first version holds: one process is still a bounded
lane, and capacity beyond it needs more instances on PostgreSQL, not a bigger
process.

**Latency under load is still predictable.** With FIFO queueing and stable service
time, p50 ≈ concurrency × 5.5 ms for the list endpoint. An operator seeing p50 of
200 ms at peak is looking at roughly 35 concurrent readers, not at a regression.

### Two cost centres that remain

- **Per-article projections.** The batch made the statement count constant, not the
  work: the serializer still assembles author, categories and tags per article in
  memory. That is now in-memory cost rather than SQL round trips, and it is why a
  `limit=100` page still costs more than a `limit=20` one. Measured read cost is flat
  in the **catalogue** size (200 vs 800 works within noise) and grows with page size.
- **Synchronous SQLite calls occupy the event loop.** This is why the ladder still
  flattens at c=2. It is intrinsic to the single-file provider; the PostgreSQL
  provider does not share it.

## Recommended ceiling per instance

Derived from the measured throughput, with headroom so that normal peaks do not sit
at the saturation point:

| Readers (concurrent, list pages) | Read latency to expect (p50) | Verdict |
| --- | --- | --- |
| up to ~10 | ~55 ms | comfortable |
| ~10–35 | 55–190 ms | acceptable; latency starts to be visible |
| ~35–60 | 190–330 ms | at the edge; page views feel slow |
| beyond ~60 | > 330 ms | add an instance; do not add concurrency to this one |

These are roughly 1.5× the pre-#162 reader counts for the same latency, which is the
capacity the serializer fix bought. Writes are not the constraint: at 2,200+ writes/s
the single writer is far beyond what a writing community produces, so a self-hosted
instance exhausts read capacity long before write capacity.

### The outbox worker keeps up

The message path was measured with the worker draining concurrently as a separate
process. Across runs, 120 messages produced ~129 undelivered events at the end of the
write burst, all of which were delivered within the 2 s drain window that follows.
The worker is therefore **not** a bottleneck at the write rates above. If a run ever
leaves events undelivered after the drain window, the writer has outpaced the worker
and the run fails — treat that as the real write ceiling.

## PostgreSQL deployments

The numbers above are SQLite. PostgreSQL decouples reads from the event loop (async
drivers), so read concurrency does scale and the flat-ladder finding does not apply.
**No PostgreSQL capacity measurement is published here**, because the project does
not have a PostgreSQL instance in its local or CI verification path and inventing
numbers for it would be worse than stating the gap. To measure one, run the same
harness with `DATABASE_PROVIDER=postgres` and `DATABASE_URL` set against the target
instance, then record the ladder it prints.

## Known cost centres

These are visible in the baseline and are candidates for a future change, not
regressions:

- **Per-article assembly in the list serializer.** The lookups are batched (#162), but
  the projection is still built article by article.
- **Synchronous SQLite calls occupy the event loop.** This is why the read ladder is
  flat. It is intrinsic to the single-file provider; the PostgreSQL provider does not
  share it.
- **Per-request structured logging.** Every completed request writes one JSON line to
  stdout. On this hardware that is part of the ~1.1 ms fixed cost; a deployment that
  pipes stdout somewhere slow will see it grow.

## Re-measuring

Run the baseline before and after a change that plausibly touches cost:

```bash
git switch <before>
pnpm perf:baseline --json > before.json
git switch <after>
pnpm perf:baseline --json > after.json
```

Compare `p95` and throughput per scenario. An order-of-magnitude move deserves an
explanation in the pull request; a few percent is runner noise.
