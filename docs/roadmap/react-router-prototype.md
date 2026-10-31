# React Router 7 prototype — Phase 1 report

- Phase: 1 of [the portability roadmap](frontend-portability-migration.md)
- Target: React Router 7.18.5 Framework Mode (`apps/web-rr`)
- Status: prototype builds, serves on plain Node.js and passes its behavior tests
- Not a cutover: `apps/web` (Next.js 16) remains the production Web application

## 1. Why this exists

[The next-step decision](next-step-decision.md) chose the migration over working
the open issues first. [ADR 0012](../architecture/decisions/0012-portable-web-framework-migration.md)
requires the replacement to build and start as a normal Node.js server, prove
public SSR with metadata and hard 404s, keep private responses out of shared
caches, and keep the auth/media boundary portable — all before any production
route is touched. That is what this prototype demonstrates.

## 2. What it is

`apps/web-rr` is a separate workspace package. It shares code with `apps/web`
instead of copying it, and it never imports Next.js.

| Path | Purpose | Why it lives there |
| --- | --- | --- |
| `app/routes.ts` | explicit route table | one place to see every URL, including the `id` needed when the English article route reuses the Chinese module |
| `app/root.tsx` | HTML shell, `<Meta/>`/`<Links/>`/`<Scripts/>`, error boundary | the boundary is what turns a thrown 404 into a real 404 status |
| `app/routes/article.tsx` | public article, both locales | loader owns data so the component stays synchronous (see finding F1) |
| `app/routes/home.tsx` | public list | renders the **unmodified** shared `WorkRow`/`SectionHeading` |
| `app/routes/sign-in.tsx` | shared interactive form | unchanged shared `SignInForm` (client state, pending, error, success) |
| `app/routes/account.tsx` | private route | redirect when signed out, `no-store` shell when a session exists; the account itself is resolved in the browser by the shared `AccountPanel` |
| `app/routes/api.authoring.email-verification.ts` | resource route | three-line adapter, same handler as the App Router route |
| `app/routes/api.auth.ts` | resource route | three-line adapter over a framework-neutral handler |
| `app/lib/auth-proxy.ts` | auth boundary | standard `Request`/`Response`; no React Router or Next types |
| `app/lib/meta.ts` | SEO adapter | converts the shared metadata objects into React Router `meta` descriptors |
| `app/lib/runtime.ts` | `API_BASE_URL` resolution | reuses `resolveApiBaseUrl` so precedence and validation are identical to `apps/web` |
| `app/shims/next-link.tsx`, `app/shims/next-navigation.ts` | framework adapters | the complete list of unused-API differences the shared components need |
| `server.ts` | production server | `node:http` + `@react-router/node`; no Express, no platform adapter |
| `mocks/rest-api.ts` | deterministic REST API | the tests talk HTTP to a real server instead of stubbing `fetch` |
| `test/prototype.test.ts` | behavior tests | 14 assertions over HTTP against the production build |

Reuse is expressed with two Vite alias groups rather than edits:

```ts
"@/*"            -> ../web/src/*        // shared components, copy, content helpers
"next/link"      -> app/shims/next-link.tsx
"next/navigation"-> app/shims/next-navigation.ts
```

That choice is deliberate. Copying the components would create a fork that drifts
while the Next.js app is still live; aliasing keeps one implementation and makes
the remaining framework coupling **countable** (`grep -rn 'from "next' apps/web/src`
→ 11 `next/link`, 2 `next/navigation`, 1 `next/server`). Each shim can later be
deleted from the shared component in one small commit instead of during a rewrite.

## 3. Phase 1 gates and the evidence

| Gate (ADR 0012 / roadmap) | Evidence | Test |
| --- | --- | --- |
| Builds on a clean checkout, starts as a normal Node server without Vercel bindings | `react-router build` then `node server.ts`; the test process passes `API_SERVICE_URL=""` and never sets any Vercel variable | all tests (server under test is the production build) |
| Public article renders server HTML | title, author, blockquotes, lists and code appear in the raw HTTP body | `article route server-renders content…` |
| Metadata: title, description, canonical, hreflang, Open Graph | emitted from the shared `articleMetadata` | same test |
| Hard 404 for an unknown slug | `404` status, not a soft 404 page | `an unknown article is a hard 404…` |
| Locale behavior preserved | `/en/articles/:slug` renders `lang="en"` with localized canonical | `the English article route…` |
| Private route does not leak user data or enter shared caches | `Cache-Control: no-store`; the HTML is a shell with no address, no token and no account data — all three are resolved by the browser from `/api/authoring/session` | `a live session marker opens a private, no-store, data-free account shell` |
| Signed-out access redirects instead of rendering an empty shell | `302` to `/sign-in?next=%2Faccount`; an expired or unparseable marker behaves the same | three tests |
| Client-interactive form with pending/success/error | shared `SignInForm` posts to a real resource route: success sets cookies, 401 surfaces the API message, 415/403 are rejected before the API | `a successful sign-in…`, `rejected credentials…`, `a cross-origin mutation…`, `a non-JSON body…` |
| Mocked REST API errors are handled | the mock returns real 401/404/400 responses over HTTP | as above |

Security assertions kept from the Next.js implementation: exact-Origin check on
mutations, JSON-only bodies with a 4 KiB ceiling, tokens only in `HttpOnly`
`SameSite=Lax` cookies on the documented paths, no token value in any
browser-visible JSON, `Secure` derived from the browser-facing scheme
(`x-forwarded-proto` on TLS-terminating proxies), and clearing every session
cookie on logout.

## 4. Findings that change the plan

**F1 — React has no async server components outside RSC.** `ArticleDetailContent`,
`ArticleArchiveContent` and `AuthorProfileContent` in `apps/web/src/components`
are `async` functions that await API calls. Under Next.js they are Server
Components; React Router cannot render them as components at all. The prototype
therefore hoists the fetch into the route `loader` and renders a synchronous
page. Phase 3 must do this to the shared page components too (move the fetch into
the loader/caller) — that refactor is also valid for the Next.js app, so it can be
done once, before or during the migration, with the route smoke tests as the
safety net. This is the single largest known piece of work in the migration.

**F2 — metadata is already portable.** `articleMetadata`/`archiveMetadata`/
`homeMetadata` return plain objects; only the `Metadata` cast in the App Router
pages is Next-specific. `app/lib/meta.ts` converts them to React Router
descriptors in ~40 lines, which means SEO parity is a mapping problem, not a
rewrite.

**F3 — `set-cookie` must be appended, never joined.** Building `Response` headers
with a single combined value produces one malformed cookie. The handler appends
each cookie to the response headers; this is asserted by the sign-in test, which
requires two separate `Set-Cookie` lines.

**F4 — server configuration must be read at runtime.** Defining
`process.env.NEXT_PUBLIC_SITE_URL` at build time silently froze canonical URLs
into the SSR bundle, so a deployment could not change its own origin. The
prototype reads configuration at request time and only uses `process.loadEnvFile`
for the repository-root `.env.local` (shell values still win, matching the
documented precedence).

**F5 — `onlyBuiltDependencies` is now required.** pnpm 10 blocks dependency build
scripts by default; Vite's `esbuild` binary needs its postinstall allowed. The
allow-list lives in `pnpm-workspace.yaml` rather than being approved ad hoc, so a
clean `--frozen-lockfile` install works in CI.

**F6 — the `request.url`/`Host` distinction carries over.** The origin check
reuses `isSameOriginMutation`, which compares against the `Host` header. A Node
adapter happens to give the real URL, but relying on that would reintroduce the
`403 ORIGIN_REJECTED` defect fixed in #81 for reverse-proxied deployments.

**F7 — a private page render cannot read the session cookies.** The token cookies
are scoped to `/api/authoring` and `/api`, so the browser never sends them to
`/account`. The first account route read `nw_access` out of the request anyway
and passed its tests, because the tests were the ones setting the cookie — in a
browser the route could only ever redirect, which is why signing in with
`next=/account` (this app's default) bounced straight back to the form.

The fix keeps that scoping and adds the missing piece: `nw_session`, an
`HttpOnly` cookie scoped to `/` whose value is the moment the session can no
longer be renewed. It carries no credential and grants nothing; it only decides
between "redirect" and "render the shell". Who the visitor is still comes from
`/api/authoring/session`, which is the request that can present the access token.

Widening the token cookies to `/` was the alternative and was rejected: the API
rotates the refresh token on every use, so a page render must never be the thing
that refreshes it — two concurrent renders would invalidate each other's
session.

## 5. What this does not do

- No production route, dependency, DNS, deployment or data change. `apps/web`
  builds and passes its own tests unchanged.
- Comments, reader toolbar, related works, media proxy, the writing desk, search,
  sitemap/robots, SSE and the notification worker are **not** ported. They are
  Phase 3–5 work; the article page states this in the page itself.
- The hosting qualification gate is untouched: no provider has been verified, so
  no provider-specific code exists.
- No browser-based hydration test. The tests assert server behavior over HTTP;
  a Playwright-class check is still needed before cutover.
- `pnpm dev` (probe-driven local chain) still starts the Next.js app; the
  prototype has its own `pnpm dev:rr`.

## 6. How to run it

```sh
pnpm install
pnpm --filter @bot-thk/web-rr build      # or: pnpm rr:build

# serve the build (defaults to :3100; API_BASE_URL comes from .env.local or the shell)
API_BASE_URL=http://127.0.0.1:4000 pnpm rr:start

# behavior tests (builds first, then boots the server + a mock REST API)
pnpm test:prototype

# dev server with HMR
pnpm dev:rr
```

With no `API_BASE_URL`, public content falls back to the same in-repo fixtures the
Next.js app uses — the same rule, inherited from `apps/web/src/lib/api-content.ts`.

## 7. Next step

Phase 2: move the remaining auth/media HTTP behavior into framework-neutral
modules with contract tests (cookie paths/options, exact-Origin validation, token
refresh and retry, invalid-refresh logout, payload limits, private cache headers),
then run the hosting qualification gate against this build. Phase 3 starts with
F1: hoisting data fetches out of the three shared async page components.
