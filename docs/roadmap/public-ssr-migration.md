# Public SSR route migration (Phase 3)

Status 2026-10-29: **first batch landed** — archive, author, category index,
category detail and search now render in the React Router prototype
(`apps/web-rr`); home remains the Phase 2 placeholder and the App Router app is
still authoritative for production traffic.

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

## 2. Route map (prototype ↔ App Router)

| Prototype route module | Paths | App Router equivalent |
| --- | --- | --- |
| `routes/home.tsx` | `/` | `/` (placeholder; full home is Phase 4 — hero canvas and page loader are client components) |
| `routes/archive.tsx` | `/articles`, `/en/articles` | `app/articles/page.tsx`, `app/en/articles/page.tsx` |
| `routes/article.tsx` | `/articles/:slug`, `/en/articles/:slug` | `app/articles/[slug]/page.tsx`, `app/en/articles/[slug]/page.tsx` |
| `routes/author.tsx` | `/authors/:username`, `/en/authors/:username` | `app/authors/[username]/page.tsx`, `app/en/authors/[username]/page.tsx` |
| `routes/categories.tsx` | `/categories`, `/en/categories` | `app/categories/page.tsx`, `app/en/categories/page.tsx` |
| `routes/category.tsx` | `/categories/:slug`, `/en/categories/:slug` | `app/categories/[slug]/page.tsx`, `app/en/categories/[slug]/page.tsx` |
| `routes/search.tsx` | `/search`, `/en/search` | `app/search/page.tsx`, `app/en/search/page.tsx` |

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
`SEARCH_CATEGORY_LIMIT`, `CATEGORY_PAGE_SIZE`), never "fetch everything".
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

**Hard 404s before HTML.** Unknown authors and categories throw from the loader
(`data(..., { status: 404 })`), so the status is decided before any markup is
committed. A soft 404 would be indexed.

**Failures are 503, not 500.** If the content API is unreachable, loaders throw
`upstreamUnavailable(error)` — a 503 with only an error *class* in the payload
(`app/lib/loader-errors.ts`), never a message, stack or URL. The App Router
currently raises a 500 in the same situation; this is a deliberate, documented
difference, because "the page exists but the upstream is down" is exactly what
503 means to a crawler.

## 4. Verification status

| Claim | How it was checked |
| --- | --- |
| Archive/author/category/search render server-side with API data | `pnpm test:prototype` (20 tests, real HTTP against the production build) |
| English paths render English content and localized canonical URLs | same suite |
| Unknown author / category → 404, not a soft 404 | same suite |
| Query and work-type filtering still scope the archive | same suite |
| Public pages are shared-cacheable; search/account are `no-store` | same suite |
| ≤ 2 API calls per page | same suite (mock API request counter) |
| The Next.js app is unchanged in behavior | `pnpm build` + `pnpm test:routes` (route smoke, fixtures only) |
| No provider-specific code was introduced | grep: new modules import no host SDK; `MEDIA_S3_*` / `API_BASE_URL` remain the only configuration surface |
| Real hosting behavior (cold start duration, wake latency, memory ceiling) | **not run** — requires a Render deployment, which ADR 0012 forbids before the cutover phase |
| Sitemap/robots parity | **not migrated yet** (see gaps) |

## 5. Known gaps

- **Home** (`/`, `/en`) is still the Phase 2 placeholder. The real home depends
  on `HeroCanvas` and `PageLoader`, which are client components with hydration
  behavior — Phase 4 territory. The same load/render split will apply
  (`loadHomePage` + `HomePageView`).
- **`/en` home and sitemap/robots** are not ported; `sitemap.xml` and
  `robots.txt` still come from the App Router only.
- **Article detail** renders a reduced body: comments, reader toolbar and
  related works are client-interactive (Phase 4).
- The prototype caps `page` at `MAX_PAGE` (5001) via `parsePage`, while the
  legacy category pages clamp at 50001. Both are far beyond real pagination;
  the App Router pages were left untouched.
- Cold-start and CPU budgets are enforced structurally (call count, payload
  ceilings, no disk writes), not measured on the real host.
