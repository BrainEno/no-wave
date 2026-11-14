# ADR 0038: Engagement notifications have a lifetime identity and outbox retries have a terminal state

- Status: Accepted
- Date: 2026-11-12
- Scope: Issues #325 and #327; SQLite and PostgreSQL notification persistence, delivery and provider migration

## Context

A like/follow toggle used a fresh UUID in its event key. The notification table's
recipient/event-key uniqueness therefore did not prevent a single reader from
filling an author's inbox by undoing and repeating the same action. Meanwhile a
poison outbox event retried every 30 seconds forever. A worker-only retry counter
would still loop if a process died during its final delivery lease.

## Decision

1. A like has one notification identity for `(recipient, articleId, actorId)`;
   a follow has one for `(recipient, followerId)`. This is a lifetime-history
   policy, not a cooldown. Set/toggle, unlike/re-like, unfollow/re-follow, locale
   changes and concurrent requests share that identity. Different works, actors
   and recipients remain distinct. Self-likes stay silent.
2. New keys are `engagement:v1:like:<articleId>:<actorId>` and
   `engagement:v1:follow:<followerId>`, scoped by the existing recipient/key UNIQUE
   constraint. The separate namespace cannot collide with old random suffixes,
   even when an opaque actor ID contains colons and a UUID. An indexed
   payload-identity lookup also recognizes old randomized
   keys. Do not split actor IDs on colons, delete existing duplicates, rewrite
   payloads, revive unread state or refresh creation times. Historical duplicates
   remain visible history, but do not cause another notification after upgrade.
   Capture a notification only when it was actually inserted.
3. Every claim spends one persisted attempt, including an abandoned lease. Both
   the worker and bounded drain use the same validated policy: base delay 30 s,
   doubling after each failed attempt, capped at 86400 s; maximum 8 attempts.
   Configurable bounds are base/cap 1–86400 s and budget 1–100; cap must be at
   least base. Attempt 8 may succeed; a failure on that attempt becomes terminal.
4. `dead_lettered_at` is durable and mutually exclusive with delivery or a live
   lease. Failure settlement is lease-token fenced, checked after taking the row
   lock against the database clock. It uses the database's attempt count, not a
   caller-supplied count. A stale/expired lease cannot retry or quarantine work.
5. Claim also quarantines **expired** exhausted rows, even after a crash without
   a failure callback. It sweeps at most 100 such rows per transaction and selects
   normal work independently with `attempts < maxAttempts`. A poison backlog
   cannot monopolize selection. Live final leases are not quarantined. A higher
   configured budget never revives an already persisted dead letter.
6. Pending count/age exclude dead letters but include delayed and leased work.
   `deadLetterEvents` and `api_outbox_dead_letter_events` report retained terminal
   rows. Separate partial indexes and a single-snapshot query keep sampling off
   delivered history. Failure logs expose safe classes and transition metadata, never exception
   messages or payloads. Batch/drain `deadLettered` counts confirmed transitions
   from delivery failures; crash-recovery quarantine is visible in the durable
   backlog gauge, not attributed to a delivery callback that never ran.
7. Claim, retry, quarantine and their migration journal snapshots commit together.
   Portable outbox rows require an explicit nullable `dead_lettered_at`. Replay
   wire version is `notification-integrity-v3`; older sessions cannot be relabeled
   or resumed. Offline copy includes terminal state and normalizes PostgreSQL
   `Date` values before validating/binding rows on either provider.

## Rollout, recovery and limits

Stop API writers, workers, drains and migration jobs before applying PostgreSQL
0037 / SQLite 0024; then restart all of them with this version and identical retry
settings. Do not mix old binaries: they do not filter terminal rows. Existing
pending/delivered/live-leased data is not rewritten; exhausted old rows are
quarantined only when due. Rebuild and reconcile any pre-v3 replay target from a
coordinated baseline rather than modifying a session's version string.

Dead letters are retained for restricted operator inspection. There is no public
redrive/delete endpoint and no automatic reset or retention purge. Investigate
and repair the underlying event before separately approving any replay; delivery
remains at least once, not exactly once, and existing notification idempotency
must be retained. Lease heartbeats, multi-replica deployment coordination and a
production rollout are not added or authorized by this decision.
