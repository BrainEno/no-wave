# Hosting Qualification — Zero-Cost / No-Card Gate

- Date: 2026-10-29
- Gate defined in: [ADR 0012](../architecture/decisions/0012-portable-web-framework-migration.md) (decision 8) and [migration roadmap §3](frontend-portability-migration.md)
- Verdict: **PASS. Web, database and object storage each have a cardless, zero-cost, hard-stop candidate; the notification worker has a documented gap.**

## 1. What the gate actually demands

A candidate must, *in writing and by observable product behavior*, allow:

1. signup **and** deployment without a card, trial payment method, or billing preauthorization;
2. staying at $0 with a **hard stop** instead of an automatic paid overage;
3. public HTTPS and a Node.js runtime able to serve the React Router 7 production build;
4. network access to a durable database and private object storage;
5. durable media/database storage across restart, redeploy and idle sleep;
6. a durable path for the notification outbox worker (or a scheduler-compatible drain);
7. a documented failure mode where an exhausted free instance degrades safely.

Evidence rule from ADR 0012: *"documentation and a free-price badge alone are insufficient evidence."* No live deployment was created in this round (that would need an owner-approved account and DNS is out of scope), so the table below separates **verified published terms** from **unverified runtime behavior**. The runtime rows stay unchecked until a disposable deployment is actually run — which is Phase 6, not this round.

## 2. Candidate: Web SSR host

| Candidate | No card | Zero cost with hard stop | Node SSR fit | Verdict |
| --- | --- | --- | --- | --- |
| **Render — Free web service** | Yes, free instance needs no payment method | Yes: 750 instance hours/workspace/month, 512 MB RAM / 0.1 CPU; services suspend after 15 min idle; without a card, overage suspends service instead of billing | Yes: plain Node container/`node server.js`, exactly what `apps/web-rr/server.ts` already produces | **Primary candidate — qualified on published terms** |
| Netlify — Free | Yes, free plan needs no card | Yes: 300 credits/month, hard monthly cap, site *pauses* (not billed) when credits run out | Yes, but through Netlify's own RR7 preset/adapter | **Secondary — needs adapter-specific code, so not used for Phase 3** |
| Cloudflare Workers/Pages — Free | Yes | Yes: 100k req/day, 10 ms CPU/req, 128 MB | Poor: V8 isolate, no `node:http` server, 10 ms CPU ceiling | Conditional only; would force a different SSR shape |
| Vercel — Hobby | Yes | Yes | Yes | **Excluded**: Hobby is non-commercial only; the site may carry ads/monetization |
| Railway | Trial is cardless | **No durable free stop** in practice ($5 one-time, then $1/month credit; card for anything beyond) | Yes | **Excluded for the long-term target**: cannot host this app at $0 indefinitely |
| Fly.io | **No** — card required, no free tier for new users | n/a | Yes | **Excluded** |
| Heroku | Eco is $5/mo, payment upfront | No | Yes | **Excluded** |

Decision: **Render free web service is the qualified target for the Web SSR process.** It satisfies the gate on published terms, it needs no provider-specific code inside business logic (a plain `node server.js` listening on `0.0.0.0:$PORT`), and its cold-start behavior (30–60 s wake after 15 min idle) is explicitly acceptable under ADR 0012.

Consequences to design against, not to paper over:

- **Cold start**: public pages must serve from SSR without a client-only data fetch, or a cold wake becomes a blank page. Phase 3 already requires meaningful server HTML.
- **0.1 CPU / 512 MB**: no image transcoding in the Web process, no long-lived in-process workers — consistent with Phase 5's requirement that the outbox worker be a separate process.
- **Ephemeral disk**: Render's free instance disk is *not* durable and must never hold the SQLite file or uploads for a hosted deployment (ADR 0012 decision 6).
- **No card on file**: exceeding free bandwidth/instance hours suspends the service until the next month. Acceptable failure mode (hard stop, no surprise bill), and it must be documented in the operations guide.

## 3. Candidate: database

| Candidate | No card | Limits | Verdict |
| --- | --- | --- | --- |
| **Neon Free Postgres** | Yes | 100 CU-hours/project/month, 0.5 GB storage/project, 10 branches, forced scale-to-zero (5 min), 5 GB egress, hard cutoff at the limit | **Qualified** — matches the existing `postgres` adapter |
| Render Postgres Free | Yes | 256 MB, **expires after 90 days** | **Excluded for hosting**: a 90-day expiry is not durable storage |
| Self-hosted SQLite on the Web instance | Yes | n/a | **Excluded**: instance disk is ephemeral; SQLite stays the local/default adapter per ADR 0010 |

Decision: **Neon Free** is the qualified durable database for a hosted deployment, used through the existing PostgreSQL adapter. The hard cutoff is a real constraint: hitting 100 CU-hours suspends the DB until the cycle resets, so the operations guide must include a usage check and a recovery step. This validates Neon as *implementation* only — ADR 0012 decision 6 explicitly refuses to treat the pre-existing Neon integration as proof.

## 4. Candidate: private object storage (media) — **PASSES via Neon Object Storage**

| Candidate | No card | Notes |
| --- | --- | --- |
| **Neon Object Storage** | Yes — the Free plan needs no payment method | 5 GB per project, S3-compatible (AWS SDK/boto3/CLI), private buckets, presigned URLs, branch-scoped credentials, objects branch copy-on-write with the database |
| Cloudflare R2 (10 GB free) | **No** | R2 is a usage-based service; activating it requires a payment method / billing profile even inside the free allowance |
| Render persistent disk | **No** | $0.25/GB/month |
| Instance-local disk | n/a | Ephemeral — forbidden as the only copy |

Verified on Neon's own documentation (object-storage overview, plans, and pricing, read 2026-10-29):

- **Free plan allowance**: 5 GB Object Storage *per project*, available on every plan including Free; storage is metered at `$0.023/GB-month` on paid plans with **no per-operation charge**; egress counts against the project's transfer allowance (5 GB/month on Free, shared with Postgres and Functions).
- **Object size**: 5 GiB per single-request upload, 10 GiB per multipart upload. Article images are normalized to WebP and capped at 8 MiB by the API, so this is not a constraint.
- **Regions**: `aws-us-east-2`, `aws-us-east-1`, `aws-eu-central-1`, `aws-ap-southeast-1`. The project must be created in one of them.
- **Failure mode**: throttling returns `503 SlowDown`; Neon documents "back off and retry" rather than requiring a paid tier.

**Result: the media part of the gate now passes**, so no ADR violation occurs in continuing media work. Two properties of the adapter matter for this provider and were added/hardened this round:

1. `requestChecksumCalculation: "WHEN_REQUIRED"` on the S3 client — the flexible-checksum trailer the SDK adds by default is rejected by S3-compatible stores, Neon's included.
2. Bounded retry (`withStorageRetry`, 3 attempts, 100/200 ms backoff) for `SlowDown` / `RequestTimeout` / `Throttling` / HTTP 429 / 503 on the three idempotent operations (`putObject`, `getObject`, `deleteObject`). Non-retryable errors (bad key, credentials, checksum) still fail on the first attempt so misconfiguration is not masked.

Configuration stays provider-neutral (`MEDIA_S3_*` with `AWS_*` fallbacks, path-style addressing); see [Neon deployment](../operations/neon-deployment.md) and ADR 0011. No Neon-specific code exists in business logic, and no live bucket was created or tested this round — the runtime rows in §1 stay unverified until Phase 6.

## 5. Candidate: notification outbox worker

| Candidate | Fit |
| --- | --- |
| Render free "Background Worker" | Free instance type is limited to web services; background workers start on paid instances |
| Render Cron Job | Starts on paid instances |
| A one-shot drain process started by any external free scheduler (`pnpm --filter @bot-thk/api drain:notifications`) | Cardless; drains persisted outbox rows with lease/idempotency semantics already in the DB; **chosen and implemented (2026-10-29)** |
| A `/api/internal/drain` route invoked by an external free scheduler | Same delivery semantics, but needs a new public route plus a shared secret in the Web app's environment, and pays a cold start on every tick. Rejected in favour of the process: the only credential involved is the `DATABASE_URL` the API already holds. |

Decision: the worker stays a separate process for local/self-hosted use, and the
hosted path is a **scheduler-invoked one-shot drain**
(`apps/api/src/persistence/notification-drain.ts`, bounded by a wall-clock
deadline and a batch cap). Both share `dispatchOutboxBatch`, so leasing,
rescheduling and idempotency are identical; see
[notification worker §6a](../operations/notification-worker.md).

The worker's own start/stop, retry, metrics and shutdown contract is now written down in [notification worker](../operations/notification-worker.md).

## 6. What is now allowed, and what is still forbidden

Allowed after this gate:
- Phase 3 public SSR route migration against the **plain Node server** (no adapter imports, no provider SDK).
- Treating Render's free instance shape as the sizing/behavior baseline (cold start, 0.1 CPU, ephemeral disk).
- Documenting environment variables and the `PORT`/`0.0.0.0` contract.

Still forbidden:
- Any Render-specific deploy file, `render.yaml`, or provider SDK in business logic. A deploy descriptor, if added later, stays a top-level ops artifact.
- Any Neon-specific media code: the storage adapter must stay a generic S3 client, configured only through environment variables.
- Creating a live deployment, provisioning Neon, changing DNS, or touching production.
- Relaxing the no-card requirement (it no longer needs relaxing: web, database, and object storage all have cardless free tiers).

## 7. Evidence basis and honesty note

Terms above come from vendor pricing/product pages and from third-party trackers that quote them, not from a live signup. The published-terms check is what ADR 0012 asks for *before* provider-specific code; the runtime rows (§1 items 3–7) remain unverified until a disposable deployment exists. This document therefore claims: **gate passed on published terms for Render (web), Neon Postgres (database), and Neon Object Storage (media), plus a cardless scheduler-drain fallback for notifications; runtime behavior for all four remains unverified until a disposable deployment exists.**
