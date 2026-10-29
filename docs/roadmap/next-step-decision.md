# Next step: fix the open issues, or start the React Router migration?

- Question raised: 2026-10-29
- Evidence snapshot: `main@b0b3ec3` (PR #81 merged)
- Decision: **start the React Router migration now** (Phase 1 of
  [the portability roadmap](frontend-portability-migration.md)), and shrink the
  issue backlog by closing the entries whose work already landed instead of
  spending a cycle re-fixing them.

## 1. What was actually open

Seven issues were open on the snapshot. Each one was re-checked against the code
before ordering any work, because an audit issue can be fixed by a later PR while
staying open.

| # | Claim in the issue | State on `b0b3ec3` | Verdict |
| --- | --- | --- | --- |
| [#61](https://github.com/BrainEno/no-wave/issues/61) | No structured logs, no metrics, no tracing; contradicts `AGENTS.md`. | `apps/api/src/infrastructure/http-observability.ts` writes JSON log lines with generated `requestId`/`traceId`, exposes Prometheus text on `GET /metrics` (request counters, latency histograms, auth-failure counters, persistence-operation histograms, active requests), redacts hostile labels, and has tests. | **Already done** — issue is stale. |
| [#63](https://github.com/BrainEno/no-wave/issues/63) | No `.env.example`, no user-facing API contract. | `.env.example` now exists (added in #81, grouped by required/optional/development). Still missing: a machine-readable OpenAPI artifact and a "register → sign in → publish → read" quick start. | **Half done.** |
| [#66](https://github.com/BrainEno/no-wave/issues/66) | `Record<string, Function>` + `as unknown as` bypass the project's type discipline. | `createApplicationServices` is now a real facade, but `handler.ts` still declares `type RestServices = Record<string, (...args: any[]) => any>` and still casts once at line 696. | **Mostly open.** |
| [#58](https://github.com/BrainEno/no-wave/issues/58) | 1708-line single-function if-chain REST handler. | Handler is now 1890 lines. No route table. | **Open.** |
| [#64](https://github.com/BrainEno/no-wave/issues/64) | No performance baseline; SQLite single-writer ceiling unmeasured. | No benchmark, load-test or capacity file anywhere in the repo. | **Open.** |
| [#71](https://github.com/BrainEno/no-wave/issues/71) | `Idempotency-Key` semantics undefined for non-idempotent writes. | Design-only issue; no idempotency store. | **Open (design).** |
| [#72](https://github.com/BrainEno/no-wave/issues/72) | No moderation/reporting/role model. | Design-only issue; no ADR yet. | **Open (design).** |

None of the open issues is marked as a user-visible defect, and none of them
blocks the product: three are maintainability/architecture, one is measurement,
two are design documents for capabilities that do not exist yet.

Meanwhile the Web migration is **approved and unstarted**: [ADR 0012](../architecture/decisions/0012-portable-web-framework-migration.md)
(accepted 2026-10-29) selects React Router 7 Framework Mode, and the roadmap's
Phase 0 exit gate is met while every Phase 1 checkbox is still empty.

## 2. The options

**A. Fix the issues first, migrate later.**
Sort the backlog top-down, then start the framework work.

**B. Start the migration, fix the issues later.**
Begin Phase 1 (isolated prototype) now and keep the issue backlog as owned
follow-up work.

**C. Do both in one PR.**
Refactor the REST handler and migrate the Web app in the same change.

## 3. Decision: B, with the stale entries closed

1. **The two lists are not competing for the same risk.** Everything the
   migration consumes is the REST contract — URLs, payload shapes, auth, status
   codes. The open issues that touch that contract (#58 route table, #71
   idempotency) are exactly the ones that would invalidate Web-side verification
   if they landed mid-migration. Migrating the Web tier against a frozen contract,
   then refactoring the API behind contract tests, keeps one variable moving at a
   time. Option A moves the API first and pays the verification cost twice;
   option C moves both and pays it unpredictably.
2. **Delay is not equally expensive.** The Next-specific surface grows with every
   page and route handler added to `apps/web`; each one is future migration work.
   The issue list, by contrast, does not get harder over time — it is a bounded,
   already-measured amount of work whose cost does not depend on ordering.
3. **The migration has an unmet external gate, and only an artifact can unblock
   it.** ADR 0012 requires a hosting candidate that is genuinely zero-cost and
   card-free, verified end to end. That verification needs a build that starts on
   plain Node.js with no Vercel bindings — which is precisely the Phase 1
   deliverable. Fixing issues first unblocks nothing; the prototype unblocks the
   only open architectural question.
4. **Phase 1 is cheap and reversible by construction.** It is a new,
   separately-deployed package that leaves `apps/web` untouched and CI-gated. The
   worst case is that React Router cannot express a required behavior, discovered
   for the price of one prototype rather than after a rewrite.
5. **Two issues are already done and one is half done.** Spending a cycle
   "fixing" them would be re-work; the honest action is evidence-backed closure,
   which shrinks the backlog without moving the risk boundary. The remaining
   entries stay open with their priority unchanged — this decision defers them,
   it does not downgrade them.

### Why not "both at once"

Option C violates the roadmap's own change-management rule ("one phase or small
cohesive slice per PR") and would make the prototype's acceptance evidence
ambiguous: a failing assertion could belong to the framework change or to the
handler refactor.

## 4. Sequencing after this decision

| Order | Work | Gate |
| --- | --- | --- |
| now | Phase 1: isolated React Router 7 prototype (this PR) | builds and serves on plain Node.js; SSR, metadata, hard 404, no-store private route, interactive form proven by tests |
| next | Phase 2: framework-independent HTTP seam for auth/media, with contract tests | auth cookie/origin/refresh behavior tested without a framework request object |
| then | Hosting qualification against the built prototype | one card-free candidate verified end to end, or the blocker reported |
| then | [#58](https://github.com/BrainEno/no-wave/issues/58) route table + [#66](https://github.com/BrainEno/no-wave/issues/66) typed facade | API refactor behind the now-portable contract tests |
| then | Phase 3+ route migration, [#71](https://github.com/BrainEno/no-wave/issues/71), [#72](https://github.com/BrainEno/no-wave/issues/72), [#64](https://github.com/BrainEno/no-wave/issues/64) | per the roadmap |

Reasons to re-open this ordering: if a user-visible defect appears in `apps/web`,
fix that first — the migration never outranks a broken page. If the prototype
cannot satisfy a Phase 1 gate, stop and re-plan instead of pushing into Phase 2.

## 5. What Phase 1 does and does not claim

Proven by this PR (see [the prototype report](react-router-prototype.md)):
server-rendered public route with metadata and canonical links, a hard 404,
private no-store route with redirect when signed out, a client-interactive form
with pending/success/error states, an auth proxy boundary written with standard
`Request`/`Response`, and a production build served by `node server.ts` with no
Vercel-specific configuration.

Not claimed: this is not a cutover. `apps/web` remains the working application;
no route is replaced, no dependency is removed, no deployment is changed, and the
remaining Next.js coupling (11 `next/link` imports, 2 `next/navigation` imports,
the cookie helper in `authoring-proxy.ts`) is deliberately still there — measured,
not hidden.
