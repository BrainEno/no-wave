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
| Public list read, page of 20 | **~150–185 req/s** | 38–45 ms | 80–102 ms |
| Authenticated write (create work) | **~1,600–1,900 writes/s** | 0.3–0.4 ms | 1.1 ms |
| Message send (incl. outbox, worker running) | **~4,100–4,500 messages/s** | 0.2 ms | 0.3 ms |

Measured on the SQLite provider, one process, one database file on local disk, over
three consecutive runs of the same commit. The repository's CI runner is slower; do
not copy these numbers into a capacity plan without re-running on the hardware you
will actually deploy.

## The finding that matters: read throughput does not scale with concurrency

The concurrency ladder is the point of this document. On one process with a
synchronous SQLite driver, throughput is flat from a single request in flight:

```
c= 1    172 req/s
c= 2    176 req/s
c= 4    187 req/s
c= 8    186 req/s
```

Doubling in-flight requests does not produce more completed reads — it produces more
waiting. p50 rises roughly proportionally to concurrency (about 6 ms at c=1, about
43 ms at c=8) while completed requests per second stays where it started.

Two consequences:

1. **One instance is a single lane.** Adding concurrent users to one process buys
   latency, not capacity. Capacity beyond the ceiling above requires more instances
   with a shared PostgreSQL provider — not a bigger process.
2. **Latency under load is predictable.** Since the queue is FIFO and the service
   time is stable, p50 ≈ concurrency × 6 ms for the list endpoint. An operator who
   sees p50 of 200 ms at peak is looking at ~30 concurrent readers, not at a
   regression.

That 6 ms per read breaks down as ~1.1 ms of fixed request overhead plus ~0.24 ms per
article in the page. The per-article part is real work, not an N+1 across the
catalogue: read cost is flat in the **total** number of works (200 vs 800 published
works measured within noise) and linear in **page size** (1.4 ms at `limit=1` →
10.7 ms at `limit=40`). Per page of 20, the serializer issues three lookups per
article (author, categories, tags) — fixed per page, so bounded, but it is the
dominant term in read cost. See "Known cost centres" below.

## Recommended ceiling per instance

Derived from the measured throughput, with headroom so that normal peaks do not sit
at the saturation point:

| Readers (concurrent, list pages) | Read latency to expect (p50) | Verdict |
| --- | --- | --- |
| up to ~10 | ~60 ms | comfortable |
| ~10–25 | 60–150 ms | acceptable; latency starts to be visible |
| ~25–40 | 150–250 ms | at the edge; page views feel slow |
| beyond ~40 | > 250 ms | add an instance; do not add concurrency to this one |

Writes are not the constraint. At 1,600+ writes/s the single writer is far beyond
what a writing community produces; a self-hosted instance will exhaust read capacity
long before write capacity.

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

- **Three lookups per article in the list serializer** (author, categories, tags).
  Fixed per page, but the largest single term in read cost. A batched variant would
  move the 0.24 ms/article term.
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
