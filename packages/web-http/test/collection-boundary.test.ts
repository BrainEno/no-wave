import assert from "node:assert/strict";
import test from "node:test";
import { createApiContentClient, createPublicContentSource } from "../../web-ui/src/lib/api-content.ts";
import { loadArchivePage } from "../../web-ui/src/lib/public-pages.ts";
import { API_RESPONSE_MAX_BYTES } from "../src/upstream-response.ts";
import { UpstreamTransport } from "../src/upstream.ts";
import { legalArticleCollection } from "./support/legal-article-collection.ts";

for (const locale of ["zh-CN", "zh-TW", "en"] as const) {
  test(`three legal ${locale} full-body articles exceed the buffer fence but remain readable in one collection`, async t => {
    const fixture = await legalArticleCollection(3, locale);
    const source = fixture.response();
    const requests: string[] = [];
    const transport = new UpstreamTransport({ fetchImpl: async (url, init) => {
      requests.push(url); assert.equal(init?.method, "GET");
      return source.response;
    } });
    t.after(() => transport.close());
    const client = createApiContentClient({ endpoint: "https://api.test", upstreamTransport: transport });
    const articles = await client.listArticles({ locale, limit: 20, offset: 40, sort: "latest", query: "legal" });
    assert.equal(articles.length, 3);
    assert.deepEqual(articles.map(article => article.slug), ["work-0", "work-1", "work-2"]);
    assert.deepEqual(articles.map(article => article.contentBlocks), fixture.articles.map(article => article.contentBlocks), "full clients do not lose article bodies");
    assert.deepEqual(articles.map(article => article.locale), [locale, locale, locale]);
    assert.ok(source.bytes() > API_RESPONSE_MAX_BYTES, "the real serializer must exercise the reported boundary");
    assert.equal(requests.length, 1, "no retry, extra page, or silently moved offset");
    assert.equal(new URL(requests[0]!).searchParams.get("offset"), "40");
    assert.equal(new URL(requests[0]!).searchParams.get("locale"), locale);
    assert.equal(await transport.close(), true);
  });
}

test("an API-backed archive does not disappear or select fixtures when a legal page is larger than eight MiB", async t => {
  const fixture = await legalArticleCollection();
  const transport = new UpstreamTransport({ fetchImpl: async () => fixture.response().response });
  t.after(() => transport.close());
  const source = createPublicContentSource(createApiContentClient({ endpoint: "https://api.test", upstreamTransport: transport }));
  const page = await loadArchivePage({ locale: "zh-CN" }, source);
  assert.deepEqual(page.articles.map(article => article.slug), ["work-0", "work-1", "work-2"]);
  assert.equal(page.hasNextPage, false);
});
