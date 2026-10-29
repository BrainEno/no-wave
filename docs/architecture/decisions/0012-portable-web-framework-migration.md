# ADR 0012: Migrate Web to React Router 7 Framework Mode

- Status: Accepted
- Date: 2026-10-29
- Supersedes: ADR 0002 for the target Web framework; the existing Next.js application remains the working implementation until migration and cutover gates pass.

## Context

The owner approved the following constraints for `BrainEno/no-wave`:

- Public pages must be server-rendered for crawlability and SEO.
- The writing desk is interaction-heavy and should use client-side React interaction after its initial route shell.
- Hosting portability is more important than optimizing around one managed host.
- Hosting must be genuinely zero-cost and must not require a credit card. Sleeping free instances are acceptable.
- The REST API, data model, authorization rules, media security and durable notification state must not be rewritten as collateral work.

The existing Web application uses Next.js App Router. Its core React components and most domain-neutral content helpers can be reused, but routing, metadata, request/response cookies, framework route handlers, one Server Action, and Vercel-specific service/daemon configuration must be deliberately migrated.

## Decision

1. **Target React Router 7 Framework Mode** for `apps/web`. It supports server rendering with route modules while retaining React components and client-side interaction. Do not introduce a separate Remix v2 application; the selected target is React Router 7 Framework Mode.
2. **Render public content on the server.** Home, archive, article, author, category and search routes must render meaningful HTML and metadata without relying on client-only data loading. Preserve current URLs and locale behavior unless a separately approved product decision changes them.
3. **Keep the writing desk interactive and private.** The `/write` page can hydrate a client-side Lexical editor. Its SSR output must not embed private user data, and authenticated/user-specific responses must not enter shared public caches.
4. **Use standard Node.js as the portable runtime baseline.** The app must build and start without Vercel service bindings. A host-specific adapter may be added only outside business logic and only after the zero-cost/no-card qualification gate passes.
5. **Keep the REST API independently deployable.** The API remains the source of truth for identity, authorization, domain rules, persistence and notifications. The Web reads a server-only API origin from portable configuration (currently `API_BASE_URL`); `API_SERVICE_URL` is a Vercel-injected transition mechanism and must not become a required runtime dependency.
6. **Keep persistence and media decisions separate.** Continue to respect ADR 0010: SQLite is the default for fresh/local use, PostgreSQL remains supported, MongoDB is future work, and provider selection is never an online data migration. Hosted deployments must use a data store and media service with tested durability; temporary instance disk is not a database or upload store. Existing Neon integration is a candidate implementation, not proof of free/no-card eligibility or a validated live deployment.
7. **Decouple notifications from Vercel Daemons.** The notification worker must remain a separate process or a documented scheduler-compatible task operating over durable outbox state. No in-memory-only queue, fire-and-forget handler, or vendor-specific daemon may be the only way to deliver persisted notifications.
8. **Apply a hard provider gate before choosing hosting.** At least one real candidate must be verified to permit signup and deployment without a credit card, remain at zero cost without automatic paid overages, support public HTTPS and the required Node runtime/SSR behavior, reach the chosen durable database/object storage, and support the selected worker/scheduler model. Sleep and cold starts are acceptable. If no candidate passes, stop before committing provider-specific migration code and report the blocker rather than relaxing the requirement.

## Current coupling inventory

Audited against `main@d9515c6d66881a7599d35581f38640b0ebb74a78` on 2026-10-29. The complete route and deployment inventory lives in [the frontend portability migration roadmap](../../roadmap/frontend-portability-migration.md).

- `apps/web/package.json` pins Next.js 16.4.2 and React 19.2.0.
- `apps/web/next.config.ts` enables standalone output and monorepo file tracing.
- App Router pages use `generateMetadata`, `notFound()`, Next Metadata types, `sitemap.ts` and `robots.ts`.
- Eight `route.ts` handlers implement auth, writing, comments, media and a test SSE endpoint; `apps/web/src/app/spike-form/actions.ts` uses a Next Server Action.
- `apps/web/src/lib/authoring-proxy.ts` uses `NextRequest`/`NextResponse` and Next cookie helpers. It implements an important security boundary and must be ported by behavior, not mechanically translated.
- `vercel.json` declares the Web framework preset, the private API service binding (`API_SERVICE_URL`), public rewrites and a one-instance notification Daemon in `hkg1`.
- `scripts/route-smoke.ts` starts the Web app using the current `next start` command and verifies localized SSR, metadata, hard 404s, private cache policy, SSE and media/comment route behavior.

## Required migration rules

- Keep route modules thin. Put reusable policy and business-neutral HTTP behavior in framework-independent functions using standard `Request`, `Response`, `Headers` and explicit inputs. Do not move domain logic from the REST API into Web loaders/actions.
- Preserve auth behavior: access and refresh tokens remain HttpOnly cookies; preserve cookie paths, SameSite=Lax, HTTPS Secure, token expiry, exact-Origin mutation checks, request size/content-type checks, refresh rotation and clearing on invalid sessions. Do not expose tokens in browser JSON or logs.
- Preserve private/no-store cache policy for authenticated content, account redirects, comments and media proxies. Public cache behavior must be deliberate and tested independently.
- Preserve 404 status codes for unknown articles, authors and categories rather than returning soft 404 pages.
- Preserve Simplified Chinese defaults, English routes, article canonical/Open Graph metadata, sitemap and robots behavior.
- Keep media objects private and served through the authorized API path. Never make a framework migration change the object bucket's access policy.
- Keep the outbox durable in the database. The Web deployment must not own notification delivery state.
- Keep GraphQL removed. The migration uses the existing REST contract only; obsolete GraphQL requirements in earlier framework notes are historical and do not authorize reintroduction.
- Do not delete the existing Next.js app, remove its dependencies, switch DNS, deploy production, provision paid resources, or run data migrations until the replacement passes its gates and the owner explicitly approves the operation.

## Alternatives considered

- **Remain on Next.js:** preserves the current implementation but leaves framework and deployment configuration closer to the Vercel-specific implementation the owner approved migrating away from.
- **Astro:** excellent for content-first sites, but the authenticated writing desk and interactive application surface would add an unnecessary islands/framework boundary for this product.
- **A separate Remix v2 target:** not selected; React Router 7 Framework Mode is the current framework direction for new migration work.

## Acceptance gates

Before migrating production routes:
- The isolated prototype builds on a clean checkout and runs as a normal Node.js server/container without Vercel bindings.
- Tests prove public SSR and metadata, unknown-route 404 behavior, private/no-store responses, client-interactive form behavior, and mocked REST API errors.
- The exact target host has passed the zero-cost/no-card qualification gate; documentation and a free-price badge alone are insufficient evidence.
- The existing Next.js application still builds and passes its current test and route-smoke suite.

Before final cutover:
- All user-facing routes and authentication/media flows pass regression and end-to-end checks.
- The notification worker has an independently verified execution and recovery path.
- Database durability, media persistence, sleep/wake recovery and rollback are tested in the target environment.
- The old and new Web applications can be switched back without schema incompatibility or data loss.
- Production deployment, DNS/traffic cutover and decommissioning are separately approved.

## References

- React Router Framework Mode: https://reactrouter.com/start/framework
- React Router deployment: https://reactrouter.com/start/framework/deploying
- Project migration work and gates: [frontend portability roadmap](../../roadmap/frontend-portability-migration.md)
