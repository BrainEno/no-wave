import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { MOCK_TOKENS, startMockRestApi } from "../mocks/rest-api.ts";
import { startProductionWeb } from "./support/production-web.ts";

let api: Awaited<ReturnType<typeof startMockRestApi>>;
let app: Awaited<ReturnType<typeof startProductionWeb>>;
before(async () => {
  api = await startMockRestApi();
  app = await startProductionWeb({ API_BASE_URL: api.url, SITE_URL: "https://reader.example.test" });
});
after(async () => { await app?.close(); await api?.close(); });

for (const [prefix, locale, title] of [["", "zh-CN", "阅读清单"], ["/en", "en", "Reading list"]] as const) {
  test(`${locale} reading-list HTML is an anonymous, no-store/noindex local-only shell`, async () => {
    for (const cookie of ["", `nw_access=${MOCK_TOKENS.accessToken}; nw_refresh=${MOCK_TOKENS.refreshToken}; nw_session=1`]) {
      api.resetRequests();
      const response = await fetch(`${app.origin}${prefix}/reading-list`, { headers: { cookie }, redirect: "manual" });
      const body = await response.text();
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
      assert.equal(response.headers.get("set-cookie"), null);
      assert.match(body, /name="robots" content="noindex, nofollow"/);
      assert.ok(body.includes(`<html lang="${locale}">`));
      assert.ok(body.includes(`<h1>${title}</h1>`));
      assert.match(body, /data-route="reading-list"/);
      assert.doesNotMatch(body, /data-shelf-id=/);
      assert.ok(!body.includes(MOCK_TOKENS.accessToken));
      assert.ok(!body.includes(MOCK_TOKENS.refreshToken));
      assert.deepEqual(api.requests(), [], "no session refresh or catalog/private API read is needed for a local list");
    }
  });

  test(`${locale} reading-list data and HEAD preserve local privacy without authentication`, async () => {
    api.resetRequests();
    const data = await fetch(`${app.origin}${prefix}/reading-list.data?query=untrusted&state=finished`);
    assert.equal(data.status, 200);
    assert.match(data.headers.get("cache-control") ?? "", /no-store/);
    const body = await data.text();
    assert.ok(body.includes(`"${locale}"`));
    assert.ok(!body.includes("untrusted"));
    assert.ok(!body.includes("finished"));
    assert.deepEqual(api.requests(), []);
    const head = await fetch(`${app.origin}${prefix}/reading-list`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("cache-control"), "no-store, max-age=0");
    assert.equal(head.headers.get("set-cookie"), null);
    assert.equal(await head.text(), "");
  });
}

test("the public article remains shared-cacheable, while personal list pages are absent from the sitemap", async () => {
  const article = await fetch(`${app.origin}/articles/portable-web-foundation`);
  assert.equal(article.status, 200);
  assert.match(article.headers.get("cache-control") ?? "", /s-maxage/);
  const html = await article.text();
  assert.match(html, /加入阅读清单/);
  assert.match(html, /在本文查找/);
  assert.doesNotMatch(html, /data-shelf-id=/);
  const sitemap = await fetch(`${app.origin}/sitemap.xml`);
  assert.equal(sitemap.status, 200);
  assert.doesNotMatch(await sitemap.text(), /<loc>[^<]*reading-list/);
});
