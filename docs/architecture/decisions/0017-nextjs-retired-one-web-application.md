# ADR 0017: Next.js is retired; one Web application

- Status: Accepted
- Date: 2026-11-01
- Supersedes: the "do not delete the existing Next.js app" clause of [ADR 0012](0012-portable-web-framework-migration.md), for the deletion only. Every other migration rule in ADR 0012 still holds, and ADR 0002's choice of Next.js is now historical.

## Context

ADR 0012 chose React Router 7 Framework Mode as the target and built `apps/web-rr`
beside the Next.js application, deliberately replacing no route until the
replacement had passed its gates. Those gates are what the last slices delivered:

- the shared React components stopped importing a framework and started importing
  a navigation contract owned by the shared UI;
- every public route, the writing desk, the account screen, the notification
  inbox, the media relay and the comment proxy existed in the React Router
  application and were asserted over real HTTP against the production build
  (61 tests) plus a route smoke pass and the browser-level suite;
- the whole stack ran on plain Node.js with no platform binding (`pnpm stack:check`,
  container images).

What remained was two applications rendering the same pages from the same
components, one of which existed only in order to be replaced. Carrying both cost
a dependency on Next.js 16, a second build, a nightly parity job, and a rule that
said "the other one is authoritative" to anyone who had to reason about the code.
The owner asked for the library to be removed without any frontend functionality
being lost.

## Decision

1. **`packages/web-ui` owns the shared UI.** Components, content and metadata
   helpers, the Lexical article state, the styles and the tests moved there from
   `apps/web/src`. The `@/*` specifier those files already used now resolves to
   that package's `src`, so no import was rewritten: 65 files moved unchanged.
2. **`apps/web-rr` is the Web application.** `apps/web` is deleted, and with it the
   only declaration of `next` in the repository. Static assets (`public/`) and the
   cover generator script moved to the surviving application.
3. **The navigation seam stays, and now lives with the UI it serves.**
   `packages/web-ui/src/lib/framework/` is the only place in the package that names
   a router; components import `@/lib/framework/*` and nothing else. It is
   implemented against React Router because that is the router in use, and it is
   still the single directory to change if that ever stops being true.
   `packages/web-ui/src/lib/framework-seam.test.ts` asserts the rule.
4. **Nothing was retired to make the deletion easier.** The `/spike-form` screen
   and its `GET /api/spike/events` stream are ported to a React Router route
   action and a resource route with the same three observable behaviours (too-short
   title, the deterministic failure state, the accepted draft) and the same
   `noindex`. ADR 0012 only allowed retiring them under an approved scope decision;
   none was sought, so none was taken.
5. **The parity gate is retired, not weakened.** `scripts/ssr-parity.ts` and its
   nightly workflow compared two implementations of the same routes. With one
   implementation there is nothing to compare, and a gate that cannot fail is not
   a gate. The assertions that mattered — shell markers, canonical URLs, hard
   404s, `no-store`, sitemap and robots — are asserted by the application's own
   HTTP suite and by the route smoke, which run on every commit.
6. **Behaviour that differed only because of the framework was preserved, not
   redefined.** The anonymous `/account` and `/admin/featured` redirects are
   decided by a cookie, so they carry `no-store` on the redirect itself and not
   only on the page; the route smoke asserts it. The redirect status is the
   framework's own (302), which is what the React Router application has always
   answered.

## Consequences

**Unchanged** (the point of the slice): all 22 routes, their URLs, locales,
status codes, canonical/Open Graph metadata, sitemap and robots output, cache
policies, hard 404s, the HttpOnly cookie boundary, the media relay, the comment
proxy and the writing desk.

**Changed:**

- `next` (16.4.2) and its platform packages are gone from the dependency tree.
- `pnpm build` builds `apps/web-rr`; `pnpm typecheck` covers `packages/web-ui`;
  `pnpm test:web` replaces `pnpm test:prototype`; `pnpm check:ssr-parity` and its
  nightly workflow are removed.
- The development chain starts `react-router dev` instead of `next dev`
  (`pnpm dev`, unchanged flags).
- The "React Router prototype · not the production site" banner is gone: there is
  no other site for it to be pointing at.
- The end-to-end suite drives one browser project instead of two, halving its
  runtime without losing a journey.

**Deferred, deliberately:**

These were still Next-branded at the time; both have since been settled, and in
both cases the migration is additive rather than a cutover:

- The canonical site URL is `SITE_URL`. The Next.js-convention name
  `NEXT_PUBLIC_SITE_URL` is still read as a fallback, because deployments hold
  the value in a dashboard this repository cannot edit — a rename that emptied
  every canonical URL on the next deploy would be worse than the name it
  replaced. `SITE_URL` wins when both are set.
- `vercel.json` declares `web` as a container service built from
  `apps/web-rr/Dockerfile` instead of a `nextjs` preset rooted at the deleted
  directory. No Vercel deployment has been run to verify it builds there the way
  `docker build` does locally.
- The application's own default port (3100) and the dev chain's (3000) are
  unchanged; every orchestrated path sets `PORT` explicitly.

## References

- [ADR 0012: Migrate Web to React Router 7 Framework Mode](0012-portable-web-framework-migration.md)
- [Frontend portability migration roadmap](../../roadmap/frontend-portability-migration.md)
