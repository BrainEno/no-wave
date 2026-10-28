import assert from "node:assert/strict";
import test from "node:test";
import { createSqliteClient, runSqliteMigrations } from "./sqlite.ts";
import { createSqliteArticleStore } from "./sqlite-article-store.ts";
import { createSqliteEngagementStore } from "./sqlite-engagement-store.ts";
import { ArticleAuthorizationError, ArticleInputError, ArticleNotFoundError } from "../domain/errors.ts";

const blocks = [{ id: "p1", type: "paragraph", text: "An engagement test article." }];
async function fixture() {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  await runSqliteMigrations(db);
  const articles = createSqliteArticleStore(db);
  const engagement = createSqliteEngagementStore(db);
  const article = articles.createArticle({
    authorId: "author-1", slug: "engagement-test", title: "Engagement Test",
    contentBlocks: blocks, locale: "en", publish: true,
  });
  return { db, articles, engagement, article };
}

test("SQLite likes are idempotent when set, toggle correctly, and notify the author", async () => {
  const { db, engagement, article } = await fixture();
  try {
    assert.deepEqual(engagement.getArticleLikeInfo({ slug: "engagement-test", locale: "en" }), {
      articleId: article.id, slug: "engagement-test", likeCount: 0, likedByViewer: false,
    });
    assert.equal(engagement.setArticleLike({ slug: "engagement-test", locale: "en", actorId: "reader-1", liked: true }).likeCount, 1);
    assert.equal(engagement.setArticleLike({ slug: "engagement-test", locale: "en", actorId: "reader-1", liked: true }).likeCount, 1);
    assert.equal(engagement.getArticleLikeInfo({ slug: "engagement-test", locale: "en", actorId: "reader-1" }).likedByViewer, true);
    assert.equal(db.prepare("SELECT count(*) AS n FROM notifications WHERE user_id = ?").get("author-1").n, 1);
    assert.equal(engagement.setArticleLike({ slug: "engagement-test", locale: "en", actorId: "author-1", liked: true }).likeCount, 2);
    assert.equal(db.prepare("SELECT count(*) AS n FROM notifications WHERE user_id = ?").get("author-1").n, 1);
    assert.equal(engagement.setArticleLike({ slug: "engagement-test", locale: "en", actorId: "reader-1", liked: false }).likeCount, 1);
    assert.equal(engagement.toggleArticleLike({ slug: "engagement-test", locale: "en", actorId: "reader-1" }).likeCount, 2);
    assert.throws(() => engagement.setArticleLike({ slug: "engagement-test", locale: "en", actorId: "reader-2", liked: "yes" }), ArticleInputError);
  } finally { db.close(); }
});

test("SQLite comment trees preserve parent-child structure and notify article and reply authors", async () => {
  const { db, engagement, article } = await fixture();
  try {
    const root = engagement.createArticleComment({ slug: "engagement-test", locale: "en", actorId: "reader-1", content: "  Root comment  " });
    assert.equal(root.content, "Root comment");
    const reply = engagement.createArticleComment({ slug: "engagement-test", locale: "en", actorId: "reader-2", content: "A reply", parentCommentId: root.id });
    assert.equal(reply.parentCommentId, root.id);
    const tree = engagement.listArticleComments({ slug: "engagement-test", locale: "en" });
    assert.equal(tree.length, 1);
    assert.equal(tree[0].id, root.id);
    assert.equal(tree[0].replies.length, 1);
    assert.equal(tree[0].replies[0].id, reply.id);
    assert.equal(tree[0].replies[0].locale, "en");
    assert.equal(db.prepare("SELECT count(*) AS n FROM notifications WHERE user_id = ?").get("author-1").n, 2);
    assert.equal(db.prepare("SELECT count(*) AS n FROM notifications WHERE user_id = ?").get("reader-1").n, 1);
    assert.equal(engagement.deleteArticleComment({ commentId: root.id, actorId: "reader-1" }), true);
    assert.equal(engagement.listArticleComments({ slug: "engagement-test", locale: "en" }).length, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM article_comments WHERE article_id = ?").get(article.id).n, 0);
  } finally { db.close(); }
});

test("SQLite comments persist rich v1 blocks and reject inconsistent fallback or unsupported nodes", async () => {
  const { db, engagement } = await fixture();
  try {
    const blocks = [{
      id: "comment-p1", type: "paragraph", text: "重点 链接",
      inlines: [{ text: "重点", marks: ["bold"] }, { text: " " }, { text: "链接", href: "/articles/example" }],
    }];
    const created = engagement.createArticleComment({
      slug: "engagement-test", locale: "en", actorId: "reader-rich",
      content: "重点 链接", contentBlocks: blocks, contentBlocksVersion: 1,
    });
    assert.equal(created.content, "重点 链接");
    assert.equal(created.contentBlocksVersion, 1);
    assert.deepEqual(created.contentBlocks, blocks);
    const listed = engagement.listArticleComments({ slug: "engagement-test", locale: "en" });
    assert.deepEqual(listed[0].contentBlocks, blocks);
    assert.equal(Number(db.prepare("SELECT content_blocks_version FROM article_comments WHERE id = ?").get(created.id).content_blocks_version), 1);
    assert.throws(() => engagement.createArticleComment({
      slug: "engagement-test", locale: "en", actorId: "reader-rich",
      content: "wrong", contentBlocks: blocks, contentBlocksVersion: 1,
    }), ArticleInputError);
    assert.throws(() => engagement.createArticleComment({
      slug: "engagement-test", locale: "en", actorId: "reader-rich", content: "code",
      contentBlocks: [{ id: "code", type: "code", language: "text", code: "code" }], contentBlocksVersion: 1,
    }), ArticleInputError);
  } finally { db.close(); }
});

test("SQLite comments validate parent ownership by article, input bounds, and delete authorization", async () => {
  const { db, articles, engagement } = await fixture();
  try {
    const root = engagement.createArticleComment({ slug: "engagement-test", locale: "en", actorId: "reader-1", content: "Root" });
    assert.throws(() => engagement.createArticleComment({ slug: "engagement-test", locale: "en", actorId: "reader-2", content: "Bad parent", parentCommentId: "not-a-uuid" }), ArticleInputError);
    assert.throws(() => engagement.createArticleComment({ slug: "engagement-test", locale: "en", actorId: "reader-2", content: " " }), ArticleInputError);
    assert.throws(() => engagement.createArticleComment({ slug: "engagement-test", locale: "en", actorId: "reader-2", content: "Reply", parentCommentId: "00000000-0000-4000-8000-000000000099" }), ArticleInputError);
    assert.throws(() => engagement.deleteArticleComment({ commentId: root.id, actorId: "intruder" }), ArticleAuthorizationError);
    assert.equal(engagement.deleteArticleComment({ commentId: "00000000-0000-4000-8000-000000000099", actorId: "intruder" }), false);
    assert.throws(() => engagement.listArticleComments({ slug: "engagement-test", locale: "en", limit: 101 }), ArticleInputError);
    articles.createArticle({ authorId: "author-1", slug: "draft-only", title: "Draft", contentBlocks: blocks, locale: "en" });
    assert.throws(() => engagement.toggleArticleLike({ slug: "missing", locale: "en", actorId: "reader-1" }), ArticleNotFoundError);
    assert.equal(engagement.getArticleLikeInfo({ slug: "draft-only", locale: "en" }), null);
  } finally { db.close(); }
});

test("SQLite comments notify a shared article/reply recipient only once", async () => {
  const { db, engagement } = await fixture();
  try {
    const root = engagement.createArticleComment({ slug: "engagement-test", locale: "en", actorId: "author-1", content: "Author root" });
    engagement.createArticleComment({ slug: "engagement-test", locale: "en", actorId: "reader-1", content: "Reply to author", parentCommentId: root.id });
    assert.equal(db.prepare("SELECT count(*) AS n FROM notifications WHERE user_id = ?").get("author-1").n, 1);
    const notification = JSON.parse(db.prepare("SELECT payload FROM notifications WHERE user_id = ?").get("author-1").payload);
    assert.equal(notification.type, "article.comment_replied");
  } finally { db.close(); }
});
