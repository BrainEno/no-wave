import assert from "node:assert/strict";
import test from "node:test";
import { createSqliteClient, runSqliteMigrations } from "./sqlite.ts";
import { createSqliteArticleStore } from "./sqlite-article-store.ts";
import { ArticleAuthorizationError, ArticleSlugConflictError, ArticleInputError, ArticleNotFoundError } from "../domain/errors.ts";

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


test("SQLite public article listing filters by stable authorId before pagination", async () => {
  const { db, store } = await fixture();
  try {
    store.createArticle({
      authorId: "author-a", slug: "author-a-first", title: "First",
      locale: "zh-CN", contentBlocks: blocks, publish: true,
    });
    store.createArticle({
      authorId: "author-b", slug: "author-b-only", title: "Other author",
      locale: "zh-CN", contentBlocks: blocks, publish: true,
    });
    store.createArticle({
      authorId: "author-a", slug: "author-a-second", title: "Second",
      locale: "zh-CN", contentBlocks: blocks, publish: true,
    });

    const works = store.listPublishedArticles({ locale: "zh-CN", authorId: "author-a", limit: 100 });
    assert.equal(works.length, 2);
    assert.deepEqual(new Set(works.map((article) => article.authorId)), new Set(["author-a"]));
    assert.deepEqual(new Set(works.map((article) => article.slug)), new Set(["author-a-first", "author-a-second"]));
    assert.throws(() => store.listPublishedArticles({ authorId: " " }), ArticleInputError);
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

test("SQLite article deletion tombstones the work, releases its slug and hides it from the desk", async () => {
  const { db, store } = await fixture();
  try {
    const created = store.createArticle({
      authorId: "author-1", slug: "delete-me", title: "Delete me",
      contentBlocks: blocks, publish: true,
    });
    assert.equal(store.getPublishedArticle({ slug: "delete-me" }).title, "Delete me");

    assert.throws(() => store.deleteArticle({ articleId: "not-a-uuid", actorId: "author-1" }), ArticleInputError);
    assert.throws(() => store.deleteArticle({ articleId: created.id, actorId: "intruder" }), ArticleAuthorizationError);

    const deleted = store.deleteArticle({ articleId: created.id, actorId: "author-1" });
    assert.equal(deleted.id, created.id);
    assert.equal(typeof deleted.deletedAt, "string");

    // Hidden from the reader and from the author's own desk — the row is kept,
    // which is what `deleted_at` and the status rollback accomplish.
    assert.equal(store.getPublishedArticle({ slug: "delete-me" }), null);
    assert.equal(store.listPublishedArticles({ locale: "zh-CN" }).length, 0);
    assert.equal(store.listMyArticles({ actorId: "author-1", locale: "zh-CN" }).length, 0);
    assert.equal(db.prepare("SELECT count(*) AS count FROM articles WHERE id = ?").get(created.id).count, 1);

    // A tombstone is not a work: no update, and no second delete.
    assert.throws(() => store.updateArticle({
      articleId: created.id, actorId: "author-1", slug: "delete-me", title: "Back", contentBlocks: blocks,
    }), ArticleNotFoundError);
    assert.throws(() => store.deleteArticle({ articleId: created.id, actorId: "author-1" }), ArticleNotFoundError);

    // The address is released, so rewriting the same title is not a dead end.
    const rewritten = store.createArticle({
      authorId: "author-1", slug: "delete-me", title: "Delete me", contentBlocks: blocks, publish: true,
    });
    assert.equal(rewritten.slug, "delete-me");
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
