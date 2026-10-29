# Frontend framework and hosting-portability migration

- Owner approval: 2026-10-29
- Target: React Router 7 Framework Mode
- Current implementation: Next.js App Router, preserved until staged migration passes
- Baseline audited: `main@d9515c6d66881a7599d35581f38640b0ebb74a78`
- Status: Architecture/route inventory recorded; **Phase 1 prototype delivered** in `apps/web-rr`
  ([report](react-router-prototype.md)); no production framework code has been replaced yet

## 1. Approved outcome

The final Web architecture must satisfy all of these requirements:

- **Public pages:** server-rendered HTML for home, article archive/detail, author, category and search pages. Keep crawlable metadata, canonical/Open Graph tags, localized route output, sitemap, robots and real 404 statuses.
- **Writing desk:** client-interactive React/Lexical editing experience. The initial route can render a shell, but private article/session data must not leak into public HTML or shared caches.
- **Framework:** React Router 7 Framework Mode. Keep the migration inside the current React/TypeScript workspace; do not choose Astro or create a separate Remix v2 target.
- **Portable runtime:** standard Node.js server/container is the capability baseline. Platform-specific adapters are allowed only at infrastructure boundaries and are never the only way business behavior can run.
- **Backend:** continue to use the standalone versioned REST API. The API owns identity, authorization, business rules, persistence and notification records.
- **Data and media:** do not combine the Web migration with a database-provider rewrite. Respect ADR 0010 and keep uploads in private S3-compatible storage behind the API; instance-local temporary disks are not durable storage.
- **Background work:** the notification outbox worker must run independently of the Web process and must not require Vercel Daemons.
- **Cost constraint:** the hosting choice must be genuinely zero-cost and must not require a credit card. Free-instance sleep is acceptable. No candidate is approved until its actual signup, overage, runtime and persistence constraints are verified.

See [ADR 0012](../architecture/decisions/0012-portable-web-framework-migration.md) for the accepted architecture decision and [phase gates](phase-gates.md) for the project's broader delivery criteria.

## 2. Baseline inventory

The inventory below was checked against `main@d9515c6d66881a7599d35581f38640b0ebb74a78` on 2026-10-29. Re-check it against the current main head before each implementation stage; do not assume the repository remains unchanged after this audit.

### Framework and package configuration

- `apps/web/package.json`: Next.js 16.4.2, React/React DOM 19.2.0, local commands `next dev`, `next build` and `next start`.
- `apps/web/next.config.ts`: standalone output and monorepo tracing root. React UI, CSS, assets and most content helpers are reusable; App Router route semantics and framework-only helpers are not.
- `apps/web/src/app`: current App Router routes. Pages depend on Next metadata, route params and `notFound()`.
- `apps/web/src/app/sitemap.ts` and `robots.ts`: Next MetadataRoute implementations. They must be ported to standard route responses or equivalent React Router route modules.
- `scripts/route-smoke.ts`: starts `pnpm --filter @bot-thk/web start`, currently backed by `next start`. Its assertions form a useful behavior baseline, but the server launch and any Next-specific assumptions must be changed during the framework switch.

### Framework-specific HTTP entry points

There are eight current App Router `route.ts` handlers:

| Existing path | Responsibility | Migration requirement |
| --- | --- | --- |
| `apps/web/src/app/api/auth/[action]/route.ts` | Register/login/refresh/logout proxy | Preserve the auth/cookie contract and safe error mapping. |
| `apps/web/src/app/api/authoring/session/route.ts` | Current authenticated session proxy | Keep private/no-store response behavior. |
| `apps/web/src/app/api/authoring/articles/route.ts` | List/create current user's articles | Preserve input limits, session refresh and actor checks in the API. |
| `apps/web/src/app/api/authoring/articles/[id]/route.ts` | Update an owned article | Preserve owner checks, validation and token refresh. |
| `apps/web/src/app/api/authoring/media/route.ts` | Upload proxy | Preserve same-origin mutation check and upload restrictions. |
| `apps/web/src/app/api/media/[id]/route.ts` | Publicly addressable, API-authorized media proxy | Preserve private object storage, validation, cache headers and safe failures. |
| `apps/web/src/app/api/articles/[slug]/comments/route.ts` | Comment read/write proxy | Preserve origin protection, the comment content contract and private cache policy. |
| `apps/web/src/app/api/spike/events/route.ts` | Test-only SSE route | Preserve the route smoke contract while the spike remains; do not treat it as a durable real-time transport. |

There is one additional Next Server Action module: `apps/web/src/app/spike-form/actions.ts`. It is part of the framework spike, not the durable business API. Preserve its observed behavior through a route action/resource route or explicitly retire it only under an approved scope decision.

### Authentication and private request boundary

- `apps/web/src/lib/authoring-proxy.ts` directly imports `NextRequest` and `NextResponse`; it reads cookies and writes/clears tokens through the Next response-cookie helper.
- The current access cookie is scoped to `/api/authoring`; the refresh cookie is scoped to `/api`. Both are HttpOnly and SameSite=Lax, and are Secure on HTTPS.
- Mutating auth/comment/media requests require an exact same-origin Origin check. JSON body validation includes content-type, byte limits and parse errors.
- On a protected API 401, the proxy can rotate the refresh token and retry once; invalid refresh state clears cookies. Browser JSON must never expose access/refresh token secrets.
- The current API base resolver supports `API_BASE_URL` and the Vercel service binding `API_SERVICE_URL`. A standard server-only API origin must be sufficient for the migrated app; the binding cannot be a required dependency.

These behaviors have tests in `apps/web/src/lib/authoring-proxy-policy.test.ts` and related Web/API contract tests. Before moving code, identify which tests validate shared behavior and which only exercise the current Next adapter. Preserve behavior tests and replace adapter-specific assertions deliberately.

### Vercel-only deployment assumptions

Current `vercel.json` defines:
- A Web service rooted at `apps/web`, preset to `nextjs`.
- A private API service binding injected as `API_SERVICE_URL`.
- A rewrite of `/api/v1/*` to the API service and a catch-all rewrite to Web.
- A single `notifications` Daemon instance in region `hkg1`, running `apps/api/src/persistence/notification-worker.ts`.

The migration must replace, not silently depend on, the service binding and Daemon. External routing can vary by host; the application route contract must not. Do not modify production Vercel settings or deploy as part of this documentation/route-inventory stage.

### Current repository tests

The root CI currently runs:
- `pnpm test`
- `pnpm typecheck`
- `pnpm build`
- `pnpm test:routes`
- API PostgreSQL integration tests in a separate required job.

The route smoke suite checks localized public pages, metadata/canonical links, category and article 404s, author 404s, anonymous account redirect/private cache headers, the test SSE endpoint, writing desk availability, media/comment proxy failures when the API is unconfigured, and robots/sitemap. These checks must keep testing observable behavior after the framework change rather than coupling every assertion to implementation details.

## 3. Hosting qualification gate — do this before choosing a provider

The owner accepts cold starts and free-instance sleep but does not accept card-required signup or an implicit paid overage. Verify at least one candidate end-to-end with the actual account and current terms before adapting production code to the provider.

- [ ] Signup and deployment can be completed without entering a card, trial payment method or billing authorization.
- [ ] The free plan has a clear hard stop or explicit owner-controlled limit; no automatic paid usage beyond the zero-cost limit.
- [ ] Public HTTPS routes, environment variables and the required Node.js runtime are supported.
- [ ] A small SSR page and the React Router production build run correctly after sleep/wake.
- [ ] The app can connect to the selected durable database and private object storage over the platform's network policy.
- [ ] Database and media persist across restart, redeploy and idle sleep; temporary application disk is not used as the only copy.
- [ ] The notification worker can run durably, or a scheduler-compatible invocation can safely drain persisted outbox rows with retries and idempotency.
- [ ] Usage limits, idle behavior, log retention, backup/export and account deletion/export paths are documented.
- [ ] A failed or exhausted free instance fails safely and can recover without data loss or a surprise bill.

**No provider is selected by this checklist alone.** Hosting candidates such as Netlify, Render or any other eligible platform must be evaluated against current evidence. Database and object-storage services (including Neon) have separate free/no-card, durability and quota gates; a database provider is not a Web hosting candidate by itself. Existing Neon code/configuration does not prove that a live branch has been provisioned, that the user's account passes the no-card gate, or that a full production deployment works. Do not provision resources or paste credentials into Git/PRs during qualification.

## 4. Incremental implementation phases

### Phase 0 — Record decision and inventory (current stage)

- [x] Record the accepted target in ADR 0012.
- [x] Update the main roadmap and this document with the owner constraints.
- [x] Inventory the current Next.js route handlers, auth cookies, SEO output, test commands and Vercel dependencies.
- [ ] Review this documentation-only PR and ensure CI remains green.

**Exit gate:** team/agents can tell what is being migrated, what must remain stable, and which hosting conditions can block it. No runtime code or deployment has changed.

### Phase 1 — Hosting feasibility and isolated portability prototype

- [x] Re-check main and all nested `AGENTS.md` / relevant ADRs before coding.
- [ ] Verify one or more no-card, zero-cost hosting candidates. If none pass, stop and report options without relaxing the requirement.
- [x] Build an isolated React Router 7 Framework Mode proof of concept using a mocked REST API, separate from the current production `apps/web`. → `apps/web-rr`
- [x] Prove a public article route renders server HTML, title/description/canonical/Open Graph metadata and a hard 404 for an unknown slug.
- [x] Prove a client-interactive form handles valid input, validation errors, API failures and explicit pending/success states.
- [x] Prove a private route/response does not expose user data in SSR HTML or shared caches.
- [x] Build and start via standard Node.js in a container or equivalent neutral environment, without Vercel bindings. → `apps/web-rr/server.ts`
- [x] Add the minimum deterministic test/build workflow for the prototype and record platform-specific assumptions. → `pnpm test:prototype` + CI job `react-router-prototype`

**Exit gate:** framework SSR/client behavior and standard-runtime startup are demonstrated; host feasibility is established independently of marketing claims.

**Status 2026-10-29:** all framework/runtime items are done and recorded in the
[prototype report](react-router-prototype.md). The **hosting qualification gate is
still open** — no candidate has been verified against the no-card/zero-cost terms,
so the phase is not complete and no provider-specific code exists.

### Phase 2 — Framework-independent HTTP and deployment seams

- [ ] Separate request validation/cookie policy/response mapping from the Next adapter where this reduces coupling, using standard web Request/Response types and explicit inputs.
- [ ] Add contract tests for cookie paths/options, exact-Origin validation, token refresh/retry, invalid refresh logout, payload size limits and private cache headers.
- [ ] Ensure every server-side API call can use an explicit server-only `API_BASE_URL`; keep any temporary Vercel binding support behind a small adapter.
- [ ] Document the production worker's standalone start/stop, health/metrics, retry and graceful-shutdown contract without running or moving the live worker.

**Exit gate:** the critical auth/media/REST behavior is tested without requiring Next.js request objects or Vercel's service-binding injection.

### Phase 3 — Migrate public SSR routes first

- [ ] Port localized home, article archive/detail, author, category and search routes in small reviewed batches.
- [ ] Preserve URLs, `zh-CN` defaults, English routes, canonical/Open Graph metadata and status codes.
- [ ] Port sitemap and robots output; avoid using fake fallback content when a configured API fails.
- [ ] Reuse React presentation components and neutral content helpers where appropriate; avoid a styling redesign within this migration.
- [ ] Update route-smoke checks to start the migrated Node server and keep asserting observable output/status/cache semantics.

**Exit gate:** public routes pass side-by-side behavior assertions with no known SEO, locale or hard-404 regression.

### Phase 4 — Migrate authentication and writing desk

- [ ] Port sign-in/account redirects and the writing desk route.
- [ ] Keep the Lexical editor client-interactive; test Chinese IME, keyboard accessibility, save/publish and error recovery without changing the article contract.
- [ ] Migrate auth, session, article authoring and comment routes to React Router actions/resource routes or a framework-neutral handler adapter.
- [ ] Preserve cookie attributes, token refresh rotation, origin checks, request limits, API authorization and no-store policy.
- [ ] Re-run auth and writing end-to-end journeys against a disposable API/database.

**Exit gate:** no token leaks; user-specific content remains private; create/edit/save/publish and logout flows are regression-tested.

### Phase 5 — Migrate media and detach the worker from Vercel

- [ ] Port the media request/response adapter without exposing private storage keys or service credentials.
- [ ] Verify media upload, normalized WebP retrieval, access denial, checksums, ETag and cache headers.
- [ ] Run the notification outbox worker outside the Web server and validate duplicate prevention, lease expiry, retry and shutdown recovery against a disposable PostgreSQL database.
- [ ] Select a worker/scheduler execution model that actually fits the qualified zero-cost host. If it cannot, stop before choosing that host or silently weakening delivery guarantees.

**Exit gate:** media remains private and durable; notification delivery remains database/outbox-backed and recovers after worker restarts.

### Phase 6 — Deployment qualification, regression and rollback

- [ ] Build the final Web image/package from a clean checkout and start it with only documented environment variables.
- [ ] Run full `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm test:routes` and PostgreSQL integration jobs.
- [ ] Validate API connectivity, DB readiness, media storage, free-instance sleep/wake, cold starts, logs and graceful shutdown in a non-production environment.
- [ ] Document exact DNS/route mapping, environment variables, database/media backup, worker uniqueness, health checks and rollback sequence.
- [ ] Require explicit owner approval before production deployment, DNS/traffic change or production data migration.

**Exit gate:** the replacement can be rolled back without schema incompatibility or data loss, and the actual host passes the strict cost/no-card gate.

### Phase 7 — Cutover and remove legacy Web hosting assumptions

- [ ] After approved cutover and a stable validation window, remove the Next.js dependency/configuration and dead App Router routes.
- [ ] Remove the Vercel-specific Web framework/service-binding/Daemon assumptions only after the replacement's deployment and worker paths are verified.
- [ ] Keep the standalone API, REST contract, database adapters, private media boundary and outbox semantics independent of the selected host.
- [ ] Re-run the complete CI suite after cleanup and update README/operations guides to reflect only tested deployment instructions.

**Exit gate:** no production route relies on Next.js or a Vercel-only binding/daemon, and the zero-cost/no-card operational constraints remain documented and testable.

## 5. Change management and non-goals

- One phase or small cohesive slice per PR. Do not perform a wholesale rewrite.
- The existing Next.js app remains the working fallback until the replacement passes acceptance gates.
- Do not change API behavior, REST fields, auth security, editorial product behavior, database migration protocol or visual direction unless a separate decision explicitly authorizes it.
- Do not automatically provision Neon, select a paid plan, deploy public previews requiring a payment method, run production migrations, change DNS, or cut over traffic.
- The first technical change after this audit is the isolated prototype, not a direct rewrite of every route.
- Every completion report must distinguish tests actually run from those only defined in CI, and list remaining blockers.
