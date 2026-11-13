import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startTagApi, STABLE_TAG_SLUG, TAG_API_PRIVATE_ERROR } from "../mocks/tag-api.ts";
import { startProductionWeb } from "./support/production-web.ts";

let api: Awaited<ReturnType<typeof startTagApi>>;
let app: Awaited<ReturnType<typeof startProductionWeb>>;
let origin: string;
before(async () => {
  api = await startTagApi();
  app = await startProductionWeb({ API_BASE_URL: api.url, API_TIMEOUT_MS: "1200", SITE_URL: "https://tags.example.test" });
  origin = app.origin;
});
after(async () => { await app?.close(); await api?.close(); });

async function get(path: string, cookie?: string) {
  const response = await fetch(`${origin}${path}`, { redirect: "manual", headers: cookie ? { cookie } : {} });
  return { status: response.status, headers: response.headers, body: await response.text() };
}

function noIndexFailure(result: Awaited<ReturnType<typeof get>>, status: number): void {
  assert.equal(result.status, status);
  assert.match(result.headers.get("cache-control") ?? "", /no-store/);
  assert.match(result.body, /name="robots" content="noindex, nofollow"/);
  assert.ok(!result.body.includes(TAG_API_PRIVATE_ERROR), "upstream diagnostics must not reach public HTML or hydration data");
}

test("the tag directory renders real upstream Unicode labels and persisted links in SSR", async () => {
  api.resetRequests();
  const result = await get("/tags");
  assert.equal(result.status, 200);
  assert.match(result.body, /<h1[^>]*>.*标签/s);
  assert.match(result.body, /重新命名的主题/);
  assert.match(result.body, new RegExp(`href="/tags/${STABLE_TAG_SLUG}"`));
  assert.match(result.body, /role="search"/);
  assert.match(result.body, /name="q"/);
  assert.match(result.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(result.headers.get("set-cookie"), null);
  assert.deepEqual(api.requests().map(({ path, query }) => ({ path, query })), [{
    path: "/api/v1/tags", query: { locale: "zh-CN", query: "", limit: "21", offset: "0" },
  }]);
  assert.equal((result.body.match(/data-tag-slug=/g) ?? []).length, 20, "lookahead is not rendered as a twenty-first row");
});

test("directory query normalization is bounded, shareable and applied before upstream search", async () => {
  api.resetRequests();
  const result = await get(`/tags?q=${encodeURIComponent("　＃重新命名　")}`);
  assert.equal(result.status, 200);
  assert.match(result.body, /value="重新命名"/);
  assert.match(result.body, /name="robots" content="noindex, follow"/);
  assert.equal(api.requests()[0]?.query.query, "重新命名");
  assert.match(result.body, /rel="canonical" href="https:\/\/tags.example.test\/tags\?q=/);
  assert.ok(!result.body.includes("?q=%EF%BC%83"));
});

test("directory pagination uses a single bounded page and keeps the current search", async () => {
  api.resetRequests();
  const result = await get(`/tags?q=${encodeURIComponent("主题")}&page=2`);
  assert.equal(result.status, 200);
  assert.deepEqual(api.requests().map((request) => request.query), [{ locale: "zh-CN", query: "主题", limit: "21", offset: "20" }]);
  assert.match(result.body, /href="\/tags\?q=%E4%B8%BB%E9%A2%98"/);
  assert.match(result.body, /rel="canonical" href="https:\/\/tags.example.test\/tags\?q=%E4%B8%BB%E9%A2%98&amp;page=2"/);
  assert.ok(!result.body.includes('rel="next"'), "the final short page must not offer another page");
});

test("tag detail renders the published work page without an unbounded catalogue scan", async () => {
  api.resetRequests();
  const result = await get(`/tags/${STABLE_TAG_SLUG}`);
  assert.equal(result.status, 200);
  assert.match(result.body, /重新命名的主题/);
  assert.match(result.body, /主题作品 01/);
  assert.match(result.body, /主题作品 20/);
  assert.ok(!result.body.includes("主题作品 21"));
  assert.match(result.body, new RegExp(`href="/tags/${STABLE_TAG_SLUG}\\?page=2"`));
  assert.match(result.headers.get("cache-control") ?? "", /public.*s-maxage=60/);
  assert.deepEqual(api.requests().map(({ path, query }) => ({ path, query })), [
    { path: `/api/v1/tags/${STABLE_TAG_SLUG}`, query: { locale: "zh-CN" } },
    { path: `/api/v1/tags/${STABLE_TAG_SLUG}/articles`, query: { locale: "zh-CN", limit: "21", offset: "0" } },
  ]);
});

test("detail page two keeps its own canonical URL and links back without a page-one query", async () => {
  const result = await get(`/tags/${STABLE_TAG_SLUG}?page=2`);
  assert.equal(result.status, 200);
  assert.match(result.body, /主题作品 21/);
  assert.ok(!result.body.includes("主题作品 01"));
  assert.match(result.body, new RegExp(`rel="canonical" href="https://tags.example.test/tags/${STABLE_TAG_SLUG}\\?page=2"`));
  assert.match(result.body, new RegExp(`href="/tags/${STABLE_TAG_SLUG}"`));
  assert.ok(!result.body.includes('rel="next"'));
});

test("an unknown tag is a hard private 404 and never triggers an article lookup", async () => {
  api.resetRequests();
  const result = await get("/tags/missing-topic");
  noIndexFailure(result, 404);
  assert.deepEqual(api.requests().map((request) => request.path), ["/api/v1/tags/missing-topic"]);
});

test("invalid slug encodings are rejected before any content request", async () => {
  for (const slug of ["Bad_slug", "%2Foutside", "bad%25encoding", "a".repeat(161)]) {
    api.resetRequests();
    noIndexFailure(await get(`/tags/${slug}`), 404);
    assert.deepEqual(api.requests(), [], `invalid slug ${slug.slice(0, 20)} reached the API`);
  }
});

test("a tag removed between its identity read and article read is not a successful empty page", async () => {
  api.resetRequests();
  noIndexFailure(await get("/tags/disappearing-topic"), 404);
  assert.equal(api.requests().length, 2);
});

test("an empty existing tag is a successful empty state rather than a missing resource", async () => {
  const result = await get("/tags/empty-topic");
  assert.equal(result.status, 200);
  assert.match(result.body, /空主题/);
  assert.match(result.body, /还没有已发表的作品/);
  assert.match(result.body, /href="\/tags"/);
  assert.match(result.body, /href="\/articles"/);
});

test("upstream tag-list and detail failures remain 503 without exposing diagnostics", async () => {
  for (const path of ["/tags?q=unavailable", "/tags/unavailable"]) noIndexFailure(await get(path), 503);
});

test("malformed successful payloads are service failures, not empty directories or 404s", async () => {
  for (const path of ["/tags?q=malformed", "/tags/malformed", "/tags/null-payload"]) noIndexFailure(await get(path), 503);
});

test("English document and data navigations use the English API locale and configured site origin", async () => {
  api.resetRequests();
  const result = await get(`/en/tags/${STABLE_TAG_SLUG}`);
  assert.equal(result.status, 200);
  assert.match(result.body, /lang="en"/);
  assert.match(result.body, /A renamed theme/);
  assert.match(result.body, new RegExp(`rel="canonical" href="https://tags.example.test/en/tags/${STABLE_TAG_SLUG}"`));
  assert.ok(api.requests().every((request) => request.query.locale === "en"));
  api.resetRequests();
  const data = await get("/en/tags.data?q=Theme&page=2");
  assert.equal(data.status, 200);
  assert.match(data.body, /Theme 21/);
  assert.deepEqual(api.requests().map((request) => request.query), [{ locale: "en", query: "Theme", limit: "21", offset: "20" }]);
});

test("an arbitrary query is escaped as text and never becomes active HTML", async () => {
  const result = await get(`/tags?q=${encodeURIComponent('\"><img src=x onerror="window.tagInjected=1">')}`);
  assert.equal(result.status, 200);
  assert.ok(!result.body.includes('<img src=x onerror="window.tagInjected=1">'));
  assert.match(result.body, /没有符合条件的标签/);
});

test("public tag SSR never forwards viewer cookies or authorization to its content API", async () => {
  api.resetRequests();
  const anonymous = await get(`/tags/${STABLE_TAG_SLUG}`);
  const viewer = await get(`/tags/${STABLE_TAG_SLUG}`, "nw_access=synthetic-viewer-cookie; nw_session=synthetic-session-marker");
  assert.equal(viewer.status, 200);
  assert.equal(viewer.headers.get("set-cookie"), null);
  assert.ok(api.requests().every((request) => !request.hasCredentials));
  assert.ok(!viewer.body.includes("synthetic-viewer-cookie"));
  assert.match(anonymous.body, /主题作品 01/);
  assert.match(viewer.body, /主题作品 01/);
});

test("article tags use persisted slugs, preserve legacy names and do not activate invalid references", async () => {
  for (const prefix of ["", "/en"]) {
    const result = await get(`${prefix}/articles/tagged-work-1`);
    assert.equal(result.status, 200);
    assert.match(result.body, new RegExp(`href="${prefix}/tags/${STABLE_TAG_SLUG}"`));
    assert.match(result.body, prefix ? /Legacy label/ : /旧标签/);
    assert.match(result.body, /Unsafe reference/);
    assert.ok(!result.body.includes('href="javascript:'));
    assert.ok(!result.body.includes('href="/tags/重新命名'));
  }
});

test("invalid page inputs fall back to a bounded first page rather than producing an API 400", async () => {
  for (const page of ["0", "-1", "5002", "9007199254740993", "NaN", "2garbage"]) {
    api.resetRequests();
    const result = await get(`/tags?page=${page}`);
    assert.equal(result.status, 200);
    assert.equal(api.requests()[0]?.query.offset, "0");
  }
});
