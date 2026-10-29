# Public SSR route migration (Phase 3)

Status 2026-10-29: **the public surface is migrated** — home (`/`, `/en`),
archive, article, author, category index, category detail, search, `sitemap.xml`
and `robots.txt` all render in the React Router prototype (`apps/web-rr`), and a
scripted parity gate (`pnpm check:ssr-parity`) compares them side by side with
the App Router over the same mock API. The App Router app is still authoritative
for production traffic; ADR 0012 forbids switching that before the cutover.

What is still missing is *interaction*, not markup: see §6.

## 1. Why the migration is a load/render split, not a copy

The shared page components in `apps/web/src/components` were written as App
Router **async server components**: `ArticleArchiveContent`,
`AuthorProfileContent` and `SearchContent` each `await` their own data. React
Router server-renders with plain React — no async components, no RSC payload —
so none of them can be imported directly by a route module.

Copying the markup into the prototype would have been faster and would have
guaranteed drift: two trees, two chances to disagree about pagination, empty
states or metadata. Instead each page is now split in two:

| Concern | Where it lives | Framework coupling |
| --- | --- | --- |
| Data (what a page needs, how many calls it costs) | `apps/web/src/lib/public-pages.ts` — `loadArchivePage`, `loadAuthorPage`, `loadSearchPage`, `loadCategoryIndexPage`, `loadCategoryDetailPage` | none (plain functions, plain data) |
| Rendering (what a visitor sees) | `apps/web/src/components/public/{archive,author,search}-view.tsx` — `ArchivePageView`, `AuthorPageView`, `SearchPageView`; plus the already-synchronous `CategoryIndexContent` / `CategoryDetailContent` | `next/link` only, which the prototype aliases to a shim |

The App Router components became three-line wrappers (`await load…` →
`<…PageView {...data} />`), so the Next.js application renders the *same* view
from the *same* loader. The two frameworks cannot drift, because there is only
one implementation of each half.

`CategoryIndexContent` and `CategoryDetailContent` needed no change at all:
they were already synchronous and data-in/props-out, which is the shape the
split deliberately produces.

Home closed the batch with the same split — `loadHomePage()` in
`public-pages.ts` (articles and categories in one `Promise.all`, the category
read degrading to `[]` so a broken taxonomy falls back to the work-type topics)
and `HomePageView` in `components/public/home-view.tsx`, markup moved verbatim.
Its three client components (`PageLoader` intro, `HeroCanvas` WebGL,
`HomeLatest` hover switch) are framework-neutral apart from `next/link`, so they
hydrate in the prototype exactly as they do in Next.js; only their *behaviour*
is Phase 4, and it is not asserted here. Porting home also surfaced a real
dependency bug: `apps/web-rr` reached `gsap` through the source alias to
`apps/web/src/components/motion/*` without declaring it, which only worked by
accident of pnpm's layout. It is now a declared dependency.

Sitemap and robots are the same idea without a view: one builder
(`apps/web/src/lib/site-metadata.ts`) produces the URL set and the robots text,
and each framework contributes a ~15-line adapter — `app/sitemap.ts` /
`app/robots.ts` for the App Router (through Next's `sitemap` / `robots`
conventions), `app/routes/sitemap.xml.ts` / `app/routes/robots.txt.ts` for the
prototype. The two spellings are asserted byte-equal by the parity gate (§4),
which is how a `User-agent` / `User-Agent` case difference was caught.

## 2. Route map (prototype ↔ App Router)

| Prototype route module | Paths | App Router equivalent |
| --- | --- | --- |
| `routes/home.tsx` | `/`, `/en` | `app/page.tsx`, `app/en/page.tsx` |
| `routes/archive.tsx` | `/articles`, `/en/articles` | `app/articles/page.tsx`, `app/en/articles/page.tsx` |
| `routes/article.tsx` | `/articles/:slug`, `/en/articles/:slug` | `app/articles/[slug]/page.tsx`, `app/en/articles/[slug]/page.tsx` |
| `routes/author.tsx` | `/authors/:username`, `/en/authors/:username` | `app/authors/[username]/page.tsx`, `app/en/authors/[username]/page.tsx` |
| `routes/categories.tsx` | `/categories`, `/en/categories` | `app/categories/page.tsx`, `app/en/categories/page.tsx` |
| `routes/category.tsx` | `/categories/:slug`, `/en/categories/:slug` | `app/categories/[slug]/page.tsx`, `app/en/categories/[slug]/page.tsx` |
| `routes/search.tsx` | `/search`, `/en/search` | `app/search/page.tsx`, `app/en/search/page.tsx` |
| `routes/sitemap.xml.ts` | `/sitemap.xml` | `app/sitemap.ts` (same builder) |
| `routes/robots.txt.ts` | `/robots.txt` | `app/robots.ts` (same builder) |

Locale comes from the request path (`app/lib/locale.ts`), which is the same
information the App Router encoded in a differently-named directory.

## 3. Instance shape: 0.1 CPU, cold start, ephemeral disk

The qualified zero-cost host (Render free web service) sleeps when idle, wakes
with a cold start, gets a fraction of one CPU and loses its filesystem on
restart. The migration is shaped around that, in concrete terms:

**Bounded API fan-out.** Every loader issues at most **two** API calls, and
independent calls run together (`Promise.all`). A test asserts this against the
mock API by counting upstream requests per page
(`apps/web-rr/test/prototype.test.ts` → "every migrated public page spends at
most two API calls"). This is the guard that stops a page from silently growing
a third and fourth call once nobody is watching.

**Bounded payloads.** Ceilings are constants in `public-pages.ts`
(`ARCHIVE_TYPE_SCAN_LIMIT`, `AUTHOR_WORKS_LIMIT`, `SEARCH_WORKS_LIMIT`,
`SEARCH_CATEGORY_LIMIT`, `CATEGORY_PAGE_SIZE`, `HOME_LATEST_LIMIT`,
`HOME_CATEGORY_LIMIT`), never "fetch everything". The sitemap is bounded the
same way: `loadSitemapEntries` stops after `SITEMAP_MAX_PAGES` pages of
`SITEMAP_PAGE_SIZE` (5 000 works per locale) instead of paging until the API
returns a short page, which previously made the cost of one crawler request
proportional to the size of the archive.
Pagination stays server-side; the prototype never ships a full table to the
browser to sort there.

**No disk, no in-process cache.** Nothing is written to the filesystem and no
page cache is kept in memory — the disk is ephemeral and the instance may be
duplicated, so a local cache would be both useless and inconsistent between
copies. What replaces it is HTTP caching (`app/lib/http-policy.ts`):

| Pages | `Cache-Control` | Why |
| --- | --- | --- |
| home, article, archive, author, categories | `public, max-age=0, s-maxage=60, stale-while-revalidate=300` | HTML depends only on public data, so a shared cache may hold it and may serve a stale copy while a cold instance wakes. `max-age=0` keeps browsers revalidating. |
| search, account | `no-store, max-age=0` | per-query or per-user output; a shared cache must never hold it. Matches what the App Router sends for dynamic pages today. |

**Hard 404s before HTML.** Unknown articles, authors and categories throw from
the loader (`entityNotFound` in `app/lib/loader-errors.ts` → `data(..., {
status: 404, headers: PRIVATE_PAGE_HEADERS })`), so the status *and* the
cacheability are decided before any markup is committed. A soft 404 would be
indexed, and a cached 404 would keep being served after the entity exists. The
error boundary also sets a title (`404 | 无浪潮`, mirroring `app/not-found.tsx`)
and `noindex, nofollow` (§5 explains why that needed the parity gate to
notice).

**Failures are 503, not 500.** If the content API is unreachable, loaders throw
`upstreamUnavailable(error)` — a 503 with only an error *class* in the payload
(`app/lib/loader-errors.ts`), never a message, stack or URL. The App Router
currently raises a 500 in the same situation; this is a deliberate, documented
difference, because "the page exists but the upstream is down" is exactly what
503 means to a crawler.

## 4. The parity gate: `pnpm check:ssr-parity`

Phase 3's exit criterion is that the two implementations pass the same
behavioural assertions side by side. Until this round that was checked by hand;
`scripts/ssr-parity.ts` makes it executable:

1. builds **both** applications with the same `NEXT_PUBLIC_SITE_URL` (Next.js
   inlines `NEXT_PUBLIC_*` at build time, so an un-matched build would report
   every canonical URL as a difference while proving nothing);
2. starts one mock REST API (`apps/web-rr/mocks/rest-api.ts`) and points both
   applications at it, so a difference in output cannot come from a difference
   in data;
3. starts both production servers on free ports and fetches every migrated
   public route from each;
4. compares **status**, **`<title>`**, **canonical**, the **hreflang** set,
   **content markers**, the **`no-store` class** of private responses, and the
   exact **`sitemap.xml` URL set** and **`robots.txt` text**;
5. exits non-zero on any difference that is not on the known list, and prints
   the reason for each difference that is.

Output of the last local run:

```
ssr-parity: building both applications with NEXT_PUBLIC_SITE_URL=https://no-wave.example
ssr-parity: comparing
SSR parity: 105 comparisons over 17 routes plus sitemap/robots; 0 unexpected difference(s), 19 known divergence(s).
Both implementations agree on status, title, canonical, hreflang and content presence.
```

Two implementation details matter for trusting that output:

- **Content is compared with `<script>` blocks removed.** React Router
  serializes loader data into an inline script, so a naive substring match is
  satisfied by the *payload* rather than by rendered markup — which would let a
  rendering regression pass while a test showed green.
- **Hard 404s are compared as a class, not a string.** Both send `no-store`;
  the exact header spelling is framework-specific.

The gate found four real divergences while it was being written, each now fixed:

| Found | Fix |
| --- | --- |
| The prototype dropped the App Router's title template (`title.template: "%s \| 无浪潮"`) | `titleWithSite()` in `app/lib/meta.ts`, applied by every route |
| `/` carries **no** suffix: the App Router applies the template to descendant segments only, so the root page is the exception | `metaDescriptors(..., { absoluteTitle })` for the default-locale home, asserted by a test |
| 404s had no `<title>`, no `robots` and no `Cache-Control` in the prototype | error boundary sets `404 \| 无浪潮` + `noindex, nofollow`; `entityNotFound()` sends `PRIVATE_PAGE_HEADERS` |
| `robots.txt` disagreed on field case (`User-agent` vs Next's `User-Agent`) | the shared builder now emits the App Router's spelling |

**Not wired into CI.** The gate needs two production builds and two servers,
which is a poor fit for the current job set (§5). It is run locally before each
migration PR and its output is recorded in §5 below; promoting it to a
scheduled or nightly job is the natural next step.

## 5. Known divergences found by the parity check

These are differences the gate reports and does *not* fail on, each with the
reason it is accepted:

| Divergence | Why it is accepted |
| --- | --- |
| Public pages: `public, max-age=0, s-maxage=60, stale-while-revalidate=300` (prototype) vs `private, no-store` (App Router) | This is the migration's purpose: a sleeping free instance needs a shared cache in front of it. |
| `app/page.tsx`, `app/articles/page.tsx`, `app/categories/*` and their `/en` twins canonicalise against `https://example.invalid` | They call `homeMetadata` / `archiveMetadata` / `categoryMetadata` **without** a base URL, so they fall back to the `content.ts` fixture constant instead of `NEXT_PUBLIC_SITE_URL` — while the article and author pages do pass it. Fixing it rewrites canonical URLs in production, which is an SEO-visible change: **an owner decision, not a migration side effect.** The prototype honours the configured origin on every page. |

The second row is the one that needs a decision before cutover.

## 6. Verification status

| Claim | How it was checked |
| --- | --- |
| Every migrated public page renders server-side with API data | `pnpm test:prototype` (28 tests, real HTTP against the production build) |
| English paths render English content and localized canonical URLs | same suite |
| Unknown article / author / category → hard, titled, `no-store` 404 | same suite |
| Query and work-type filtering still scope the archive | same suite |
| Public pages are shared-cacheable; search/account are `no-store` | same suite |
| ≤ 2 API calls per page (home included) | same suite (mock API request counter) |
| `<title>` uses the App Router's template, including the root-page exception | same suite |
| `sitemap.xml` / `robots.txt` are well-formed, bounded and localized | `apps/web/src/lib/site-metadata.test.ts` (4 tests) + the prototype suite |
| **Both implementations agree on status, title, canonical, hreflang and content** | `pnpm check:ssr-parity` (105 comparisons, 0 unexpected differences — output above) |
| The Next.js app is unchanged in behavior | `pnpm build` + `pnpm test:routes` (route smoke, fixtures only) |
| No provider-specific code was introduced | grep: new modules import no host SDK; `MEDIA_S3_*` / `API_BASE_URL` remain the only configuration surface |
| Real hosting behavior (cold start duration, wake latency, memory ceiling) | **not run** — requires a Render deployment, which ADR 0012 forbids before the cutover phase |
| `pnpm check:ssr-parity` in CI | **not run** — see §4 |

## 7. Known gaps

- **Interaction is Phase 4, not migrated or asserted here**: the home hero
  canvas and intro animation, article comments, the reader toolbar and related
  works. The markup for all of them is ported; their behaviour is not
  exercised by either suite.
- **The parity gate is not in CI** (§4) and does not cover locales beyond
  `zh-CN`/`en` (there are none) or the private pages (`/account`, `/write`),
  which the App Router and the prototype deliberately handle differently.
- **Canonical URLs in the App Router still use the fixture origin** (§5) —
  awaiting an owner decision.
- The prototype caps `page` at `MAX_PAGE` (5001) via `parsePage`, while the
  legacy category pages clamp at 50001. Both are far beyond real pagination;
  the App Router pages were left untouched.
- Cold-start and CPU budgets are enforced structurally (call count, payload
  ceilings, no disk writes), not measured on the real host.
