import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createSqliteClient, runSqliteMigrations } from "../sqlite.ts";
import { createSqliteStore } from "../sqlite-store.ts";

/**
 * A small but complete SQLite database for the provider-transfer tests.
 *
 * The fixture is deliberately *wide* rather than deep: one row in each of the
 * shapes the copy has to get right — an identity account with a session, a media
 * asset that is both an avatar and an inline image, a translated taxonomy, a
 * published article whose content blocks reference that asset, a comment and a
 * reply (the only self-referencing foreign key), a like, a follow, the featured
 * shelf, and a conversation with a message and its outbox event.
 *
 * If a table is missing from here, the copy is not *wrong*, it is simply
 * untested for that shape, so additions belong here rather than in the callers.
 */
export async function createTransferSourceFixture() {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  await runSqliteMigrations(db);
  const store = createSqliteStore(db);
  const suffix = randomUUID().slice(0, 8);
  const author = `transfer-author-${suffix}`;
  const reader = `transfer-reader-${suffix}`;

  await store.createIdentityAccount({
    userId: author, email: `${author}@example.test`, passwordHash: "hash",
    session: {
      sessionId: `transfer-session-${suffix}`, userId: author, accessTokenId: randomUUID(),
      refreshHash: "a".repeat(64), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    },
  });
  const asset = await store.createMediaAsset({
    id: randomUUID(), ownerId: author, storageKey: `media/${suffix}.webp`, contentType: "image/webp",
    byteSize: 42, width: 2, height: 3, sha256: "b".repeat(64),
  });
  // The avatar media reference is derived from the stored URL, so exercising it
  // means going through the same door a real upload does.
  await store.upsertAuthorProfile({
    userId: author, displayName: "转移作者", bio: "简介", avatarUrl: `/media/${asset.id}`, locale: "zh-CN",
  });
  await store.upsertAuthorProfile({ userId: reader, displayName: "转移读者", locale: "zh-CN" });

  const category = await store.createTaxonomy({
    actorId: author, actorIsEditor: true, kind: "category", slug: `transfer-cat-${suffix}`,
    name: "转移分类", description: "", locale: "zh-CN",
  });
  const article = await store.createArticle({
    authorId: author, slug: `transfer-work-${suffix}`, title: "被转移的作品", summary: "摘要",
    locale: "zh-CN", publish: true, categoryIds: [category.id],
    contentBlocks: [
      { id: "p1", type: "paragraph", text: "正文第一段。" },
      { id: "i1", type: "image", src: `/media/${asset.id}`, alt: "插图" },
    ],
  });
  const root = await store.createArticleComment({ slug: article.slug, locale: "zh-CN", actorId: reader, content: "根评论" });
  const reply = await store.createArticleComment({
    slug: article.slug, locale: "zh-CN", actorId: author, content: "回复", parentCommentId: root.id,
  });
  await store.setArticleLike({ slug: article.slug, locale: "zh-CN", actorId: author, liked: true });
  await store.followUser({ actorId: reader, targetUserId: author });
  await store.setFeaturedArticles({ actorId: author, actorIsEditor: true, articleIds: [article.id], locale: "zh-CN" });
  const conversation = await store.createConversation({ actorId: reader, participantIds: [author] });
  assert.ok(conversation, "the fixture conversation must be created");
  await store.persistMessage({
    conversationId: conversation.id, senderId: reader, body: "你好", idempotencyKey: `transfer-message-${suffix}`,
  });
  return { db, store, suffix, author, reader, article, root, reply, asset, category, conversation };
}

/** An empty, migrated SQLite database: the only kind of target a copy accepts. */
export async function createEmptySqliteTarget() {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  await runSqliteMigrations(db);
  return { db, store: createSqliteStore(db) };
}
