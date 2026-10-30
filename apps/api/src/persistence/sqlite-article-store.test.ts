import assert from "node:assert/strict";
import test from "node:test";
import { createSqliteClient, runSqliteMigrations } from "./sqlite.ts";
import { createSqliteArticleStore } from "./sqlite-article-store.ts";
import { createSqliteEngagementStore } from "./sqlite-engagement-store.ts";
import { createSqliteProviderMigrationJournal } from "./sqlite-provider-migration-journal.ts";
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

test("SQLite restore brings a tombstone back to the desk as a draft and reclaims its address", async () => {
  const { db, store } = await fixture();
  try {
    const created = store.createArticle({
      authorId: "author-1", slug: "restore-me", title: "Restore me",
      contentBlocks: blocks, publish: true,
    });
    store.deleteArticle({ articleId: created.id, actorId: "author-1" });

    // The recycle bin is the author's own tombstones, each one timestamped.
    const trashed = store.listMyDeletedArticles({ actorId: "author-1", locale: "zh-CN" });
    assert.equal(trashed.length, 1);
    assert.equal(trashed[0].id, created.id);
    assert.equal(typeof trashed[0].deletedAt, "string");
    assert.equal(store.listMyDeletedArticles({ actorId: "author-2", locale: "zh-CN" }).length, 0);
    assert.throws(() => store.listMyDeletedArticles({ actorId: "author-1", locale: "zh-CN", limit: 0 }), ArticleInputError);

    assert.throws(() => store.restoreArticle({ articleId: "not-a-uuid", actorId: "author-1" }), ArticleInputError);
    assert.throws(() => store.restoreArticle({ articleId: created.id, actorId: "intruder" }), ArticleAuthorizationError);

    const restored = store.restoreArticle({ articleId: created.id, actorId: "author-1", locale: "zh-CN" });
    assert.equal(restored.id, created.id);
    // A restore must not republish: deleting withdrew the work, and putting a
    // public address back is the author's decision to make again.
    assert.equal(restored.status, "draft");
    assert.equal(restored.slug, "restore-me", "the address the tombstone released comes back");
    assert.equal(store.listMyArticles({ actorId: "author-1", locale: "zh-CN" }).length, 1);
    assert.equal(store.getPublishedArticle({ slug: "restore-me" }), null);
    assert.equal(store.listMyDeletedArticles({ actorId: "author-1", locale: "zh-CN" }).length, 0);
    // A live work is not a tombstone, so a second restore is a 404.
    assert.throws(() => store.restoreArticle({ articleId: created.id, actorId: "author-1" }), ArticleNotFoundError);
  } finally {
    db.close();
  }
});

test("SQLite restore keeps the tombstone's own address when the original has been taken", async () => {
  const { db, store } = await fixture();
  try {
    const original = store.createArticle({
      authorId: "author-1", slug: "taken-me", title: "Taken",
      contentBlocks: blocks, publish: true,
    });
    store.deleteArticle({ articleId: original.id, actorId: "author-1" });
    const released = db.prepare("SELECT slug FROM articles WHERE id = ?").get(original.id).slug;
    assert.notEqual(released, "taken-me");

    const other = store.createArticle({
      authorId: "author-1", slug: "taken-me", title: "Someone else now",
      contentBlocks: blocks, publish: true,
    });
    // A restore must never fail over an address the author cannot see: the
    // reclaimed slug is taken, so the tombstone keeps the one it was given.
    const restored = store.restoreArticle({ articleId: original.id, actorId: "author-1", locale: "zh-CN" });
    assert.equal(restored.slug, released);
    assert.equal(store.getPublishedArticle({ slug: "taken-me" }).id, other.id);
  } finally {
    db.close();
  }
});

test("SQLite expired tombstones are swept with the rows that depend on them", async () => {
  const { db, store } = await fixture();
  const engagement = createSqliteEngagementStore(db);
  // A recording session is what makes capture observable at all: without one the
  // journal is correctly a no-op, and this test would be asserting nothing.
  const journal = createSqliteProviderMigrationJournal(db);
  const sessionId = `sweep-session-${Date.now()}`;
  journal.createSession({ sessionId, sourceProvider: "sqlite", targetProvider: "postgres", schemaVersion: "1" });
  assert.equal(journal.transitionSession({ sessionId, expectedStatus: "prepared", nextStatus: "recording" }), true);
  try {
    const created = store.createArticle({
      authorId: "author-1", slug: "sweep-me", title: "Sweep me",
      contentBlocks: blocks, publish: true,
    });
    // A reader's engagement is written before the deletion, and it is the
    // cascade — not the author — that makes purging a tombstone irreversible.
    engagement.setArticleLike({ slug: "sweep-me", locale: "zh-CN", actorId: "reader-1", liked: true });
    engagement.createArticleComment({ slug: "sweep-me", locale: "zh-CN", actorId: "reader-1", content: "A comment that outlives nothing." });
    store.deleteArticle({ articleId: created.id, actorId: "author-1" });

    // Inside the window the work is still recoverable.
    assert.equal(store.purgeExpiredArticles({ retentionDays: 30, now: new Date() }).purged, 0);
    assert.equal(db.prepare("SELECT count(*) AS count FROM articles WHERE id = ?").get(created.id).count, 1);
    assert.throws(() => store.purgeExpiredArticles({ retentionDays: 0 }), ArticleInputError);
    assert.throws(() => store.purgeExpiredArticles({ retentionDays: 30, limit: 0 }), ArticleInputError);

    // Past it, the row goes with everything that referred to it.
    const past = new Date(Date.now() + 31 * 86_400_000);
    assert.equal(store.purgeExpiredArticles({ retentionDays: 30, now: past }).purged, 1);
    assert.equal(db.prepare("SELECT count(*) AS count FROM articles WHERE id = ?").get(created.id).count, 0);
    assert.equal(db.prepare("SELECT count(*) AS count FROM article_translations WHERE article_id = ?").get(created.id).count, 0);
    assert.equal(db.prepare("SELECT count(*) AS count FROM article_likes WHERE article_id = ?").get(created.id).count, 0);
    assert.equal(db.prepare("SELECT count(*) AS count FROM article_comments WHERE article_id = ?").get(created.id).count, 0);

    // The journal carries the deletion and its children, so a replica replaying
    // this transaction does not keep a work the sweep has removed.
    // A comment is keyed by its own id, so the journal is read by entity type
    // here: what matters is that every row the cascade removes is named.
    const deleted = db.prepare("SELECT entity_type AS entityType FROM provider_migration_changes WHERE session_id = ? AND operation = 'delete'").all(sessionId).map((row) => row.entityType);
    assert.ok(deleted.includes("articles"));
    assert.ok(deleted.includes("article_translations"));
    assert.ok(deleted.includes("article_likes"));
    assert.ok(deleted.includes("article_comments"));

    // Bounded: a limit of one leaves the second tombstone for the next sweep.
    const first = store.createArticle({ authorId: "author-1", slug: "sweep-two", title: "Sweep two", contentBlocks: blocks });
    const second = store.createArticle({ authorId: "author-1", slug: "sweep-three", title: "Sweep three", contentBlocks: blocks });
    store.deleteArticle({ articleId: first.id, actorId: "author-1" });
    store.deleteArticle({ articleId: second.id, actorId: "author-1" });
    assert.equal(store.purgeExpiredArticles({ retentionDays: 30, now: past, limit: 1 }).purged, 1);
    assert.equal(store.listMyDeletedArticles({ actorId: "author-1", locale: "zh-CN" }).length, 1);
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
