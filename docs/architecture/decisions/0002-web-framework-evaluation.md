# ADR 0002: Select Next.js App Router for the Web Application

- Status: Accepted, subject to a minimal portability proof of concept
- Date: 2026-10-23

## Context

BOT THK requires public SEO-first article and author routes, authenticated account flows, a rich interactive editor, a messaging UI, PWA integration, and a future shared API for React Native and Tauri. The existing web app is already Next.js Pages Router, but its data/cache layer and routing conventions will be substantially rewritten.

The owner prioritizes retaining product capability while keeping deployment portable and avoiding a hard dependency on one managed hosting provider.

## Decision

Use **Next.js App Router** for `apps/web` as the current target. Keep `apps/api` independently deployable and treat the API—not Next.js route handlers—as the source of truth for domain rules, identity, authorization, messages and notifications.

This is a framework decision, not permission to immediately generate the whole application. First build a small portability proof of concept and validate the behaviors below before establishing the production workspace baseline.

## Why this is the best current fit

1. **Migration leverage:** the legacy app already uses Next.js, React, TypeScript, Next image handling and localized routes. The rebuild can preserve useful product knowledge and assets without carrying forward the Pages Router or old data-layer design.
2. **SEO and rendering:** public article/profile routes can use server rendering or static generation while authenticated routes remain dynamic and explicitly non-publicly cacheable.
3. **Deployment portability:** official documentation supports Node.js and Docker deployment with full framework features; a static export is possible but has limited feature support. Therefore Node/Docker is the portability baseline, not a promise that every managed edge platform supports every feature identically.
4. **Product fit:** the application is more than a content-only site: it has authenticated social features, an editor, messaging, subscriptions and account flows. An application framework with integrated routing/rendering is a better default than introducing an Astro islands architecture for this full product.
5. **Cost of switching:** React Router Framework Mode is a credible portable alternative, but current evidence does not show enough product benefit to justify changing both the web framework and the whole app architecture at once. Reopen this decision if the proof of concept reveals a material portability or testing blocker.

## Alternatives considered

- **React Router v7 Framework Mode:** strong loaders/actions and documented Node/Docker plus platform deployment options. Keep as the fallback if Next.js portability, testing or operational constraints fail the spike.
- **Astro:** strong content-first/static rendering, but the authenticated social and real-time application surface would require many interactive islands. Not the default for this product.
- **TanStack Start:** worth revisiting if a concrete type-safe data-loading requirement outweighs the lower migration leverage; not selected without a successful comparative spike.

## Required proof of concept

Implement only a minimal, isolated slice—not production features:

- Public article page renders crawlable HTML and title/description/canonical/Open Graph metadata.
- Public author route has predictable metadata and not-found behavior.
- Authenticated sample route uses server-side session checks and a private/no-store response policy.
- A form calls a mocked API and demonstrates validation and server errors.
- GraphQL operations use generated types from a checked-in schema or a deterministic local schema fixture; no live production endpoint is needed.
- A mocked SSE stream demonstrates reconnect plus refresh of persisted state; it must not imply durable delivery.
- Build and run in Node/Docker without requiring a Vercel-only service.
- Document which features need adapters or additional infrastructure on Cloudflare/Netlify and which are not part of the static-export profile.

## Acceptance gate

Do not create the full production app until the spike:
- builds in CI on a clean checkout;
- passes the selected unit/route tests and typecheck;
- demonstrates public/private cache separation;
- runs as a Node server and container;
- documents limitations and operational assumptions;
- confirms that the web app depends on the independent API contract, not private server implementation details.

## Deployment policy

- Baseline: Node.js server or Docker container.
- Static export is an optional constrained mode for public-only pages, not the default architecture for the complete app.
- Cloudflare, Netlify and other targets are evaluated by feature-specific adapter support; do not promise equivalent support for every Next.js capability.
- Keep the API and any durable worker independent of the web deployment. Use a persistent database and durable notification records; do not rely on in-process timers or web-server memory for critical work.

## References

- Next.js App Router: https://nextjs.org/docs/app
- Next.js deployment options: https://nextjs.org/docs/app/getting-started/deploying
- Next.js self-hosting and cache coordination: https://nextjs.org/docs/app/guides/self-hosting
- React Router deployment modes and templates: https://reactrouter.com/start/framework/deploying
