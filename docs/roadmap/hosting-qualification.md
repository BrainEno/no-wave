# Hosting Qualification — Zero-Cost / No-Card Gate

- Date: 2026-10-29
- Gate defined in: [ADR 0012](../architecture/decisions/0012-portable-web-framework-migration.md) (decision 8) and [migration roadmap §3](frontend-portability-migration.md)
- Verdict: **PASS, with a named primary candidate and two named exclusions.**

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

## 4. Candidate: private object storage (media) — **BLOCKED**

| Candidate | No card | Notes |
| --- | --- | --- |
| Cloudflare R2 (10 GB free) | **No** | R2 is a usage-based service; activating it requires a payment method / billing profile even inside the free allowance. Documented repeatedly, and consistent with Cloudflare's own billing policy for usage-based products. |
| Neon object storage (5 GB, free plan) | Claimed yes | Advertised in Neon's free-plan summary; **not verified against Neon's own docs this round** |
| Supabase Storage free (1 GB) | Claimed yes | Same status: unverified |
| Render persistent disk | **No** | $0.25/GB/month, i.e. requires payment |
| Instance-local disk | n/a | Ephemeral — forbidden as the only copy |

Decision: **media storage does not pass the gate this round.** R2 — the obvious choice, and the one the current stack is shaped around — is card-gated. Per ADR 0012, the correct action is to record the blocker and **not** write provider-specific media migration code. Media therefore stays on the existing API/Next path until Phase 5 either (a) verifies Neon or Supabase object storage on their own documentation, or (b) the owner accepts a card-backed storage account for media only.

This does not block Phase 3 (public SSR routes render text and API-served images; the media *proxy* is Phase 5).

## 5. Candidate: notification outbox worker

| Candidate | Fit |
| --- | --- |
| Render free "Background Worker" | Free instance type is limited to web services; background workers start on paid instances |
| Render Cron Job | Starts on paid instances |
| A `/api/internal/drain` route invoked by an external free scheduler (e.g. GitHub Actions schedule) | Cardless; drains persisted outbox rows with lease/idempotency semantics already in the DB |

Decision: **deferred to Phase 5**, with the cardless fallback recorded now: the worker stays a separate process for local/self-hosted use, and a scheduler-invoked drain over durable outbox state is the hosted option to validate. No code is written for it in this round.

## 6. What is now allowed, and what is still forbidden

Allowed after this gate:
- Phase 3 public SSR route migration against the **plain Node server** (no adapter imports, no provider SDK).
- Treating Render's free instance shape as the sizing/behavior baseline (cold start, 0.1 CPU, ephemeral disk).
- Documenting environment variables and the `PORT`/`0.0.0.0` contract.

Still forbidden:
- Any Render-specific deploy file, `render.yaml`, or provider SDK in business logic. A deploy descriptor, if added later, stays a top-level ops artifact.
- Writing media migration/storage code (Phase 5 blocked on §4).
- Creating a live deployment, provisioning Neon, changing DNS, or touching production.
- Relaxing the no-card requirement because media is blocked.

## 7. Evidence basis and honesty note

Terms above come from vendor pricing/product pages and from third-party trackers that quote them, not from a live signup. The published-terms check is what ADR 0012 asks for *before* provider-specific code; the runtime rows (§1 items 3–7) remain unverified until a disposable deployment exists. This document therefore claims: **gate passed on published terms for Render (web), Neon (Postgres), and a cardless scheduler-drain fallback; and explicitly *not* passed for object storage.**
