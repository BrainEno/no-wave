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
SSR parity: 105 comparisons over 17 routes plus sitemap/robots; 0 unexpected difference(s), 13 known divergence(s).
Both implementations agree on status, title, canonical, hreflang and content presence.
```

Two implementation details matter for trusting that output:

- **Content is compared with `<script>` blocks removed.** React Router
  serializes loader data into an inline script, so a naive substring match is
  satisfied by the *payload* rather than by rendered markup — which would let a
  rendering regression pass while a test showed green.
- **Hard 404s are compared as a class, not a string.** Both send `no-store`;
  the exact header spelling is framework-specific.
- **Hreflang targets are compared, not just the language list.** A page that
  announces `en` but points it at the Chinese URL is a classic SEO bug and it is
  invisible if only `hrefLang` values are checked. The whole set is compared as
  `lang target` pairs; a deliberate one-character mutation of the target was
  used to confirm the check fails when it should.

The gate found four real divergences while it was being written, each now fixed:

| Found | Fix |
| --- | --- |
| The prototype dropped the App Router's title template (`title.template: "%s \| 无浪潮"`) | `titleWithSite()` in `app/lib/meta.ts`, applied by every route |
| `/` carries **no** suffix: the App Router applies the template to descendant segments only, so the root page is the exception | `metaDescriptors(..., { absoluteTitle })` for the default-locale home, asserted by a test |
| 404s had no `<title>`, no `robots` and no `Cache-Control` in the prototype | error boundary sets `404 \| 无浪潮` + `noindex, nofollow`; `entityNotFound()` sends `PRIVATE_PAGE_HEADERS` |
| `robots.txt` disagreed on field case (`User-agent` vs Next's `User-Agent`) | the shared builder now emits the App Router's spelling |
| **The App Router's home and archive pages canonicalised against `https://example.invalid`** | `configuredSiteUrl()` (§5) — the gate no longer excuses it |
| The prototype emitted `https://site.example/` where the App Router resolves the root to `https://site.example` | `routerUrl()` in `app/lib/meta.ts`; the two spellings identify the same resource, so this is byte-parity only |

**Runs nightly in CI**, not per commit: `.github/workflows/ssr-parity.yml`
(schedule + `workflow_dispatch`) builds both applications and runs the gate. A
check that only a person remembers to run quietly stops being true, so it runs
against `main` every night; it stays out of `required-checks` because a nightly
job must not block a merge. The trade-off is accepted and recorded in §7: a
regression is caught within a day, not before the merge button.

## 5. The one divergence the gate accepts, and the decision it forced

| Divergence | Why it is accepted |
| --- | --- |
| Public pages: `public, max-age=0, s-maxage=60, stale-while-revalidate=300` (prototype) vs `private, no-store` (App Router) | This is the migration's purpose: a sleeping free instance needs a shared cache in front of it. |

### Decision: canonical URLs must use the configured origin (landed 2026-10-29)

The gate's first run reported a second divergence: `app/page.tsx`,
`app/en/page.tsx`, `app/articles/page.tsx` and `app/en/articles/page.tsx` built
their `canonical` and `hreflang` links from the `content.ts` fixture constant
`https://example.invalid`, because they called `homeMetadata` / `archiveMetadata`
without a base URL — while the article and author pages did pass
`NEXT_PUBLIC_SITE_URL`. Fixing it changes what search engines see in production,
so it was escalated instead of taken as a side effect of a migration PR.

It is now fixed, on these grounds:

- `docs/deployment/vercel.md` already defines `NEXT_PUBLIC_SITE_URL` as *"the
  canonical public website URL for metadata"*, so a page that ignores it is
  contradicting the project's own configuration contract — a defect, not a
  deliberate choice.
- The origin is resolved in **one** function, `configuredSiteUrl()`
  (`apps/web/src/lib/site-metadata.ts`), used by every page, by the sitemap, by
  robots and by `metadataBase`. Six copies of the
  `?? "https://example.invalid"` fallback became one.
- **Where the variable is unset, behaviour is byte-identical to today** — the
  fallback is the same constant. Nothing changes for a deployment that does not
  configure it.

**The one production-visible effect:** on an environment that *does* configure
`NEXT_PUBLIC_SITE_URL`, the home and archive pages now emit that origin in their
`canonical` and `hreflang` links instead of the placeholder. Because
`NEXT_PUBLIC_*` is inlined at build time, this takes effect on the next deploy,
not on restart. Reverting the decision is one line per page (drop the second
argument) — the gate would then fail again, which is the point.

The gate no longer excuses this: the known-divergence entry was deleted, so a
regression now fails the run.

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
| `sitemap.xml` / `robots.txt` are well-formed, bounded and localized | `apps/web/src/lib/site-metadata.test.ts` (5 tests) + the prototype suite |
| **Both implementations agree on status, title, canonical, hreflang targets and content** | `pnpm check:ssr-parity` (105 comparisons, 0 unexpected differences — output above) |
| Every page's canonical origin comes from one function, with the same fallback when it is unset | `apps/web/src/lib/site-metadata.test.ts` (5 tests) |
| The Next.js app still renders every page, and its canonical origin is resolved once | `pnpm build` + `pnpm test:routes` (route smoke, fixtures only) + `pnpm check:ssr-parity` (the behaviour change is scoped in §5) |
| No provider-specific code was introduced | grep: new modules import no host SDK; `MEDIA_S3_*` / `API_BASE_URL` remain the only configuration surface |
| Real hosting behavior (cold start duration, wake latency, memory ceiling) | **not run** — requires a Render deployment, which ADR 0012 forbids before the cutover phase |
| `pnpm check:ssr-parity` in CI | the nightly workflow was **dispatched by hand against this branch** after the push — see the run linked in the PR. The scheduled (nightly) trigger has not fired yet, because it only exists from the moment the workflow lands on `main`. |
| `pnpm check:ssr-parity` as a per-PR gate | **no** — nightly only, by design (§4) |

## 7. Known gaps

- **Interaction is Phase 4, not migrated or asserted here**: the home hero
  canvas and intro animation, article comments, the reader toolbar and related
  works. The markup for all of them is ported; their behaviour is not
  exercised by either suite.
- **The parity gate runs nightly, not per PR** (§4). A regression is caught
  within a day rather than before the merge button; closing that gap means
  making the run fast enough (a shared build cache, or comparing against
  committed fixtures) to sit on the commit path.
- It does not cover locales beyond `zh-CN`/`en` (there are none) or the private
  pages (`/account`, `/write`), which the App Router and the prototype
  deliberately handle differently.
- **The canonical-origin change is only as good as the deployment's
  configuration** (§5): where `NEXT_PUBLIC_SITE_URL` is unset, every canonical
  URL still resolves to the `https://example.invalid` placeholder. That is now
  consistent across pages and visible in one place, but it is not fixed by
  code — someone has to configure the variable in each environment.
- The prototype caps `page` at `MAX_PAGE` (5001) via `parsePage`, while the
  legacy category pages clamp at 50001. Both are far beyond real pagination;
  the App Router pages were left untouched.
- Cold-start and CPU budgets are enforced structurally (call count, payload
  ceilings, no disk writes), not measured on the real host.
