import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createApiServer } from "../../server.ts";
import { createSqliteClient, runSqliteMigrations } from "../../persistence/sqlite.ts";
import { createSqliteStore } from "../../persistence/sqlite-store.ts";
import { createPostgresClient, createPostgresStore } from "../../persistence/postgres.ts";
import { runMigrations } from "../../persistence/migrate.ts";
import { createApiContentClient } from "../../../../../packages/web-ui/src/lib/api-content.ts";
import { API_RESPONSE_MAX_BYTES } from "../../../../../packages/web-http/src/upstream-response.ts";

for (const provider of ["sqlite", "postgres"] as const) {
  test(`legal article collections retain full-body compatibility and explicit card metadata over real HTTP (${provider})`, {
    skip: provider === "postgres" && !process.env.TEST_DATABASE_URL && "Set TEST_DATABASE_URL to run PostgreSQL integration tests.",
  }, async () => {
    const db = provider === "sqlite" ? createSqliteClient({ filename: ":memory:", enableWal: false }) : null;
    const sql = provider === "postgres" ? await createPostgresClient({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }) : null;
    if (db) await runSqliteMigrations(db);
    if (sql) await runMigrations(sql);
    const store = db ? createSqliteStore(db) : createPostgresStore(sql!);
    const author = `collection-${randomUUID()}`;
    const locale = "zh-TW";
    await store.upsertAuthorProfile({ userId: author, displayName: "集合作者", bio: "", locale });
    const blocks = Array.from({ length: 19 }, (_, index) => ({ id: `c-${index}`, type: "code", language: "text", code: "浪".repeat(49_900) }));
    const long = [];
    for (let index = 0; index < 3; index++) long.push(await store.createArticle({ authorId: author,
      slug: `collection-${index}-${randomUUID()}`, title: `合法作品 ${index}`, locale, contentBlocks: blocks, publish: true }));
    const poem = await store.createArticle({ authorId: author, slug: `poem-${randomUUID()}`, title: "诗", workType: "poetry", locale,
      contentBlocks: [{ id: "p", type: "paragraph", text: "第一行 \n 第二行 \n第三行" }, { id: "q", type: "quote", text: "另有四字" }], publish: true });
    await store.createArticle({ authorId: author, slug: `draft-${randomUUID()}`, title: "不公开", locale, contentBlocks: blocks, publish: false });
    const server = createApiServer({ store, env: {}, logger: () => {} });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const endpoint = `http://127.0.0.1:${address.port}`;
    try {
      const path = `/api/v1/authors/${author}/articles?locale=${locale}&limit=100`;
      const legacy = await fetch(endpoint + path);
      const bytes = new Uint8Array(await legacy.arrayBuffer());
      assert.ok(bytes.byteLength > API_RESPONSE_MAX_BYTES);
      const expected = JSON.parse(new TextDecoder().decode(bytes)).data;
      assert.equal(expected.length, 4);
      const client = createApiContentClient({ endpoint });
      const full = await client.listArticles({ locale, authorUsername: author });
      assert.deepEqual(full.map(item => item.slug), expected.map((item: { slug: string }) => item.slug));
      for (const article of long) assert.deepEqual(full.find(item => item.slug === article.slug)?.contentBlocks, blocks);
      const first = await client.listArticles({ locale, authorUsername: author, limit: 2 });
      const second = await client.listArticles({ locale, authorUsername: author, limit: 2, offset: 2 });
      assert.deepEqual([...first, ...second].map(item => item.slug), full.map(item => item.slug), "page order/count do not drift at a stream boundary");
      const cardsResponse = await fetch(endpoint + path + "&view=card");
      const cards = (await cardsResponse.json()).data;
      assert.equal(cardsResponse.status, 200);
      assert.equal(cards.length, 4);
      assert.equal(cards.every((item: object) => !Object.hasOwn(item, "contentBlocks")), true, "an explicit card projection must not retain full bodies");
      const card = cards.find((item: { slug: string }) => item.slug === poem.slug);
      assert.deepEqual(card.reading, { locale, length: 13, poemLines: ["第一行", "第二行"] });
      const compactClient = createApiContentClient({ endpoint, articleProjection: "card" });
      const compact = await compactClient.listArticles({ locale, authorUsername: author });
      assert.deepEqual(compact.map(item => item.slug), full.map(item => item.slug));
      assert.equal(compact.every(item => item.listPreview && item.contentBlocks.length === 0), true);
      assert.deepEqual((await compactClient.getArticleBySlug(poem.slug, locale))?.contentBlocks, full.find(item => item.slug === poem.slug)?.contentBlocks, "the detail path always fetches the complete body");
      for (const view of ["invalid", "", "card&view=full"]) assert.equal((await fetch(endpoint + path + `&view=${view}`)).status, 400);
      assert.deepEqual(await client.listArticles({ locale: "en", authorUsername: author }), [], "another locale never borrows these rows");
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (sql) { await sql.unsafe("DELETE FROM articles WHERE author_id = $1", [author]); await sql.end({ timeout: 5 }); }
      db?.close();
    }
  });
}
