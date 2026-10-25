import assert from "node:assert/strict";
import test from "node:test";
import { createSqliteClient, runSqliteMigrations } from "./sqlite.mjs";
import { createSqliteArticleStore } from "./sqlite-article-store.mjs";
import { ArticleAuthorizationError, ArticleSlugConflictError, ArticleInputError } from "../domain/errors.mjs";

const blocks = [{ id: "p1", type: "paragraph", text: "A small test article." }];

async function fixture() {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  await runSqliteMigrations(db);
  return { db, store: createSqliteArticleStore(db) };
}

test("SQLite article store creates, lists, and reads published translations", async () => {
  const { db, store } = await fixture();
  try {
    const created = store.createArticle({
      authorId: "author-1", slug: "first-article", title: "First Article",
      summary: "A summary", locale: "en", contentBlocks: blocks, publish: true,
    });
    assert.equal(created.status, "published");
    assert.deepEqual(created.contentBlocks, blocks);
    assert.equal(store.getPublishedArticle({ slug: "first-article", locale: "en" }).id, created.id);
    assert.equal(store.getPublishedArticle({ slug: "first-article", locale: "zh-CN" }), null);
    assert.equal(store.listPublishedArticles({ locale: "en" }).length, 1);
    assert.equal(store.listPublishedArticles({ locale: "en", query: "summary" }).length, 1);
    assert.equal(store.listMyArticles({ actorId: "author-1", locale: "en" }).length, 1);
    assert.equal(store.listRelatedArticles({ slug: "first-article", locale: "en" }).length, 0);
  } finally {
    db.close();
  }
});

test("SQLite article writes enforce ownership, slug uniqueness, and transaction rollback", async () => {
  const { db, store } = await fixture();
  try {
    const created = store.createArticle({
      authorId: "author-1", slug: "first-article", title: "First",
      contentBlocks: blocks, publish: true,
    });
    assert.throws(() => store.createArticle({
      authorId: "author-2", slug: "first-article", title: "Duplicate",
      contentBlocks: blocks,
    }), ArticleSlugConflictError);
    assert.throws(() => store.updateArticle({
      articleId: created.id, actorId: "intruder", slug: "first-article",
      title: "Hacked", contentBlocks: blocks,
    }), ArticleAuthorizationError);
    assert.equal(store.getPublishedArticle({ slug: "first-article" }).title, "First");

    assert.throws(() => store.createArticle({
      authorId: "author-1", slug: "rollback-check", title: "Rollback",
      contentBlocks: blocks, categoryIds: ["00000000-0000-4000-8000-000000000001"],
    }), ArticleInputError);
    assert.equal(db.prepare("SELECT count(*) AS count FROM articles WHERE slug = ?").get("rollback-check").count, 0);

    const updated = store.updateArticle({
      articleId: created.id, actorId: "author-1", slug: "first-article",
      title: "Updated", contentBlocks: blocks, publish: true,
    });
    assert.equal(updated.title, "Updated");
  } finally {
    db.close();
  }
});

test("SQLite article store validates query and pagination arguments", async () => {
  const { db, store } = await fixture();
  try {
    assert.throws(() => store.listPublishedArticles({ limit: 101 }), ArticleInputError);
    assert.throws(() => store.listPublishedArticles({ offset: -1 }), ArticleInputError);
    assert.throws(() => store.listPublishedArticles({ query: "x".repeat(201) }), ArticleInputError);
  } finally {
    db.close();
  }
});
