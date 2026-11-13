import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startTagApi, STABLE_TAG_SLUG, TAG_API_PRIVATE_ERROR } from "../mocks/tag-api.ts";
import { startProductionWeb } from "./support/production-web.ts";

let api: Awaited<ReturnType<typeof startTagApi>>;
let app: Awaited<ReturnType<typeof startProductionWeb>>;
before(async () => {
  api = await startTagApi();
  app = await startProductionWeb({ API_BASE_URL: api.url, API_TIMEOUT_MS: "1200", SITE_URL: "https://tags.example.test" });
});
after(async () => { await app?.close(); await api?.close(); });

async function get(path: string, init: RequestInit = {}) {
  const response = await fetch(`${app.origin}${path}`, { redirect: "manual", ...init,
    headers: { "accept-encoding": "identity", ...init.headers } });
  return { status: response.status, headers: response.headers, body: await response.text() };
}
const atomPath = `/tags/${STABLE_TAG_SLUG}/feed.atom`;
const rssPath = `/tags/${STABLE_TAG_SLUG}/feed.xml`;
function safeFailure(response: Awaited<ReturnType<typeof get>>, status: number) {
  assert.equal(response.status, status);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(response.headers.get("etag"), null);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.ok(!response.body.includes(TAG_API_PRIVATE_ERROR));
  assert.ok(!response.body.includes("<feed"));
}

test("a public tag has an Atom subscription backed by the bounded anonymous collection", async () => {
  api.resetRequests();
  const response = await get(atomPath);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/atom\+xml/);
  assert.match(response.body, /<feed xmlns="http:\/\/www.w3.org\/2005\/Atom"/);
  assert.equal((response.body.match(/<entry>/g) ?? []).length, 20);
  assert.ok(response.body.includes("主题作品 01"));
  assert.ok(response.body.includes("主题作品 20"));
  assert.ok(!response.body.includes("主题作品 21"));
  assert.deepEqual(api.requests().map(({ path, query }) => ({ path, query })), [
    { path: `/api/v1/tags/${STABLE_TAG_SLUG}`, query: { locale: "zh-CN" } },
    { path: `/api/v1/tags/${STABLE_TAG_SLUG}/articles`, query: { locale: "zh-CN", limit: "21", offset: "0" } },
  ]);
});

test("RSS syndicates the same public window with permalink GUIDs and correctly typed self discovery", async () => {
  const response = await get(rssPath);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/rss\+xml; charset=utf-8$/);
  assert.match(response.body, /<rss version="2.0"/);
  assert.equal((response.body.match(/<item>/g) ?? []).length, 20);
  assert.match(response.body, /<guid isPermaLink="true">https:\/\/tags.example.test\/articles\/tagged-work-1<\/guid>/);
  assert.match(response.body, /<atom:link href="https:\/\/tags.example.test\/tags\//);
  assert.ok(!response.body.includes("这是一篇关于地方的公开作品。"), "a subscription exports summaries rather than full document blocks");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("content-length"), String(Buffer.byteLength(response.body)));
});

test("production HTTP conditional GET emits 304 while re-reading the current anonymous collection", async () => {
  const initial = await get(atomPath);
  const etag = initial.headers.get("etag")!;
  assert.match(etag, /^W\/"[a-f0-9]{64}"$/);
  api.resetRequests();
  const fresh = await get(atomPath, { headers: { "if-none-match": etag } });
  assert.equal(fresh.status, 304);
  assert.equal(fresh.body, "");
  assert.equal(fresh.headers.get("etag"), etag);
  assert.equal(fresh.headers.get("content-length"), null);
  assert.equal(fresh.headers.get("cache-control"), initial.headers.get("cache-control"));
  assert.equal(api.requests().length, 2);
});

test("production HEAD preserves validators and content metadata without sending XML", async () => {
  const getResponse = await get(atomPath);
  const head = await get(atomPath, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
  assert.equal(head.headers.get("etag"), getResponse.headers.get("etag"));
  assert.equal(head.headers.get("content-type"), getResponse.headers.get("content-type"));
  assert.equal(head.headers.get("content-length"), getResponse.headers.get("content-length"));
  const unchanged = await get(atomPath, { method: "HEAD", headers: { "if-none-match": getResponse.headers.get("etag")! } });
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.body, "");
});

test("both English formats retain English API reads and English article permalinks", async () => {
  for (const suffix of ["atom", "xml"]) {
    api.resetRequests();
    const response = await get(`/en/tags/${STABLE_TAG_SLUG}/feed.${suffix}`);
    assert.equal(response.status, 200);
    assert.ok(response.body.includes("A renamed theme"));
    assert.ok(response.body.includes("https://tags.example.test/en/articles/tagged-work-1"));
    assert.ok(!response.body.includes("主题作品"));
    assert.ok(api.requests().every(({ query }) => query.locale === "en"));
    assert.equal(api.requests().length, 2);
  }
});

test("query variants use a relative permanent redirect instead of creating more feed cache identities", async () => {
  api.resetRequests();
  const response = await get(`${atomPath}?page=5001&q=private&unknown=1`);
  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), atomPath);
  assert.equal(response.body, "");
  assert.deepEqual(api.requests(), []);
  const english = await get(`/en${rssPath}?page=2`);
  assert.equal(english.headers.get("location"), `/en${rssPath}`);
});

test("malformed and unsupported resource identities fail before any API request", async () => {
  for (const path of ["/tags/%2Fprivate/feed.atom", "/tags/Bad_slug/feed.atom", "/tags/good/feed.json", `/tags/${"a".repeat(161)}/feed.xml`]) {
    api.resetRequests();
    safeFailure(await get(path), 404);
    assert.deepEqual(api.requests(), []);
  }
});

test("missing identity avoids the collection call and disappearance between reads remains 404", async () => {
  for (const [slug, reads] of [["missing-topic", 1], ["disappearing-topic", 2]] as const) {
    api.resetRequests();
    safeFailure(await get(`/tags/${slug}/feed.atom`, { headers: { "if-none-match": "*" } }), 404);
    assert.equal(api.requests().length, reads);
  }
});

test("empty existing tags have valid deterministic subscriptions and can be revalidated", async () => {
  const first = await get("/tags/empty-topic/feed.atom");
  assert.equal(first.status, 200);
  assert.match(first.body, /<updated>1970-01-01T00:00:00.000Z<\/updated>/);
  assert.equal((first.body.match(/<entry>/g) ?? []).length, 0);
  const again = await get("/tags/empty-topic/feed.atom", { headers: { "if-none-match": first.headers.get("etag")! } });
  assert.equal(again.status, 304);
});

test("upstream failures and invalid successful envelopes are not cached or presented as empty feeds", async () => {
  for (const slug of ["unavailable", "malformed", "null-payload"]) {
    const response = await get(`/tags/${slug}/feed.xml`);
    safeFailure(response, 503);
    assert.equal(response.headers.get("retry-after"), "60");
  }
});

test("a viewer cannot personalize or contaminate the public subscription cache", async () => {
  const anonymous = await get(atomPath);
  api.resetRequests();
  const viewer = await get(atomPath, { headers: { cookie: "nw_session=synthetic-not-a-secret", authorization: "Bearer synthetic-not-a-secret" } });
  assert.equal(viewer.body, anonymous.body);
  assert.equal(viewer.headers.get("etag"), anonymous.headers.get("etag"));
  assert.equal(viewer.headers.get("set-cookie"), null);
  assert.equal(api.requests().length, 2);
  assert.ok(api.requests().every(({ hasCredentials }) => !hasCredentials));
  assert.ok(!viewer.body.includes("synthetic-not-a-secret"));
});

test("every mutating method is denied without reaching the API or changing tag state", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    api.resetRequests();
    const response = await get(atomPath, { method });
    safeFailure(response, 405);
    assert.equal(response.headers.get("allow"), "GET, HEAD");
    assert.deepEqual(api.requests(), []);
  }
});

test("tag HTML advertises both subscription formats in its head and in native reader links", async () => {
  for (const prefix of ["", "/en"]) {
    const response = await get(`${prefix}/tags/${STABLE_TAG_SLUG}?page=2`);
    assert.equal(response.status, 200);
    for (const [format, type] of [["atom", "atom"], ["xml", "rss"]]) {
      assert.match(response.body, new RegExp(`rel="alternate" type="application/${type}\\+xml"[^>]+href="https://tags.example.test${prefix}/tags/${STABLE_TAG_SLUG}/feed.${format}"`));
      assert.ok(response.body.includes(`href="${prefix}/tags/${STABLE_TAG_SLUG}/feed.${format}"`));
    }
    assert.ok(response.body.includes(prefix ? "Tag subscriptions" : "标签订阅"));
    assert.ok(!response.body.includes("feed.atom?page="));
  }
});
