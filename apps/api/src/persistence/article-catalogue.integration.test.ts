import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createSqliteClient, runSqliteMigrations } from "./sqlite.ts";
import { createSqliteStore } from "./sqlite-store.ts";
import { createPostgresClient, createPostgresStore } from "./postgres.ts";
import { runMigrations } from "./migrate.ts";
import { parseArticleCatalogueQuery, type ArticleCatalogueEntry } from "../domain/article-catalogue.ts";

for (const provider of ["sqlite", "postgres"] as const) {
  test(`the own-work catalogue pages every edition beyond 100, filters literally and never reads bodies (${provider})`, {
    skip: provider === "postgres" && !process.env.TEST_DATABASE_URL && "Set TEST_DATABASE_URL for real PostgreSQL.",
  }, async () => {
    const db = provider === "sqlite" ? createSqliteClient({ filename: ":memory:", enableWal: false }) : null;
    const sql = provider === "postgres" ? await createPostgresClient({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }) : null;
    if (db) await runSqliteMigrations(db);
    if (sql) await runMigrations(sql);
    const store = db ? createSqliteStore(db) : createPostgresStore(sql!);
    const actor = `catalogue-${randomUUID()}`, other = `outsider-${randomUUID()}`;
    const blocks = [{ id: "p1", type: "paragraph", text: "BODY-MUST-NOT-ENTER-CATALOGUE" }];
    const read = (query = "", actorId = actor) => store.listMyArticleCatalogue({ actorId, ...parseArticleCatalogueQuery(new URLSearchParams(query)) });
    try {
      const articles = [];
      for (let index = 0; index < 106; index++) {
        articles.push(await store.createArticle({ authorId: actor, slug: `catalogue-${index}-${randomUUID().slice(0, 8)}`, title: `作品 ${index} 中文`, summary: index === 0 ? "literal %_! needle" : `summary ${index}`,
          contentBlocks: blocks, locale: "zh-CN", publish: index % 2 === 0, workType: index % 2 === 0 ? "other" : "poetry" }));
      }
      const first = articles[0]!;
      await store.updateArticle({ actorId: actor, articleId: first.id, slug: first.slug, title: "English edition", summary: "literal %_! needle", contentBlocks: blocks, locale: "en", publish: true, workType: "other" });
      await store.updateArticle({ actorId: actor, articleId: first.id, slug: first.slug, title: "繁體版本", contentBlocks: blocks, locale: "zh-TW", publish: true, workType: "other" });
      await store.createArticle({ authorId: other, slug: `outsider-${randomUUID()}`, title: "PRIVATE-OTHER-AUTHOR", contentBlocks: blocks });
      const stamp = "2026-11-01T12:34:56.123Z";
      if (db) db.prepare("UPDATE article_translations SET created_at = ?, updated_at = ? WHERE article_id IN (SELECT id FROM articles WHERE author_id = ?)").run(stamp, stamp, actor);
      if (sql) await sql.unsafe("UPDATE article_translations SET created_at = $1::timestamptz, updated_at = $1::timestamptz WHERE article_id IN (SELECT id FROM articles WHERE author_id = $2)", ["2026-11-01T12:34:56.123456Z", actor]);
      for (const sort of ["updated", "created"]) {
        const seen: ArticleCatalogueEntry[] = [];
        let cursor: string | null = null;
        do {
          const page = await read(`limit=17&sort=${sort}${cursor ? `&cursor=${cursor}` : ""}`);
          assert.equal(page.total, 108);
          assert.equal(page.works, 106);
          assert.ok(page.items.length <= 17);
          seen.push(...page.items);
          cursor = page.nextCursor;
          assert.ok(seen.length <= 108, "exact microsecond seek cannot repeat a boundary forever");
        } while (cursor);
        assert.equal(seen.length, 108);
        assert.equal(new Set(seen.map(entry => `${entry.id}:${entry.locale}`)).size, 108);
        assert.ok(!JSON.stringify(seen).includes("BODY-MUST-NOT-ENTER-CATALOGUE"));
        assert.ok(!JSON.stringify(seen).includes("PRIVATE-OTHER-AUTHOR"));
        assert.ok(seen.every(entry => !("contentBlocks" in entry) && !("revision" in entry) && !("authorId" in entry)));
      }
      const editions = await store.listMyCatalogueEditions({ actorId: actor, articleId: first.id, scope: "active" });
      assert.deepEqual(new Set(editions.map(entry => entry.locale)), new Set(["zh-CN", "zh-TW", "en"]));
      assert.ok(editions.every(entry => !("contentBlocks" in entry)));
      assert.deepEqual(await store.listMyCatalogueEditions({ actorId: other, articleId: first.id, scope: "active" }), []);
      const literal = await read("q=%25_%21");
      assert.equal(literal.total, 2, "% and _ are literal text, not SQL wildcards");
      assert.equal((await read("q=english")).total, 0, "search is explicitly case-sensitive");
      assert.equal((await read("q=English")).total, 1);
      const en = await read("locale=en&status=published&workType=other&from=2026-11-01&until=2026-11-01");
      assert.equal(en.total, 1);
      assert.equal(en.facets.reduce((sum, facet) => sum + facet.count, 0), 108, "facets do not silently zero excluded languages/status/types");
      assert.equal((await read("from=2026-11-02")).total, 0);
      const page = await read("limit=1");
      await assert.rejects(() => read(`limit=1&cursor=${page.nextCursor}`, other));
      await assert.rejects(() => read(`limit=1&locale=en&cursor=${page.nextCursor}`));
      await store.updateArticle({ actorId: actor, articleId: first.id, slug: first.slug, title: "English edition", summary: "English changed independently", contentBlocks: blocks, locale: "en", publish: true, workType: "other" });
      const ownEditions = await store.listMyCatalogueEditions({ actorId: actor, articleId: first.id, scope: "active" });
      assert.equal(ownEditions.find(entry => entry.locale === "zh-CN")!.updatedAt, stamp);
      assert.notEqual(ownEditions.find(entry => entry.locale === "en")!.updatedAt, stamp, "editing English must not claim every translation was updated");
      await store.deleteArticle({ actorId: actor, articleId: first.id });
      const trash = await read("scope=trash");
      assert.equal(trash.total, 3);
      assert.equal(trash.works, 1);
      assert.ok(trash.items.every(entry => entry.deletedAt));
      assert.equal((await read()).total, 105);
      assert.equal((await read("scope=trash", other)).total, 0);
      await store.restoreArticle({ actorId: actor, articleId: first.id, locale: "en" });
      assert.equal((await read("scope=trash")).total, 0);
      assert.equal((await read("locale=en&status=draft")).total, 1, "restoring follows the existing all-edition draft policy");
    } finally {
      if (sql) { await sql.unsafe("DELETE FROM articles WHERE author_id = ANY($1::text[])", [[actor, other]]); await sql.end({ timeout: 5 }); }
      db?.close();
    }
  });
}
