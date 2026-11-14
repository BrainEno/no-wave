import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../../api/src/server.ts";
import { createSqliteClient, runSqliteMigrations } from "../../api/src/persistence/sqlite.ts";
import { createSqliteStore } from "../../api/src/persistence/sqlite-store.ts";
import { startProductionWeb } from "./support/production-web.ts";

/** This seam uses the actual REST serializer and store, not the crawl contract fixture. */
test("a real published catalog reaches production XML, while drafts, tombstones and unpublished accounts remain absent", async () => {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  let app: Awaited<ReturnType<typeof startProductionWeb>> | undefined;
  let api: ReturnType<typeof createApiServer> | undefined;
  try {
    await runSqliteMigrations(db);
    const store = createSqliteStore(db);
    const author = "public-crawl-writer";
    const privateAuthor = "draft-only-writer";
    const origin = "https://real-publication.example";
    const contentBlocks = [{ id: "paragraph", type: "paragraph", text: "Public writing for the crawl contract." }];
    // Private fixture setup only. Existing rows can have English taxonomies and
    // a Traditional Chinese profile; this does not broaden REST write locales.
    await store.upsertAuthorProfile({ userId: author, displayName: "原有作者", bio: "Public profile", locale: "zh-TW" });
    await store.upsertAuthorProfile({ userId: privateAuthor, displayName: "未发表作者", locale: "zh-CN" });
    const published: { id: string; slug: string; locale: "zh-CN" | "en" }[] = [];
    for (const locale of ["zh-CN", "en"] as const) {
      const tag = await store.createTag({ actorId: author, name: locale === "en" ? "Memory" : "记忆", locale });
      const category = await store.createTaxonomy({ actorId: "fixture-editor", actorIsEditor: true, kind: "category", slug: `section-${locale.toLowerCase()}`, name: locale === "en" ? "Essays" : "随笔", locale });
      const article = await store.createArticle({ authorId: author, slug: `public-${locale.toLowerCase()}`, title: "Public work", locale, contentBlocks, publish: true, categoryIds: [category.id], tagIds: [tag.id] });
      published.push({ id: article.id, slug: article.slug, locale });
      await store.createArticle({ authorId: privateAuthor, slug: `draft-${locale.toLowerCase()}`, title: "Private draft", locale, contentBlocks, publish: false });
      const deleted = await store.createArticle({ authorId: author, slug: `deleted-${locale.toLowerCase()}`, title: "Deleted work", locale, contentBlocks, publish: true });
      await store.deleteArticle({ articleId: deleted.id, actorId: author });
    }
    api = createApiServer({ store, env: {}, logger: () => {} });
    let credentialedApiReads = 0;
    api.on("request", (request) => { if (request.headers.cookie || request.headers.authorization) credentialedApiReads++; });
    await new Promise<void>((resolve, reject) => {
      api!.once("error", reject);
      api!.listen(0, "0.0.0.0", resolve);
    });
    const address = api.address();
    assert.ok(address && typeof address === "object");
    app = await startProductionWeb({ API_BASE_URL: `http://127.0.0.1:${address.port}`, SITE_URL: origin });
    const response = await fetch(`${app.origin}/sitemap.xml`, { headers: { cookie: "nw_access=synthetic-marker", authorization: "Bearer synthetic-not-a-secret" } });
    assert.equal(response.status, 200);
    const body = await response.text();
    const urls = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => new URL(match[1]!));
    assert.ok(urls.every((url) => url.origin === origin && url.search === ""));
    const paths = urls.map((url) => url.pathname);
    for (const { slug, locale } of published) {
      const prefix = locale === "en" ? "/en" : "";
      assert.ok(paths.includes(`${prefix}/articles/${slug}`));
      assert.ok(paths.includes(`${prefix}/authors/${author}`));
      assert.ok(paths.includes(`${prefix}/categories/section-${locale.toLowerCase()}`));
      assert.equal(paths.filter((path) => path.startsWith(`${prefix}/tags/`)).length, 1);
    }
    assert.equal(paths.some((path) => /\/(?:draft|deleted)-/.test(path)), false);
    assert.equal(paths.some((path) => path.endsWith(`/authors/${privateAuthor}`)), false);
    assert.equal(credentialedApiReads, 0);
    // A conditional request after a real unpublish must not validate the old
    // member set, even though the taxonomy directory itself is still public.
    for (const { id, slug, locale } of published) await store.updateArticle({ articleId: id, actorId: author, slug, locale, title: "Withdrawn work", contentBlocks, publish: false });
    const withdrawn = await fetch(`${app.origin}/sitemap.xml`, { headers: { "if-none-match": response.headers.get("etag")! } });
    assert.equal(withdrawn.status, 200);
    assert.notEqual(withdrawn.headers.get("etag"), response.headers.get("etag"));
    const withdrawnPaths = [...(await withdrawn.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => new URL(match[1]!).pathname);
    assert.equal(withdrawnPaths.some((path) => /\/(?:articles|authors)\//.test(path)), false);
    assert.equal(withdrawnPaths.filter((path) => /\/tags\//.test(path)).length, 2);
    assert.equal(withdrawn.headers.get("last-modified"), null);
  } finally {
    await app?.close();
    if (api?.listening) await new Promise<void>((resolve, reject) => {
      api!.closeAllConnections();
      api!.close((error) => error ? reject(error) : resolve());
    });
    db.close();
  }
});
