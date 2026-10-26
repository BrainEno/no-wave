import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { randomUUID } from "node:crypto";
import { IdempotencyConflictError, ConversationAccessError, ArticleAuthorizationError, ProfileInputError, ProfileNotFoundError } from "../domain/errors.ts";
import { createPostgresClient, createPostgresStore } from "./postgres.ts";
import { runMigrations } from "./migrate.ts";
import { createSqliteClient, runSqliteMigrations } from "./sqlite.ts";
import { createSqliteStore } from "./sqlite-store.ts";
import { dispatchOutboxBatch } from "./outbox-worker.ts";

const connectionString = process.env.TEST_DATABASE_URL;
let postgresSql;
let postgresStore;

before(async () => {
  if (!connectionString) return;
  postgresSql = await createPostgresClient({ connectionString, max: 4 });
  await runMigrations(postgresSql);
  postgresStore = createPostgresStore(postgresSql);
});

after(async () => {
  if (postgresSql) await postgresSql.end({ timeout: 5 });
});

async function sqliteFixture() {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  await runSqliteMigrations(db);
  return {
    store: createSqliteStore(db),
    async cleanup(conversationId, suffix) {
      if (conversationId) {
        const messages = db.prepare("SELECT id FROM messages WHERE conversation_id = ?").all(conversationId);
        for (const message of messages) {
          db.prepare("DELETE FROM outbox_events WHERE event_key = ?").run(`message:${message.id}`);
        }
        db.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId);
      }
      if (suffix) {
        const userIds = [
          `contract-user-a-${suffix}`, `contract-user-b-${suffix}`,
          `profile-follower-${suffix}`, `profile-target-${suffix}`, `profile-other-${suffix}`,
          `article-author-${suffix}`, `liker-a-${suffix}`, `liker-b-${suffix}`,
          `commenter-a-${suffix}`, `commenter-b-${suffix}`,
        ];
        for (const userId of userIds) db.prepare("DELETE FROM notifications WHERE user_id = ?").run(userId);
        db.prepare(`DELETE FROM user_follows WHERE follower_id IN (${userIds.map(() => "?").join(",")}) OR followed_id IN (${userIds.map(() => "?").join(",")})`)
          .run(...userIds, ...userIds);
        db.prepare(`DELETE FROM user_profile_translations WHERE user_id IN (${userIds.map(() => "?").join(",")})`).run(...userIds);
        db.prepare(`DELETE FROM user_profiles WHERE user_id IN (${userIds.map(() => "?").join(",")})`).run(...userIds);
        db.prepare("DELETE FROM revoked_sessions WHERE session_id = ?").run(`contract-session-${suffix}`);
        for (const slug of [`contract-draft-${suffix}`, `contract-published-${suffix}`, `contract-liked-${suffix}`, `contract-comment-${suffix}`, `contract-comment-notifications-${suffix}`]) db.prepare("DELETE FROM articles WHERE slug = ?").run(slug);
        db.prepare("DELETE FROM taxonomies WHERE slug = ?").run(`contract-category-${suffix}`);
      }
      db.close();
    },
  };
}

async function postgresFixture() {
  return {
    store: postgresStore,
    async cleanup(conversationId, suffix) {
      if (conversationId) {
        const messages = await postgresSql.unsafe(
          "SELECT id FROM messages WHERE conversation_id = $1",
          [conversationId],
        );
        for (const message of messages) {
          await postgresSql.unsafe("DELETE FROM outbox_events WHERE event_key = $1", [`message:${message.id}`]);
        }
        await postgresSql.unsafe("DELETE FROM conversations WHERE id = $1", [conversationId]);
      }
      if (suffix) {
        const userIds = [
          `contract-user-a-${suffix}`, `contract-user-b-${suffix}`,
          `profile-follower-${suffix}`, `profile-target-${suffix}`, `profile-other-${suffix}`,
        ];
        await postgresSql.unsafe("DELETE FROM notifications WHERE user_id = ANY($1::text[])", [userIds]);
        await postgresSql.unsafe("DELETE FROM user_follows WHERE follower_id = ANY($1::text[]) OR followed_id = ANY($1::text[])", [userIds]);
        await postgresSql.unsafe("DELETE FROM user_profile_translations WHERE user_id = ANY($1::text[])", [userIds]);
        await postgresSql.unsafe("DELETE FROM user_profiles WHERE user_id = ANY($1::text[])", [userIds]);
        await postgresSql.unsafe("DELETE FROM revoked_sessions WHERE session_id = ANY($1::text[])", [[`contract-session-${suffix}`, `contract-expired-session-${suffix}`]]);
        await postgresSql.unsafe("DELETE FROM articles WHERE slug = ANY($1::text[])", [[`contract-draft-${suffix}`, `contract-published-${suffix}`, `contract-liked-${suffix}`, `contract-comment-${suffix}`, `contract-comment-notifications-${suffix}`]]);
        await postgresSql.unsafe("DELETE FROM taxonomies WHERE slug = $1", [`contract-category-${suffix}`]);
      }
    },
  };
}

/** Run identical behavior assertions against each persistence adapter. */
function registerAdapterContracts(adapterName, fixture, options = {}) {
  test(`${adapterName}: message persistence is idempotent and rejects payload conflicts`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    let conversationId;
    try {
      const conversation = await runtime.store.createConversation({
        actorId: `sender-${suffix}`,
        participantIds: [`recipient-${suffix}`],
      });
      conversationId = conversation.id;
      const input = {
        conversationId,
        senderId: `sender-${suffix}`,
        body: "contract message",
        idempotencyKey: `key-${suffix}`,
      };
      const first = await runtime.store.persistMessage(input);
      const retry = await runtime.store.persistMessage(input);
      assert.equal(first.duplicate, false);
      assert.equal(retry.duplicate, true);
      assert.equal(retry.id, first.id);
      await assert.rejects(
        runtime.store.persistMessage({ ...input, body: "conflicting payload" }),
        IdempotencyConflictError,
      );
    } finally {
      await runtime.cleanup(conversationId);
    }
  });

  test(`${adapterName}: message persistence denies non-participants without creating messages`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    let conversationId;
    try {
      const conversation = await runtime.store.createConversation({
        actorId: `member-${suffix}`,
        participantIds: [`other-${suffix}`],
      });
      conversationId = conversation.id;
      await assert.rejects(
        runtime.store.persistMessage({
          conversationId,
          senderId: `outsider-${suffix}`,
          body: "must not persist",
          idempotencyKey: `key-${suffix}`,
        }),
        ConversationAccessError,
      );
      const history = await runtime.store.listConversationMessages({
        conversationId,
        actorId: `member-${suffix}`,
        limit: 10,
      });
      assert.deepEqual(history, []);
    } finally {
      await runtime.cleanup(conversationId);
    }
  });

  test(`${adapterName}: outbox dispatch delivers a persisted message exactly once`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    let conversationId;
    try {
      const conversation = await runtime.store.createConversation({
        actorId: `sender-${suffix}`,
        participantIds: [`recipient-${suffix}`],
      });
      conversationId = conversation.id;
      const message = await runtime.store.persistMessage({
        conversationId,
        senderId: `sender-${suffix}`,
        body: "deliver through the shared worker",
        idempotencyKey: `key-${suffix}`,
      });
      const delivered = [];
      const result = await dispatchOutboxBatch({
        store: runtime.store,
        deliver: async (event) => delivered.push(event),
        limit: 10,
        leaseSeconds: 30,
      });
      assert.deepEqual(result, { claimed: 1, delivered: 1, failed: 0 });
      assert.equal(delivered.length, 1);
      assert.equal(delivered[0].event_key, `message:${message.id}`);
      assert.equal(await runtime.store.markOutboxDelivered({ eventId: delivered[0].id }), false);
      assert.equal((await runtime.store.claimOutboxEvents({ limit: 10 })).length, 0);
    } finally {
      await runtime.cleanup(conversationId);
    }
  });

  test(`${adapterName}: notifications are user-scoped, idempotent, and reject event payload conflicts`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const userA = `contract-user-a-${suffix}`;
    const userB = `contract-user-b-${suffix}`;
    try {
      const payload = { type: "contract.notification", nested: { value: 1 } };
      const first = await runtime.store.createNotification({ userId: userA, eventKey: `event-${suffix}`, payload });
      const retry = await runtime.store.createNotification({ userId: userA, eventKey: `event-${suffix}`, payload });
      assert.equal(first.duplicate, false);
      assert.equal(retry.duplicate, true);
      assert.equal(retry.id, first.id);
      await assert.rejects(
        runtime.store.createNotification({
          userId: userA,
          eventKey: `event-${suffix}`,
          payload: { type: "different" },
        }),
        IdempotencyConflictError,
      );
      await runtime.store.createNotification({ userId: userB, eventKey: `other-event-${suffix}`, payload: { type: "private" } });
      assert.equal(await runtime.store.getUnreadNotificationCount({ actorId: userA }), 1);
      assert.equal((await runtime.store.listNotifications({ actorId: userA })).length, 1);
      assert.equal(await runtime.store.markNotificationRead({ notificationId: first.id, actorId: userB }), null);
      const read = await runtime.store.markNotificationRead({ notificationId: first.id, actorId: userA });
      assert.equal(read.id, first.id);
      assert.ok(read.readAt);
      assert.equal((await runtime.store.markNotificationRead({ notificationId: first.id, actorId: userA })).readAt, read.readAt);
      assert.equal(await runtime.store.getUnreadNotificationCount({ actorId: userA }), 0);
    } finally {
      await runtime.cleanup(undefined, suffix);
    }
  });

  test(`${adapterName}: session revocation preserves the furthest expiry and expires on schedule`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const sessionId = `contract-session-${suffix}`;
    try {
      assert.equal(await runtime.store.isSessionRevoked(sessionId), false);
      await runtime.store.revokeSession({ sessionId, expiresAt: "2099-01-01T00:00:00.000Z" });
      assert.equal(await runtime.store.isSessionRevoked(sessionId), true);
      await runtime.store.revokeSession({ sessionId, expiresAt: "2098-01-01T00:00:00.000Z" });
      assert.equal(await runtime.store.isSessionRevoked(sessionId), true);
      const expiredId = `contract-expired-session-${suffix}`;
      await runtime.store.revokeSession({ sessionId: expiredId, expiresAt: "2000-01-01T00:00:00.000Z" });
      assert.equal(await runtime.store.isSessionRevoked(expiredId), false);
      if (runtime.store === postgresStore) {
        await postgresSql.unsafe("DELETE FROM revoked_sessions WHERE session_id = $1", [expiredId]);
      } else {
        // Expired rows are harmless but remove the fixture to keep the test isolated.
        // The SQLite fixture is closed immediately after this test.
      }
    } finally {
      await runtime.cleanup(undefined, suffix);
    }
  });
  test(`${adapterName}: localized profiles, follow permissions, counts, and notifications stay consistent`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const followerId = `profile-follower-${suffix}`;
    const targetId = `profile-target-${suffix}`;
    const otherId = `profile-other-${suffix}`;
    try {
      const initial = await runtime.store.upsertAuthorProfile({
        userId: targetId, displayName: "Profile Target", bio: "English bio",
        avatarUrl: "/avatars/profile-target.png", websiteUrl: "https://example.com", locale: "en",
      });
      assert.equal(initial.followerCount, 0);
      await runtime.store.upsertAuthorProfile({ userId: targetId, displayName: "目标用户", bio: "中文简介", locale: "zh-CN" });
      const preserved = await runtime.store.upsertAuthorProfile({
        userId: targetId, displayName: "Updated Target", bio: "Updated English bio", locale: "en",
      });
      assert.equal(preserved.avatarUrl, "/avatars/profile-target.png");
      assert.equal(preserved.websiteUrl, "https://example.com/");
      assert.equal((await runtime.store.getAuthorProfile({ userId: targetId, locale: "zh-CN" })).displayName, "目标用户");
      assert.equal((await runtime.store.getAuthorProfile({ userId: targetId, locale: "en" })).displayName, "Updated Target");

      await runtime.store.upsertAuthorProfile({ userId: followerId, displayName: "Follower", locale: "en" });
      await runtime.store.upsertAuthorProfile({ userId: otherId, displayName: "Other Follower", locale: "en" });
      assert.equal(await runtime.store.followUser({ actorId: followerId, targetUserId: targetId }), true);
      assert.equal(await runtime.store.followUser({ actorId: followerId, targetUserId: targetId }), false);
      assert.equal(await runtime.store.followUser({ actorId: otherId, targetUserId: targetId }), true);

      const viewed = await runtime.store.getAuthorProfile({ userId: targetId, locale: "en", viewerId: followerId });
      assert.equal(viewed.followerCount, 2);
      assert.equal(viewed.isFollowing, true);
      assert.deepEqual((await runtime.store.listFollowing({ userId: followerId, locale: "en" })).map((item) => item.userId), [targetId]);
      assert.deepEqual((await runtime.store.listFollowers({ userId: targetId, locale: "en" })).map((item) => item.userId).sort(), [followerId, otherId].sort());
      assert.ok((await runtime.store.searchUsers({ query: targetId, locale: "en" })).some((item) => item.userId === targetId));

      const followNotifications = (await runtime.store.listNotifications({ actorId: targetId, limit: 100 }))
        .filter((item) => item.payload?.type === "user.followed");
      assert.equal(followNotifications.length, 2);
      assert.deepEqual(followNotifications.map((item) => item.payload.followerId).sort(), [followerId, otherId].sort());

      await assert.rejects(
        Promise.resolve().then(() => runtime.store.followUser({ actorId: targetId, targetUserId: targetId })),
        ProfileInputError,
      );
      await assert.rejects(
        Promise.resolve().then(() => runtime.store.followUser({ actorId: followerId, targetUserId: `profile-missing-${suffix}` })),
        ProfileNotFoundError,
      );
      assert.equal(await runtime.store.unfollowUser({ actorId: followerId, targetUserId: targetId }), true);
      assert.equal(await runtime.store.unfollowUser({ actorId: followerId, targetUserId: targetId }), false);
      assert.equal((await runtime.store.getAuthorProfile({ userId: targetId, locale: "en", viewerId: followerId })).followerCount, 1);
    } finally {
      await runtime.cleanup(undefined, suffix);
    }
  });
  test(`${adapterName}: drafts stay private to the published feed and article updates require ownership`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const slug = `contract-draft-${suffix}`;
    let articleId;
    try {
      const draft = await runtime.store.createArticle({
        authorId: `author-${suffix}`, slug, title: "Contract draft", summary: "Not public yet",
        locale: "zh-CN", contentBlocks: [{ id: "p1", type: "paragraph", text: "Shared contract content." }], publish: false,
      });
      articleId = draft.id;
      assert.equal(draft.status, "draft");
      assert.equal((await runtime.store.listPublishedArticles({ locale: "zh-CN", query: slug })).length, 0);
      assert.ok((await runtime.store.listMyArticles({ actorId: `author-${suffix}`, locale: "zh-CN" })).some((article) => article.id === articleId));
      await assert.rejects(Promise.resolve().then(() => runtime.store.updateArticle({
        articleId, actorId: `not-author-${suffix}`, slug, title: "Unauthorized update",
        locale: "zh-CN", contentBlocks: [{ id: "p1", type: "paragraph", text: "Shared contract content." }], publish: true,
      })), ArticleAuthorizationError);
      const published = await runtime.store.updateArticle({
        articleId, actorId: `author-${suffix}`, slug, title: "Now published", summary: "Visible in public feed",
        locale: "zh-CN", contentBlocks: [{ id: "p1", type: "paragraph", text: "Shared contract content." }], publish: true,
      });
      assert.equal(published.status, "published");
      assert.ok((await runtime.store.listPublishedArticles({ locale: "zh-CN", query: "Now published" })).some((article) => article.id === articleId));
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  test(`${adapterName}: published articles are discoverable through their assigned taxonomy`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const slug = `contract-published-${suffix}`;
    try {
      const taxonomy = await runtime.store.createTaxonomy({
        actorId: `taxonomy-owner-${suffix}`, kind: "category", slug: `contract-category-${suffix}`,
        name: "Contract category", description: "Shared persistence contract", locale: "zh-CN",
      });
      const article = await runtime.store.createArticle({
        authorId: `article-author-${suffix}`, slug, title: "Taxonomy contract article", summary: "",
        locale: "zh-CN", contentBlocks: [{ id: "p1", type: "paragraph", text: "Shared contract content." }], publish: true, categoryIds: [taxonomy.id],
      });
      const secondArticle = await runtime.store.createArticle({
        authorId: `article-author-${suffix}`, slug: `${slug}-second`, title: "Second taxonomy contract article", summary: "",
        locale: "zh-CN", contentBlocks: [{ id: "p1", type: "paragraph", text: "Second shared contract content." }], publish: true, categoryIds: [taxonomy.id],
      });
      const taxonomyArticles = await runtime.store.listTaxonomyArticles({ kind: "category", slug: taxonomy.slug, locale: "zh-CN", limit: 10 });
      assert.ok(taxonomyArticles.some((item) => item.id === article.id));
      assert.ok(taxonomyArticles.some((item) => item.id === secondArticle.id));
      const nextPage = await runtime.store.listTaxonomyArticles({ kind: "category", slug: taxonomy.slug, locale: "zh-CN", limit: 1, offset: 1 });
      assert.deepEqual(nextPage.map((item) => item.id), taxonomyArticles.slice(1, 2).map((item) => item.id));
      await assert.rejects(
        Promise.resolve().then(() => runtime.store.listTaxonomyArticles({ kind: "category", slug: taxonomy.slug, locale: "zh-CN", limit: 1, offset: -1 })),
        { code: "BAD_USER_INPUT" },
      );
      const assigned = await runtime.store.listArticleTaxonomies({ articleId: article.id, kind: "category", locale: "zh-CN" });
      assert.ok(assigned.some((item) => item.id === taxonomy.id));
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  test(`${adapterName}: taxonomy lists provide stable bounded offset pagination`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const query = `Pagination contract ${suffix}`;
    try {
      for (const label of ["A", "B", "C"]) {
        await runtime.store.createTaxonomy({
          actorId: `taxonomy-owner-${suffix}`, kind: "category",
          slug: `pagination-${label.toLowerCase()}-${suffix}`,
          name: `${query} ${label}`, description: "",
          locale: "zh-CN",
        });
      }
      const all = await runtime.store.listTaxonomies({
        kind: "category", locale: "zh-CN", query, limit: 10, offset: 0,
      });
      assert.equal(all.length, 3);
      const page = await runtime.store.listTaxonomies({
        kind: "category", locale: "zh-CN", query, limit: 1, offset: 1,
      });
      assert.deepEqual(page.map((item) => item.slug), all.slice(1, 2).map((item) => item.slug));
      await assert.rejects(
        Promise.resolve().then(() => runtime.store.listTaxonomies({
          kind: "category", locale: "zh-CN", query, limit: 1, offset: -1,
        })),
        { code: "BAD_USER_INPUT" },
      );
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  test(`${adapterName}: setting article likes is idempotent and liked lists are user-scoped`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const slug = `contract-liked-${suffix}`;
    try {
      const article = await runtime.store.createArticle({
        authorId: `article-author-${suffix}`, slug, title: "Like contract article", summary: "",
        locale: "zh-CN", contentBlocks: [{ id: "p1", type: "paragraph", text: "Shared contract content." }], publish: true,
      });
      const first = await runtime.store.setArticleLike({ slug, locale: "zh-CN", actorId: `liker-a-${suffix}`, liked: true });
      const second = await runtime.store.setArticleLike({ slug, locale: "zh-CN", actorId: `liker-a-${suffix}`, liked: true });
      assert.equal(first.likedByViewer, true);
      assert.equal(second.likedByViewer, true);
      assert.equal(second.likeCount, 1);
      assert.ok((await runtime.store.listLikedArticles({ actorId: `liker-a-${suffix}`, locale: "zh-CN" })).some((item) => item.id === article.id));
      assert.ok(!(await runtime.store.listLikedArticles({ actorId: `liker-b-${suffix}`, locale: "zh-CN" })).some((item) => item.id === article.id));
    } finally { await runtime.cleanup(undefined, suffix); }
  });


  test(`${adapterName}: article comments notify the right recipients atomically and suppress self-notifications`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const slug = `contract-comment-notifications-${suffix}`;
    const articleAuthor = `article-author-${suffix}`;
    const commenterA = `commenter-a-${suffix}`;
    const commenterB = `commenter-b-${suffix}`;
    try {
      await runtime.store.createArticle({
        authorId: articleAuthor, slug, title: "Comment notification contract", summary: "",
        locale: "zh-CN", contentBlocks: [{ id: "p1", type: "paragraph", text: "Shared persistence contract content." }], publish: true,
      });
      const root = await runtime.store.createArticleComment({
        slug, locale: "zh-CN", actorId: commenterA, content: "Root comment",
      });
      const rootNotifications = await runtime.store.listNotifications({ actorId: articleAuthor, limit: 100 });
      assert.equal(rootNotifications.filter((item) => item.eventKey === `article.commented:${root.id}`).length, 1);
      assert.equal((await runtime.store.listNotifications({ actorId: commenterA, limit: 100 })).length, 0);

      const reply = await runtime.store.createArticleComment({
        slug, locale: "zh-CN", actorId: commenterB, content: "Reply comment", parentCommentId: root.id,
      });
      const ownerNotifications = await runtime.store.listNotifications({ actorId: articleAuthor, limit: 100 });
      const parentNotifications = await runtime.store.listNotifications({ actorId: commenterA, limit: 100 });
      assert.equal(ownerNotifications.filter((item) => item.eventKey === `article.commented:${reply.id}`).length, 1);
      assert.equal(parentNotifications.filter((item) => item.eventKey === `article.comment_replied:${reply.id}`).length, 1);
      assert.equal((await runtime.store.listNotifications({ actorId: commenterB, limit: 100 })).length, 0);

      const selfComment = await runtime.store.createArticleComment({
        slug, locale: "zh-CN", actorId: articleAuthor, content: "Author comments on own article",
      });
      const ownerAfterSelfComment = await runtime.store.listNotifications({ actorId: articleAuthor, limit: 100 });
      assert.equal(ownerAfterSelfComment.filter((item) => item.eventKey === `article.commented:${selfComment.id}`).length, 0);

      const tree = await runtime.store.listArticleComments({ slug, locale: "zh-CN" });
      assert.equal(tree.length, 2);
      const rootNode = tree.find((node) => node.id === root.id);
      assert.ok(rootNode);
      assert.equal(rootNode.replies.length, 1);
      assert.equal(rootNode.replies[0].id, reply.id);
    } finally {
      await runtime.cleanup(undefined, suffix);
    }
  });
  test(`${adapterName}: article comment deletion is owner-only and idempotent after deletion`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const slug = `contract-comment-${suffix}`;
    try {
      await runtime.store.createArticle({
        authorId: `article-author-${suffix}`, slug, title: "Comment contract article", summary: "",
        locale: "zh-CN", contentBlocks: [{ id: "p1", type: "paragraph", text: "Shared contract content." }], publish: true,
      });
      const comment = await runtime.store.createArticleComment({
        slug, locale: "zh-CN", actorId: `commenter-a-${suffix}`, content: "A comment for the contract.",
      });
      await assert.rejects(Promise.resolve().then(() => runtime.store.deleteArticleComment({
        commentId: comment.id, actorId: `commenter-b-${suffix}`,
      })), ArticleAuthorizationError);
      assert.equal(await runtime.store.deleteArticleComment({ commentId: comment.id, actorId: `commenter-a-${suffix}` }), true);
      assert.equal(await runtime.store.deleteArticleComment({ commentId: comment.id, actorId: `commenter-a-${suffix}` }), false);
      assert.equal((await runtime.store.listArticleComments({ slug, locale: "zh-CN" })).length, 0);
    } finally { await runtime.cleanup(undefined, suffix); }
  });

}

registerAdapterContracts("SQLite", sqliteFixture);
registerAdapterContracts(
  "PostgreSQL",
  postgresFixture,
  { skip: !connectionString && "Set TEST_DATABASE_URL to run PostgreSQL persistence contracts." },
);
