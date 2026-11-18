import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../../api/src/server.ts";
import { createSqliteClient, runSqliteMigrations } from "../../api/src/persistence/sqlite.ts";
import { createSqliteStore } from "../../api/src/persistence/sqlite-store.ts";
import { seedLargeWorks } from "./support/large-works.ts";
import { startProductionWeb } from "./support/production-web.ts";

test("legal large collections reach production SSR/crawl cards while full details and API-failure refusal survive", { timeout: 60_000 }, async () => {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  let app: Awaited<ReturnType<typeof startProductionWeb>> | undefined;
  let api: ReturnType<typeof createApiServer> | undefined;
  try {
    await runSqliteMigrations(db);
    const store = createSqliteStore(db), author = "real-large-collection-writer";
    const fixture = await seedLargeWorks(store, author);
    api = createApiServer({ store, env: { API_METRICS_ENABLED: "true" }, logger: () => {} });
    const calls: { path: string; credentialed: boolean }[] = [];
    api.on("request", request => calls.push({ path: request.url ?? "", credentialed: Boolean(request.headers.authorization || request.headers.cookie) }));
    await new Promise<void>(resolve => api!.listen(0, "0.0.0.0", resolve));
    const address = api.address(); assert.ok(address && typeof address === "object");
    const endpoint = `http://127.0.0.1:${address.port}`;
    const legacy = await fetch(`${endpoint}/api/v1/articles?locale=zh-CN&limit=100`);
    assert.ok((await legacy.arrayBuffer()).byteLength > 8 * 1024 * 1024, "fixture must preserve the original whole-page counterexample");
    calls.length = 0;
    app = await startProductionWeb({ API_BASE_URL: endpoint, SITE_URL: "https://large-collection.example", API_TIMEOUT_MS: "10000" });
    for (const locale of ["zh-CN", "en"] as const) {
      const prefix = locale === "en" ? "/en" : "";
      for (const path of [`${prefix}/articles`, `${prefix}/authors/${author}`, `${prefix}/tags/${fixture.tags[locale]!.slug}`, `${prefix}/categories/${fixture.categories[locale]!.slug}`, prefix || "/"]) {
        const response: Response = await fetch(app.origin + path, { headers: { cookie: "nw_access=not-an-upstream-credential" } });
        assert.equal(response.status, 200, path);
        const html = await response.text();
        assert.ok(Buffer.byteLength(html) < 256 * 1024, `${path} must not hydrate complete list bodies`);
        for (const work of fixture.works.filter(row => row.locale === locale)) assert.ok(html.includes(work.title), `${path} lost ${work.title}`);
        assert.ok(!html.includes("浪".repeat(100)), `${path} leaked full code blocks into list data`);
        assert.ok(!html.includes("portable-web-foundation"), "a configured API cannot turn into fixture data");
        if (path.endsWith("/articles")) { assert.match(html, /第一行/); assert.match(html, /第二行/); assert.match(html, locale === "en" ? /4 words/ : /13 字/); }
      }
    }
    const crawl = await fetch(`${app.origin}/sitemap.xml`);
    assert.equal(crawl.status, 200);
    const xml = await crawl.text();
    for (const work of fixture.works) assert.ok(xml.includes(`/articles/${work.slug}</loc>`));
    assert.equal(crawl.headers.get("last-modified"), null);
    assert.equal(calls.some(call => call.credentialed), false);
    const articleLists = calls.filter(call => /^\/api\/v1\/(?:articles\?|authors\/[^/]+\/articles\?|(?:categories|tags)\/[^/]+\/articles\?)/.test(call.path));
    assert.ok(articleLists.length >= 10);
    assert.ok(articleLists.every(call => new URL(call.path, endpoint).searchParams.get("view") === "card"));
    const detail = fixture.works.find(work => work.locale === "en")!;
    const document = await fetch(`${app.origin}/en/articles/${detail.slug}`);
    assert.equal(document.status, 200);
    const html = await document.text();
    assert.match(html, /id="h-section"/);
    assert.match(html, /Complete body paragraph, including the last words\./);
    assert.ok(html.includes("浪".repeat(100)), "a full detail must not be replaced by its list preview");
    const metrics = await (await fetch(`${endpoint}/metrics`)).text();
    assert.match(metrics, /api_http_collection_responses_total\{view="card",outcome="finished"\} [1-9]/);
    api.closeAllConnections(); await new Promise<void>(resolve => api!.close(() => resolve()));
    const unavailable = await fetch(`${app.origin}/articles`);
    assert.equal(unavailable.status, 503);
    assert.ok(!(await unavailable.text()).includes("portable-web-foundation"));
    assert.equal((await fetch(`${app.origin}/sitemap.xml`)).status, 503);
  } finally {
    await app?.close();
    if (api?.listening) { api.closeAllConnections(); await new Promise<void>(resolve => api!.close(() => resolve())); }
    db.close();
  }
});
