/**
 * Archive, author and category pages, search, sitemap and feeds, titles, hard 404s and API call budgets.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { validateArticleSlug } from "../../api/src/domain/article.ts";
import { isPublicEntitySlug } from "../app/lib/loader-errors.ts";
import { MOCK_COMMENT_ID, MOCK_DISPLAY_NAME, MOCK_MEDIA, MOCK_TOKENS } from "../mocks/rest-api.ts";
import { registerPublicWebApp, API_CALL_BUDGET, freePort, get, mockApi, post, upstreamCalls, withEnvServer } from "./support/web-behavior-harness.ts";

registerPublicWebApp();

test("archive is server-rendered, localized and shared-cacheable", async () => {
  const result = await get("/articles");
  assert.equal(result.status, 200);
  assert.match(result.body, /可移植的文学基础设施/);
  assert.match(result.body, /rel="canonical" href="https:\/\/no-wave\.example\/articles"/);
  assert.match(result.body, /rel="alternate" hrefLang="en"/);
  assert.match(result.headers.get("cache-control") ?? "", /public/);
  assert.match(result.headers.get("cache-control") ?? "", /s-maxage=60/);
  assert.match(result.headers.get("cache-control") ?? "", /stale-while-revalidate=300/);

  const english = await get("/en/articles");
  assert.equal(english.status, 200);
  assert.match(english.body, /A Portable Literary Foundation/);
  assert.match(english.body, /rel="canonical" href="https:\/\/no-wave\.example\/en\/articles"/);
});

test("archive filters by query and by work type without extra API calls", async () => {
  const matching = await get("/articles?q=抵抗");
  assert.equal(matching.status, 200);
  assert.match(matching.body, /作为抵抗的阅读/);
  assert.doesNotMatch(matching.body, /可移植的文学基础设施/);

  const empty = await get("/articles?q=肯定不存在的关键词");
  assert.equal(empty.status, 200);
  assert.match(empty.body, /没有符合条件的作品/);

  const byType = await get("/articles?type=novel");
  assert.equal(byType.status, 200);
  assert.match(byType.body, /作为抵抗的阅读/);
  assert.doesNotMatch(byType.body, /可移植的文学基础设施/);
  // Type filtering scans a bounded window and is served by one call.
  assert.equal((await upstreamCalls("/articles?type=novel")).length, 1);

  // A link from before ADR 0054 still filters, to the group its type folded into.
  const legacy = await get("/articles?type=short_story");
  assert.equal(legacy.status, 200);
  assert.match(legacy.body, /作为抵抗的阅读/);
  assert.doesNotMatch(legacy.body, /可移植的文学基础设施/);
});

test("author pages render the profile and its catalogue, unknown authors are 404", async () => {
  const result = await get("/authors/writer");
  assert.equal(result.status, 200);
  assert.match(result.body, new RegExp(MOCK_DISPLAY_NAME));
  assert.match(result.body, /可移植的文学基础设施/);
  assert.match(result.body, /rel="canonical" href="https:\/\/no-wave\.example\/authors\/writer"/);

  const missing = await get("/authors/nobody");
  assert.equal(missing.status, 404);
  assert.match(missing.body, /这一页不存在/);
});

/**
 * The author directory (ADR 0024).
 *
 * Server-rendered like the category index it sits beside, with the two numbers a
 * row promises — how much of the author is here and how many readers follow them
 * — read from the endpoint rather than counted by the page. A name that matches
 * nobody is an empty directory, not an error.
 */
test("the author directory is server-rendered and searched by name", async () => {
  const index = await get("/authors");
  assert.equal(index.status, 200);
  assert.match(index.body, /林可行/);
  assert.match(index.body, /href="\/authors\/writer"/);
  assert.match(index.body, /2 篇作品/);
  assert.match(index.body, /12 人关注/);

  const english = await get("/en/authors");
  assert.equal(english.status, 200);
  assert.match(english.body, /林可行/);

  const searched = await get("/authors?q=" + encodeURIComponent("林可行"));
  assert.equal(searched.status, 200);
  assert.match(searched.body, /href="\/authors\/writer"/);

  const nobody = await get("/authors?q=zzz-nobody");
  assert.equal(nobody.status, 200, "a name with no author is an empty directory, not an error");
  assert.match(nobody.body, /没有符合搜索条件的作者/);
});

test("the category index lists the three genres with counts; an editor category still answers", async () => {
  // ADR 0054: /categories is 小说 / 诗歌 / 其他文体, each linking to the
  // archive filtered to it. The mock has one novel and one other-form work.
  const index = await get("/categories");
  assert.equal(index.status, 200);
  for (const [type, label] of [["novel", "小说"], ["poetry", "诗歌"], ["other", "其他文体"]]) {
    assert.match(index.body, new RegExp(`<a [^>]*data-genre="${type}" href="/articles\\?type=${type}"`));
    assert.match(index.body, new RegExp(`<h2>${label}</h2>`));
  }
  assert.match(index.body, /data-genre="novel"[\s\S]*?1 篇/);
  assert.match(index.body, /data-genre="poetry"[\s\S]*?0 篇/);
  assert.doesNotMatch(index.body, /href="\/categories\/essays"/, "editor categories are out of the index");

  // …but an editor category's own page is still reachable by its link.
  const detail = await get("/categories/essays");
  assert.equal(detail.status, 200);
  assert.match(detail.body, /可移植的文学基础设施/);

  const english = await get("/en/categories");
  assert.equal(english.status, 200);
  assert.match(english.body, /<h2>Fiction<\/h2>/);
  assert.match(english.body, /<h2>Other forms<\/h2>/);

  const missing = await get("/categories/does-not-exist");
  assert.equal(missing.status, 404);
  assert.match(missing.body, /这一页不存在/);
});

test("search is server-rendered, no-store and excluded from indexing", async () => {
  // Search is locale-scoped: the query is run against the content in the
  // language of the path.
  const result = await get("/search?q=抵抗");
  assert.equal(result.status, 200);
  assert.match(result.body, /作为抵抗的阅读/);
  assert.doesNotMatch(result.body, /可移植的文学基础设施/);

  const english = await get("/en/search?q=portable");
  assert.equal(english.status, 200);
  assert.match(english.body, /A Portable Literary Foundation/);
  assert.match(result.headers.get("cache-control") ?? "", /no-store/);
  assert.match(result.body, /name="robots" content="noindex, follow"/);

  const empty = await get("/search");
  assert.equal(empty.status, 200);
  assert.match(empty.body, /按类型浏览/);
});

test("every migrated public page spends at most its API call budget", async () => {
  for (const [pathname, budget] of API_CALL_BUDGET) {
    const calls = await upstreamCalls(pathname);
    assert.ok(calls.length >= 1, `${pathname} must read content from the API, not fixtures`);
    assert.ok(calls.length <= budget, `${pathname} exceeded its ${budget}-call budget: ${calls.join(", ")}`);
  }
});

/**
 * The three shelves (ADR 0016).
 *
 * What makes this worth asserting is that the mock's featured shelf is in the
 * *reverse* of the publication order: a home page that shows "作为抵抗的阅读"
 * first has read the shelf, while one that shows "可移植的文学基础设施" first has
 * quietly sorted the newest works and labelled them 精选. The fallback copy is
 * asserted absent for the same reason — it must appear only when the shelf is
 * empty, never as a permanent caption.
 */
test("the home page renders the editorial shelf, the newest works and the most saved", async () => {
  const home = await get("/");
  assert.equal(home.status, 200);

  // The shelf wins over chronology.
  const picked = home.body.indexOf("作为抵抗的阅读");
  const newest = home.body.indexOf("可移植的文学基础设施");
  assert.ok(picked >= 0 && newest >= 0, "both works are on the page");
  assert.ok(picked < newest, "the editor's order beats the publication order");
  assert.doesNotMatch(home.body, /data-featured-fallback/, "the shelf is not empty, so no fallback copy");

  // "Most saved" is its own section, and the count that ordered it is visible.
  assert.match(home.body, /id="popular"/);
  assert.match(home.body, /30 次收藏/);
  const popularAt = home.body.indexOf('id="popular"');
  assert.ok(home.body.indexOf("作为抵抗的阅读", popularAt) > popularAt, "the most-saved work leads the section");
});

/* --------------------------------------------------- Phase 5a: media adapter */

/**
 * Media relayed through the app rather than the bucket.
 *
 * The storage credentials stay in the API; what is asserted here is what the
 * browser is allowed to see — immutable caching keyed on a content hash, 304
 * revalidation, a locked-down content type, and an upload path that rejects
 * cross-origin and non-image requests before buffering anything.
 */
test("a media object is relayed with immutable caching and its content-hash ETag", async () => {
  const result = await get(`/api/media/${MOCK_MEDIA.id}`);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("content-type"), "image/webp");
  assert.match(result.headers.get("cache-control") ?? "", /public, max-age=31536000, immutable/);
  assert.equal(result.headers.get("etag"), MOCK_MEDIA.etag);
  assert.equal(result.headers.get("x-content-type-options"), "nosniff");
  assert.equal(result.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assert.equal(Number(result.headers.get("content-length")), MOCK_MEDIA.bytes.byteLength);
});

test("a conditional media request is answered with 304 and no body", async () => {
  const result = await get(`/api/media/${MOCK_MEDIA.id}`, { "if-none-match": MOCK_MEDIA.etag });
  assert.equal(result.status, 304);
  assert.equal(result.headers.get("etag"), MOCK_MEDIA.etag);
  assert.equal(result.body, "");
});

test("an unknown or malformed media id is a 404 that never reaches the API", async () => {
  mockApi.resetRequests();
  for (const pathname of ["/api/media/not-a-uuid", `/api/media/${"0".repeat(8)}-0000-0000-0000-000000000000`]) {
    const result = await get(pathname);
    assert.equal(result.status, 404);
    assert.match(result.body, /NOT_FOUND/);
  }
  assert.deepEqual(mockApi.requests(), []);
});

test("media uploads are origin-checked, type-checked and authenticated", async () => {
  const crossOrigin = await post("/api/authoring/media", "x".repeat(32), {
    origin: "https://attacker.example",
    "content-type": "image/png",
  });
  assert.equal(crossOrigin.status, 403);
  assert.match(crossOrigin.body, /ORIGIN_REJECTED/);

  const wrongType = await post("/api/authoring/media", "x".repeat(32), { "content-type": "text/html" });
  assert.equal(wrongType.status, 415);
  assert.match(wrongType.body, /UNSUPPORTED_MEDIA_TYPE/);

  const anonymous = await post("/api/authoring/media", "x".repeat(32), { "content-type": "image/png" });
  assert.equal(anonymous.status, 401);

  const signedIn = await post("/api/authoring/media", "x".repeat(32), {
    "content-type": "image/png",
    cookie: `nw_access=${MOCK_TOKENS.accessToken}`,
  });
  assert.equal(signedIn.status, 201);
  assert.match(signedIn.body, new RegExp(MOCK_MEDIA.id));
  assert.match(signedIn.headers.get("cache-control") ?? "", /no-store/);
});

/* ------------------------------------------------ Phase 3: home, sitemap, robots */

test("home is server-rendered from the shared home view for both locales", async () => {
  const result = await get("/");
  assert.equal(result.status, 200);
  // The hero, the selected triptych and the topic row are all in the first
  // response: no client-side navigation is required to see the page.
  assert.match(result.body, /data-hero/);
  assert.match(result.body, /nw-tri/);
  assert.match(result.body, /id="topics"/);
  assert.match(result.body, /可移植的文学基础设施/);
  // The three genre columns replace the editor-category chips (ADR 0054): each
  // genre keeps its column even when empty, and links to the filtered archive.
  const genres = result.body.slice(result.body.indexOf("data-home-genres"));
  for (const type of ["novel", "poetry", "other"]) {
    assert.match(genres, new RegExp(`data-genre="${type}"[\\s\\S]*?href="/articles\\?type=${type}"`));
  }
  assert.match(genres, /data-genre="novel"[\s\S]*?href="\/articles\/reading-as-resistance"[\s\S]*?data-genre="poetry"/);
  assert.match(genres, /data-genre="poetry"[\s\S]*?还没有发表的作品。[\s\S]*?data-genre="other"/);
  assert.match(genres, /data-genre="other"[\s\S]*?href="\/articles\/portable-web-foundation"/);
  assert.doesNotMatch(result.body, /href="\/categories\/(essays|fiction)"/);
  assert.match(result.body, /href="\/articles\/portable-web-foundation"/);
  // The site root is published as the bare origin (no trailing slash);
  // `routerUrl()` in app/lib/meta.ts spells it that way. The hreflang target is
  // asserted too — a link that announces `zh-CN` and points somewhere else is a
  // real SEO bug.
  assert.match(result.body, /rel="canonical" href="https:\/\/no-wave\.example"\/>/);
  assert.match(result.body, /rel="alternate" hrefLang="zh-CN" href="https:\/\/no-wave\.example"\/>/);
  assert.match(result.body, /rel="alternate" hrefLang="en" href="https:\/\/no-wave\.example\/en"\/>/);
  assert.match(result.headers.get("cache-control") ?? "", /s-maxage=60/);

  const english = await get("/en");
  assert.equal(english.status, 200);
  assert.match(english.body, /<html lang="en"/);
  assert.match(english.body, /A Portable Literary Foundation/);
  assert.match(english.body, /rel="canonical" href="https:\/\/no-wave\.example\/en"/);
});

test("sitemap.xml lists both locales and robots.txt points at it", async () => {
  const sitemap = await get("/sitemap.xml");
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.headers.get("content-type") ?? "", /application\/xml/);
  assert.match(sitemap.body, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.match(sitemap.body, /<loc>https:\/\/no-wave\.example\/<\/loc>/);
  assert.match(sitemap.body, /<loc>https:\/\/no-wave\.example\/en\/articles<\/loc>/);
  assert.match(sitemap.body, /<loc>https:\/\/no-wave\.example\/authors\/writer<\/loc>/);
  assert.match(sitemap.body, /<loc>https:\/\/no-wave\.example\/en\/articles\/portable-web-foundation<\/loc>/);
  // Shared-cacheable: crawlers hit it repeatedly and it is expensive to build.
  assert.match(sitemap.headers.get("cache-control") ?? "", /s-maxage/);

  const robots = await get("/robots.txt");
  assert.equal(robots.status, 200);
  assert.match(robots.headers.get("content-type") ?? "", /text\/plain/);
  assert.match(robots.body, /User-Agent: \*/);
  assert.match(robots.body, /Sitemap: https:\/\/no-wave\.example\/sitemap\.xml/);
});

test("the site-wide feed is advertised on home and the archive and serves the newest works", async () => {
  for (const [path, prefix] of [["/", ""], ["/articles", ""], ["/en", "/en"], ["/en/articles", "/en"]] as const) {
    const page = await get(path);
    assert.equal(page.status, 200, path);
    assert.match(page.body, new RegExp(`<link rel="alternate" type="application/atom\\+xml" title="[^"]+" href="https://no-wave\\.example${prefix}/articles/feed\\.atom"/>`), path);
    assert.match(page.body, new RegExp(`<link rel="alternate" type="application/rss\\+xml" title="[^"]+" href="https://no-wave\\.example${prefix}/articles/feed\\.xml"/>`), path);
  }
  // The archive also offers the same subscribe buttons a tag page has: plain
  // links, because a client-side route change into a resource route has no page.
  const archive = await get("/articles");
  assert.match(archive.body, /<nav aria-label="订阅最新作品" data-site-feed/);
  assert.match(archive.body, /<a class="nw-btn nw-sec" href="\/articles\/feed\.atom" type="application\/atom\+xml">订阅(?:<!-- -->)? (?:<!-- -->)?Atom<\/a>/);

  const atom = await get("/articles/feed.atom");
  assert.equal(atom.status, 200);
  assert.equal(atom.headers.get("content-type"), "application/atom+xml; charset=utf-8");
  assert.match(atom.body, /<id>https:\/\/no-wave\.example\/articles\/reading-as-resistance<\/id>/);
  assert.match(atom.body, /<category term="小说"\/>/);
  const rss = await get("/en/articles/feed.xml");
  assert.equal(rss.status, 200);
  assert.equal(rss.headers.get("content-type"), "application/rss+xml; charset=utf-8");
  // A dot is never part of an article slug, so these addresses never reach the article route.
  assert.equal((await get("/articles/feed.json")).status, 404);
});

test("page titles carry the site suffix, and the root page does not", async () => {
  // The title template applies to descendant segments only, so `/` is served
  // with the bare home title while `/en` carries the suffix. Both spellings are
  // asserted here because they are what search engines see.
  const home = await get("/");
  assert.match(home.body, /<title>以文学作品为中心，构建独立的数字出版空间<\/title>/);

  const englishHome = await get("/en");
  assert.match(englishHome.body, /<title>A home for serious literature | 无浪潮<\/title>/);

  // Strings taken from the shared search view.
  const search = await get("/search?q=抵抗");
  assert.match(search.body, /<title>搜索 | 无浪潮<\/title>/);

  const englishSearch = await get("/en/search?q=portable");
  assert.match(englishSearch.body, /<title>Search | 无浪潮<\/title>/);

  const categories = await get("/categories");
  assert.match(categories.body, /<title>作品分类 | 无浪潮<\/title>/);
});

test("a missing public entity is a hard 404 that is titled, no-store and noindex", async () => {
  for (const pathname of ["/articles/does-not-exist", "/authors/nobody", "/categories/does-not-exist"]) {
    const result = await get(pathname);
    assert.equal(result.status, 404, `${pathname} must be a hard 404`);
    // A crawler must see a page that says what happened, and must not be given
    // a copy that a shared cache is allowed to keep.
    assert.match(result.body, /<title>404 | 无浪潮<\/title>/, `${pathname} needs a title`);
    assert.match(result.body, /name="robots" content="noindex, nofollow"/);
    assert.match(result.body, /class="nw-w nw-head nw-error-page" data-error-boundary="404"/);
    assert.match(result.body, /这一页不存在/);
    assert.match(result.headers.get("cache-control") ?? "", /no-store/, `${pathname} must not be cached`);
  }
});

test("canonical public slug validation stays aligned with the API", () => {
  const cases = ["a", "0", "hello-world", "a".repeat(160), "Hello", "hello_world", "雨季", "hello.html", "a--b", "-hello", "hello-", "a".repeat(161)];
  for (const slug of cases) {
    let apiAccepts = true;
    try { validateArticleSlug(slug); } catch { apiAccepts = false; }
    assert.equal(isPublicEntitySlug(slug), apiAccepts, slug);
  }
  // URLs are not trimmed: even if the write API normalizes surrounding spaces,
  // a mistyped path must not silently resolve to a different canonical address.
  assert.equal(isPublicEntitySlug(" hello "), false);
});

test("invalid article and category slugs are uncached hard 404s without contacting the API", async () => {
  const invalid = ["Hello-World", "hello_world", "%E9%9B%A8%E5%AD%A3", "hello%20world", "hello.html", "a--b", "-hello", "hello-", "a".repeat(161), "%2Fescape"];
  for (const prefix of ["/articles/", "/en/articles/", "/categories/", "/en/categories/"]) {
    for (const slug of invalid) {
      mockApi.resetRequests();
      const result = await get(prefix + slug);
      assert.equal(result.status, 404, prefix + slug);
      assert.match(result.headers.get("cache-control") ?? "", /no-store/, prefix + slug);
      assert.match(result.body, /这一页不存在/, prefix + slug);
      assert.deepEqual(mockApi.requests(), [], `${prefix + slug} must not reach the API`);
    }
  }
});

test("valid slugs still distinguish missing entities from upstream failure", async () => {
  for (const prefix of ["/articles/", "/en/articles/", "/categories/", "/en/categories/"]) {
    const missing = await get(prefix + "no-such-work");
    assert.equal(missing.status, 404, prefix);
    assert.match(missing.headers.get("cache-control") ?? "", /no-store/);
    const failure = await get(prefix + "mock-upstream-failure");
    assert.equal(failure.status, 503, prefix);
    assert.match(failure.headers.get("cache-control") ?? "", /no-store/);
    assert.match(failure.body, /内容暂时无法加载/);
    assert.doesNotMatch(failure.body, /检查 API 服务是否在运行/);
  }
});

test("an unreachable content API still answers 503 for valid article and category addresses", async () => {
  const port = await freePort();
  await withEnvServer({ API_BASE_URL: `http://127.0.0.1:${port}` }, async (url) => {
    for (const path of ["/articles/valid-slug", "/categories/valid-slug"]) {
      const result = await fetch(url + path);
      assert.equal(result.status, 503, path);
      assert.match(result.headers.get("cache-control") ?? "", /no-store/);
      const body = await result.text();
      assert.match(body, /内容暂时无法加载/);
      assert.doesNotMatch(body, /检查 API 服务是否在运行/);
    }
  });
});

/* ------------------------------------ Phase 4a: comments, the page after hydration */

/**
 * A page can be perfectly server-rendered and still be dead: `ArticleComments`
 * is shared UI, and until this slice there was no
 * `/api/articles/:slug/comments` route at all, so the component had nothing to
 * talk to. These assertions cover the endpoint the component calls — including
 * the two rules that make it a mutation proxy rather than an open relay.
 */
test("the comment thread the component fetches is served, no-store and API-backed", async () => {
  const result = await get("/api/articles/portable-web-foundation/comments?locale=zh-CN");
  assert.equal(result.status, 200);
  assert.match(result.headers.get("cache-control") ?? "", /no-store/);
  const payload = JSON.parse(result.body) as {
    data: { id: string; body: string; author: { displayName: string } }[];
  };
  assert.equal(payload.data[0]?.id, MOCK_COMMENT_ID);
  assert.match(payload.data[0]?.body ?? "", /托管成本/);
  assert.equal(payload.data[0]?.author.displayName, MOCK_DISPLAY_NAME);
  // The page limit is part of the shared contract, not a per-framework detail.
  assert.ok(
    mockApi.requests().some((request) => request.includes("limit=50")),
    `the upstream call must carry the documented page limit: ${mockApi.requests().join(", ")}`,
  );
});

test("a malformed slug is a local 400 that never reaches the API", async () => {
  mockApi.resetRequests();
  const result = await get("/api/articles/Not_A_Slug/comments");
  assert.equal(result.status, 400);
  assert.deepEqual(mockApi.requests(), [], "an invalid slug must be rejected before proxying");
});

test("posting a comment requires our own origin and a session", async () => {
  const path = "/api/articles/portable-web-foundation/comments?locale=zh-CN";

  mockApi.resetRequests();
  const crossOrigin = await post(path, JSON.stringify({ body: "好" }), { origin: "https://evil.test" });
  assert.equal(crossOrigin.status, 403);
  assert.deepEqual(mockApi.requests(), [], "a cross-origin write must not be forwarded at all");

  const anonymous = await post(path, JSON.stringify({ body: "好" }));
  assert.equal(anonymous.status, 401, "the API's own refusal is forwarded, not replaced by fixtures");

  const signedIn = await post(path, JSON.stringify({ body: "值得一读" }), {
    cookie: `nw_access=${MOCK_TOKENS.accessToken}`,
  });
  assert.equal(signedIn.status, 201);
  const created = JSON.parse(signedIn.body) as { data: { body: string } };
  assert.equal(created.data.body, "值得一读");
});
