# Testing Strategy: Behavior-First, Risk-Based

## Policy

Use behavior-driven requirements and risk-based verification, with selective TDD for high-risk logic. Do not mandate full TDD for every line or Gherkin/Cucumber for every feature.

The objective is to catch user-visible regressions, security failures and data-integrity problems at the lowest reliable cost—not to maximize test count or coverage percentage.

## Workflow

1. Describe the observable behavior and acceptance criteria.
2. Assign risk: critical, high, medium or low.
3. Choose the cheapest reliable verification layer.
4. For critical/high-risk behavior and bug fixes, write a test that fails for the expected reason before implementation (Red).
5. Implement the smallest correct change (Green).
6. Refactor while keeping tests green.
7. Run the focused checks, then the relevant package suite and full CI checks when feasible.
8. Report actual results; never infer success from unrun checks.

If test-first is impractical, explain why and provide proportionate verification.

## Risk levels

### Critical / high

Always automated before acceptance where technically feasible:
- authentication, session refresh/logout and authorization;
- preventing user impersonation through client-supplied IDs;
- private conversation access and participant management;
- message/notification persistence, idempotency, retry and offline recovery;
- data migration and concurrency-sensitive updates;
- private cache isolation and sensitive-data exposure;
- destructive actions and payment/security-sensitive behavior if introduced.

Use unit tests for pure policy and domain rules, integration tests for persistence/transactions, API/contract tests for exposed operations, and a small number of E2E tests for complete journeys.

That E2E layer now exists: Playwright drives a real browser against the local stack (`pnpm test:e2e`, see [end-to-end.md](end-to-end.md)). Use it for journeys that cross the editor, the proxy and the API at once — the authoring save/publish round trip is the reference case. Keep it small: a behaviour belongs in the cheapest layer that can actually see it.

### Medium

Automate representative behavior:
- blog CRUD and publishing state;
- follow/unfollow, like/unlike and comments;
- editor serialization and validation;
- public metadata, canonical URLs, sitemap and not-found behavior;
- API error handling and generated contract compatibility.

### Low

For static copy, simple presentational styling and trivial component markup, use review, typecheck, lint, visual checks or targeted tests as appropriate. Do not add a test solely to cover a getter, constant or styling detail with no meaningful behavior.

## Test layers

- **Unit:** pure functions, validation, domain rules, authorization policy and event/idempotency logic.
- **Integration:** real isolated database or disposable containers for persistence, unique constraints, transaction behavior and query isolation.
- **Contract:** GraphQL schema/operation validation and generated client types.
- **E2E:** a small critical user journey set: sign-in, publish/read article, follow, comment/like, send message, offline recovery and access denial.
- **Local chain (integration seam):** `pnpm check:local` exercises the real running stack over HTTP — database readiness, identity, an authorized write, a published read, the Web server's server-side API call and the browser-facing same-origin proxies. It complements the layers above because it is the only check that proves the configured environment actually wires the processes together; see [local development](../development/local-development.md).
- **Manual exploratory:** visual quality, responsive behavior, accessibility and PWA installation on supported devices. Record what was checked.

Do not repeat the same assertion at every layer. Each layer should catch a different class of failure.

## Reliability scenarios

- Unauthenticated requests cannot access private resources.
- Non-participants cannot read, send to or mark a conversation read.
- Altering senderId/userId in a request cannot impersonate another account.
- Persisted messages can be retrieved after recipient offline time.
- Duplicate event delivery does not create duplicate logical notifications.
- A failed push does not erase the underlying message/notification.
- Retry and reconnect recover from transient delivery failures.
- Private responses have appropriate non-public cache policy.
- Public article pages render crawlable content and expected metadata.
- Unit tests run without production credentials or external production services.

## Tooling guardrails

- Start with the test runner best supported by the chosen framework and API stack; avoid adding multiple test frameworks without a demonstrated need.
- Avoid real network calls in unit tests, arbitrary sleeps, and shared mutable fixtures.
- Freeze time/control randomness where needed.
- Do not weaken or delete tests to make CI pass. If behavior intentionally changes, update acceptance criteria and tests in the same reviewed change.
- Do not set a blanket 100% coverage requirement. Establish a baseline after the initial test suite exists and use coverage as a diagnostic, not the goal.
- CI should run formatting/lint, typecheck, relevant tests, contract generation/checks and production builds. Security/dependency checks should be added with actionable failure policies.

## Performance baseline

A behavior test says "this endpoint returns the right page". It does not say whether
that page still costs two queries or has quietly grown into one per article. The
baseline in `scripts/perf-baseline.ts` closes that gap:

```bash
pnpm perf:baseline          # full run; exits non-zero when a threshold fails
pnpm perf:baseline:quick    # quarter-size sample, for a local look
pnpm perf:baseline --json   # also prints machine-readable results
```

It starts the portable stack (the same launcher `pnpm stack:check` uses), seeds 200
published works, and measures three paths:

| Path | How it is driven | Why |
| --- | --- | --- |
| Public page read | `GET /api/v1/articles?locale=zh-CN&limit=20` over real HTTP | The dominant traffic shape: full HTTP stack, serializer, SQLite reads |
| Authenticated write | Adapter `createArticle` in-process | One SQLite writer; every write blocks the event loop |
| Message send | Adapter `persistMessage` with an outbox worker draining in parallel | Heaviest single write: message, conversation and outbox in one transaction |

**Writes are measured in-process, not over HTTP, on purpose.** The write routes are
rate limited by product policy (`article.create` is 10/hour/user; registration is
20/hour/IP). Driving those over HTTP measures how fast the limiter refuses, not how
fast the database writes. The read path goes over real HTTP because that is where
HTTP-level costs live.

Three properties of the harness matter, and each exists because its absence would
produce a flattering but wrong number:

- **Connections are reused.** A fresh TCP connection per request measured ~48ms per
  read on this repository versus ~0.7ms over keep-alive; the 48ms is client-side
  connect cost, not server latency.
- **The report is checked for persist, not just for speed.** After each write
  scenario an independent read-only connection counts the rows. A write path that
  silently no-ops would otherwise look extremely fast.
- **The outbox worker must drain.** The worker runs as a real child process for the
  whole session; if events remain undelivered after a 2s drain window, the run fails.
  A writer outpacing its worker is the capacity ceiling, not a passing baseline.

### What a run reports

Latency (p50/p95/p99, max) and throughput per path; a concurrency ladder
(c = 1, 2, 4, 8) for the read path plus the saturation point; and the outbox drain
result. Thresholds live in `scripts/lib/perf-scenarios.ts` and each carries a
written rationale — a limit without a reason gets widened the first time it fails.

### Reading the numbers honestly

The measured shape on a single machine is that **read throughput does not scale with
concurrency**. Adding in-flight requests raises p50 roughly proportionally while
throughput stays flat: one synchronous SQLite call at a time occupies the process.
That is a property of the single-process, single-file deployment, not a bug, and it
is why the deployment guide states a per-instance capacity ceiling instead of
implying horizontal scaling within a process.

Absolute numbers from a shared CI runner are not production capacity. They are useful
for two things only: catching regressions, and establishing order of magnitude. See
`docs/deployment/capacity.md` for the published ceiling and its derivation.

### CI

`performance-baseline` in `.github/workflows/ci.yml` runs `pnpm perf:baseline`. It is
deliberately **not** in `required-checks`: a shared runner is noisy enough that a
hard gate would fail for reasons unrelated to the change. It runs where policy
allows and its output is read.

The thresholds are re-derived when a change moves performance, not left at whatever
they were. #162 made the read path roughly four times faster; leaving the old
400 ms / 20 req/s limits in place would have meant the guard no longer guarded
anything, since the fix's whole value is re-earnable by a regression. The current
read limits (p95 ≤ 150 ms, throughput ≥ 150 req/s) sit several times below the
pre-#162 numbers, so a returning `1 + 3N` serializer trips them while a slow runner
does not. Each limit states its rationale next to it in
`scripts/lib/perf-scenarios.ts`.

A statement count is a better guard than a stopwatch where it applies, and the
serializer now has one:
`apps/api/src/transport/rest/serializers.test.ts` counts prepared statements and
asserts the page cost is constant at three, so the amplification cannot return even
if a future machine is fast enough to hide it in a timing test.

## Completion report

List each check actually run, result, and relevant command. State which checks were not run and why.
