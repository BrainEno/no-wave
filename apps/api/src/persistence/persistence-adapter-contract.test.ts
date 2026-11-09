import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { MAX_ARTICLE_OFFSET, MAX_ARTICLE_OFFSET_POPULAR, encodeArticleCursor } from "../domain/article.ts";
import { DEFAULT_AUTHOR_DISPLAY_NAME } from "../domain/profile.ts";
import { CommentDepthError, COMMENT_DEPTH_LIMIT_MESSAGE, MAX_COMMENT_REPLY_DEPTH } from "../domain/comment-content.ts";
import { ArticleInputError, ArticleSlugConflictError, ConversationInputError, IdempotencyConflictError, ConversationAccessError, ArticleAuthorizationError, ArticleNotFoundError, ProfileInputError, ProfileNotFoundError } from "../domain/errors.ts";
import { createPostgresClient, createPostgresStore } from "./postgres.ts";
import { runMigrations } from "./migrate.ts";
import { createSqliteClient, runSqliteMigrations } from "./sqlite.ts";
import { createSqliteStore } from "./sqlite-store.ts";
import { dispatchOutboxBatch } from "./outbox-worker.ts";
import { createMessageNotificationDelivery } from "./message-notification-delivery.ts";

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
  /**
   * Remove everything a test created, matched by its random suffix.
   *
   * Written after #241's fix added three ids the hand-maintained list in
   * `cleanup` did not know about: the leftovers made the author-directory paging
   * assertions fail in a *different* test, which is the worst kind of failure to
   * debug. Ids and slugs in this file all embed the per-test suffix, so the
   * suffix alone is enough — and a new test cannot forget to register itself.
   */
  const sweepBySuffix = (suffix: string): void => {
    const like = `%${suffix}%`;
    db.prepare("DELETE FROM notifications WHERE user_id LIKE ?").run(like);
    db.prepare("DELETE FROM user_follows WHERE follower_id LIKE ? OR followed_id LIKE ?").run(like, like);
    db.prepare("UPDATE user_profiles SET avatar_media_id = NULL WHERE user_id LIKE ?").run(like);
    db.prepare("DELETE FROM user_profile_translations WHERE user_id LIKE ?").run(like);
    db.prepare("DELETE FROM user_profiles WHERE user_id LIKE ?").run(like);
    db.prepare("DELETE FROM auth_accounts WHERE user_id LIKE ?").run(like);
    // Articles before assets: `article_media_refs` refuses an asset delete while
    // a work still points at it (#156). Author-matched as well as slug-matched,
    // because a released tombstone slug is truncated and no longer carries the
    // suffix.
    db.prepare("DELETE FROM articles WHERE slug LIKE ?").run(like);
    db.prepare("DELETE FROM articles WHERE author_id LIKE ?").run(like);
    db.prepare("DELETE FROM media_assets WHERE owner_id LIKE ?").run(like);
  };

  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  await runSqliteMigrations(db);
  return {
    store: createSqliteStore(db),
    async makeOutboxAvailable(eventId) {
      db.prepare("UPDATE outbox_events SET available_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", eventId);
    },
    async outboxAvailableAt(eventId) {
      return new Date(db.prepare("SELECT available_at FROM outbox_events WHERE id = ?").get(eventId).available_at).toISOString();
    },
    async setArticlePublishedAt(slug, publishedAt) {
      db.prepare("UPDATE articles SET published_at = ? WHERE slug = ?").run(publishedAt, slug);
    },
    async setArticleDeletedAt(id, deletedAt) {
      db.prepare("UPDATE articles SET deleted_at = ? WHERE id = ?").run(deletedAt, id);
    },
    /**
     * Write the type directly, the way a pre-retirement row got it.
     *
     * The create path now refuses a retired type, so a legacy work can only be
     * simulated below the contract — which is exactly how such a row got here.
     */
    async setArticleWorkType(id, workType) {
      db.prepare("UPDATE articles SET work_type = ? WHERE id = ?").run(workType, id);
    },
    async articleWorkType(id) {
      return db.prepare("SELECT work_type FROM articles WHERE id = ?").get(id).work_type;
    },
    async setMediaAssetCreatedAt(id, createdAt) {
      db.prepare("UPDATE media_assets SET created_at = ? WHERE id = ?").run(createdAt, id);
    },
    /**
     * Pin a notification's stored time.
     *
     * The inbox is ordered by `(created_at, id)`, and the interesting cases are
     * rows that share a millisecond — which `now()` will not produce on demand.
     */
    async setNotificationCreatedAt(id, createdAt) {
      db.prepare("UPDATE notifications SET created_at = ? WHERE id = ?").run(createdAt, id);
    },
    /**
     * Pin a comment's stored time.
     *
     * A thread pages by `(created_at, id)`, and the cases that matter are roots
     * sharing one millisecond — which `now()` will not produce on demand — and a
     * cursor that lands inside such a millisecond.
     */
    async setArticleCommentCreatedAt(id, createdAt) {
      db.prepare("UPDATE article_comments SET created_at = ? WHERE id = ?").run(createdAt, id);
    },
    /**
     * Remove a materialised media reference while leaving the body alone.
     *
     * That is the state a replay, an older writer or a direct SQL fix can leave
     * behind, and the state the delete guard must survive: the reference table is
     * the fast path, not proof, and `ON DELETE RESTRICT` has nothing to refuse
     * when the row was never written.
     */
    async dropMediaReference(assetId) {
      db.prepare("DELETE FROM article_media_refs WHERE asset_id = ?").run(assetId);
    },
    async clearAvatarMediaId(userId) {
      db.prepare("UPDATE user_profiles SET avatar_media_id = NULL WHERE user_id = ?").run(userId);
    },
    async cleanup(conversationId, suffix) {
      if (conversationId) {
        const messages = db.prepare("SELECT id FROM messages WHERE conversation_id = ?").all(conversationId);
        for (const message of messages) {
          db.prepare("DELETE FROM notifications WHERE event_key = ?").run(`message:${message.id}`);
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
          `feed-reader-${suffix}`, `feed-author-a-${suffix}`, `feed-author-b-${suffix}`, `feed-stranger-${suffix}`,
          `sort-author-${suffix}`, `sort-other-author-${suffix}`,
          `role-editor-${suffix}`, `role-target-${suffix}`, `featured-editor-${suffix}`, `featured-member-${suffix}`,
          `search-author-${suffix}`, `cursor-author-${suffix}`,
          `cursor-ms-author-${suffix}`, `cursor-ms-owner-${suffix}`,
          `identity-default-profile-${suffix}`,
          `restrict-owner-${suffix}`, `restrict-avatar-owner-${suffix}`,
          `media-ref-owner-${suffix}`, `avatar-ref-owner-${suffix}`,
          `drift-owner-${suffix}`, `drift-avatar-owner-${suffix}`,
          `sort-liker-${suffix}-1`,
          `sort-liker-${suffix}-2`,
          `sort-liker-${suffix}-3`,
          `sort-liker-${suffix}-4`,
          `sort-liker-${suffix}-5`,
          `sort-liker-${suffix}-6`,
          `sort-liker-${suffix}-7`,
          `sort-liker-${suffix}-8`,
          `sort-liker-${suffix}-9`,
          `sort-liker-${suffix}-10`,
        ];
        for (const userId of userIds) db.prepare("DELETE FROM notifications WHERE user_id = ?").run(userId);
        db.prepare(`DELETE FROM user_follows WHERE follower_id IN (${userIds.map(() => "?").join(",")}) OR followed_id IN (${userIds.map(() => "?").join(",")})`)
          .run(...userIds, ...userIds);
        db.prepare(`DELETE FROM user_profile_translations WHERE user_id IN (${userIds.map(() => "?").join(",")})`).run(...userIds);
        db.prepare(`DELETE FROM user_profiles WHERE user_id IN (${userIds.map(() => "?").join(",")})`).run(...userIds);
        db.prepare("DELETE FROM revoked_sessions WHERE session_id = ?").run(`contract-session-${suffix}`);
        // Order matters now that #156 added `ON DELETE RESTRICT`: the references
        // (and the articles that own them) have to go before the assets, and the
        // avatars before both. Without this the sweep would throw instead of
        // cleaning up, and the failure would surface as a broken *previous* test.
        db.prepare(`UPDATE user_profiles SET avatar_media_id = NULL WHERE user_id IN (${userIds.map(() => "?").join(",")})`).run(...userIds);
        db.prepare("DELETE FROM articles WHERE slug LIKE ?").run(`restrict-%-${suffix}`);
        db.prepare("DELETE FROM articles WHERE slug LIKE ?").run(`media-ref-%-${suffix}`);
        db.prepare("DELETE FROM media_assets WHERE owner_id IN (?, ?, ?, ?)").run(
          `cursor-ms-owner-${suffix}`, `restrict-owner-${suffix}`,
          `restrict-avatar-owner-${suffix}`, `media-ref-owner-${suffix}`,
        );
        db.prepare("DELETE FROM media_assets WHERE owner_id = ?").run(`avatar-ref-owner-${suffix}`);
        db.prepare("DELETE FROM auth_accounts WHERE user_id IN (?, ?, ?)").run(`cursor-ms-author-${suffix}`, `cursor-ms-owner-${suffix}`, `identity-default-profile-${suffix}`);
        db.prepare("DELETE FROM articles WHERE slug LIKE ?").run(`cursor-ms-%-${suffix}`);
        db.prepare("DELETE FROM articles WHERE slug LIKE ?").run(`contract-retired-${suffix}%`);
        for (const slug of [`contract-draft-${suffix}`, `contract-published-${suffix}`, `contract-liked-${suffix}`, `contract-comment-${suffix}`, `contract-comment-notifications-${suffix}`, `contract-create-once-${suffix}`, `contract-create-once-b-${suffix}`, `contract-create-twice-${suffix}`]) db.prepare("DELETE FROM articles WHERE slug = ?").run(slug);
        db.prepare("DELETE FROM articles WHERE slug LIKE ?").run(`feed-%-${suffix}`);
        db.prepare("DELETE FROM articles WHERE slug LIKE ?").run(`sort-%-${suffix}`);
        db.prepare("DELETE FROM articles WHERE slug LIKE ?").run(`search-%-${suffix}`);
        db.prepare("DELETE FROM articles WHERE slug LIKE ?").run(`cursor-%-${suffix}`);
        db.prepare("DELETE FROM articles WHERE slug LIKE ?").run(`auto-slug-%-${suffix}`);
        // A deleted work keeps its row under a released slug (`...-deleted-<id>`),
        // so match the whole family the deletion test can leave behind.
        db.prepare("DELETE FROM articles WHERE slug LIKE ?").run(`contract-delete-${suffix}%`);
        // Restore and sweep leave reclaimed and released addresses behind.
        db.prepare("DELETE FROM articles WHERE slug LIKE ?").run(`contract-restore-${suffix}%`);
        db.prepare("DELETE FROM articles WHERE slug LIKE ?").run(`contract-commenters-${suffix}%`);
        db.prepare("DELETE FROM taxonomies WHERE slug = ?").run(`contract-category-${suffix}`);
        db.prepare("DELETE FROM taxonomies WHERE slug LIKE ?").run(`%-${suffix}`);
        // The list above is a record of what each test used to create, not a
        // guarantee: a new test that forgets to add its ids leaves a published
        // author behind, and the next test that pages the author directory
        // fails with somebody else's name. So sweep by the suffix itself, which
        // every row this run created carries by construction.
        sweepBySuffix(suffix);
      }
      db.close();
    },
  };
}

async function postgresFixture() {
  /** Remove everything a test created, matched by its random suffix. */
  const sweepBySuffix = async (suffix: string): Promise<void> => {
    const like = `%${suffix}%`;
    await postgresSql.unsafe("DELETE FROM notifications WHERE user_id LIKE $1", [like]);
    await postgresSql.unsafe("DELETE FROM user_follows WHERE follower_id LIKE $1 OR followed_id LIKE $1", [like]);
    await postgresSql.unsafe("UPDATE user_profiles SET avatar_media_id = NULL WHERE user_id LIKE $1", [like]);
    await postgresSql.unsafe("DELETE FROM user_profile_translations WHERE user_id LIKE $1", [like]);
    await postgresSql.unsafe("DELETE FROM user_profiles WHERE user_id LIKE $1", [like]);
    await postgresSql.unsafe("DELETE FROM auth_accounts WHERE user_id LIKE $1", [like]);
    // Articles before assets: `ON DELETE RESTRICT` refuses an asset a work still
    // points at (#156). Author-matched as well as slug-matched, because a
    // released tombstone slug is truncated and no longer carries the suffix.
    await postgresSql.unsafe("DELETE FROM articles WHERE slug LIKE $1", [like]);
    await postgresSql.unsafe("DELETE FROM articles WHERE author_id LIKE $1", [like]);
    await postgresSql.unsafe("DELETE FROM media_assets WHERE owner_id LIKE $1", [like]);
  };

  return {
    store: postgresStore,
    async makeOutboxAvailable(eventId) {
      await postgresSql.unsafe("UPDATE outbox_events SET available_at = '2000-01-01T00:00:00Z' WHERE id = $1", [eventId]);
    },
    async outboxAvailableAt(eventId) {
      const [row] = await postgresSql.unsafe("SELECT available_at FROM outbox_events WHERE id = $1", [eventId]);
      return new Date(row.available_at).toISOString();
    },
    async setArticlePublishedAt(slug, publishedAt) {
      await postgresSql.unsafe("UPDATE articles SET published_at = $1 WHERE slug = $2", [publishedAt, slug]);
    },
    async setArticleDeletedAt(id, deletedAt) {
      await postgresSql.unsafe("UPDATE articles SET deleted_at = $1 WHERE id = $2", [deletedAt, id]);
    },
    async setArticleWorkType(id, workType) {
      await postgresSql.unsafe("UPDATE articles SET work_type = $2 WHERE id = $1", [id, workType]);
    },
    async articleWorkType(id) {
      const [row] = await postgresSql.unsafe("SELECT work_type FROM articles WHERE id = $1", [id]);
      return row.work_type;
    },
    async setMediaAssetCreatedAt(id, createdAt) {
      await postgresSql.unsafe("UPDATE media_assets SET created_at = $1 WHERE id = $2", [createdAt, id]);
    },
    async setNotificationCreatedAt(id, createdAt) {
      await postgresSql.unsafe("UPDATE notifications SET created_at = $1 WHERE id = $2", [createdAt, id]);
    },
    async setArticleCommentCreatedAt(id, createdAt) {
      await postgresSql.unsafe("UPDATE article_comments SET created_at = $1 WHERE id = $2", [createdAt, id]);
    },
    async dropMediaReference(assetId) {
      await postgresSql.unsafe("DELETE FROM article_media_refs WHERE asset_id = $1", [assetId]);
    },
    async clearAvatarMediaId(userId) {
      await postgresSql.unsafe("UPDATE user_profiles SET avatar_media_id = NULL WHERE user_id = $1", [userId]);
    },
    async cleanup(conversationId, suffix) {
      if (conversationId) {
        const messages = await postgresSql.unsafe(
          "SELECT id FROM messages WHERE conversation_id = $1",
          [conversationId],
        );
        for (const message of messages) {
          await postgresSql.unsafe("DELETE FROM notifications WHERE event_key = $1", [`message:${message.id}`]);
          await postgresSql.unsafe("DELETE FROM outbox_events WHERE event_key = $1", [`message:${message.id}`]);
        }
        await postgresSql.unsafe("DELETE FROM conversations WHERE id = $1", [conversationId]);
      }
      if (suffix) {
        const userIds = [
          `contract-user-a-${suffix}`, `contract-user-b-${suffix}`,
          `profile-follower-${suffix}`, `profile-target-${suffix}`, `profile-other-${suffix}`,
          `feed-reader-${suffix}`, `feed-author-a-${suffix}`, `feed-author-b-${suffix}`, `feed-stranger-${suffix}`,
          `sort-author-${suffix}`, `sort-other-author-${suffix}`,
          `role-editor-${suffix}`, `role-target-${suffix}`, `featured-editor-${suffix}`, `featured-member-${suffix}`,
          `search-author-${suffix}`, `cursor-author-${suffix}`,
          `cursor-ms-author-${suffix}`, `cursor-ms-owner-${suffix}`,
          `identity-default-profile-${suffix}`,
          `sort-liker-${suffix}-1`,
          `sort-liker-${suffix}-2`,
          `sort-liker-${suffix}-3`,
          `sort-liker-${suffix}-4`,
          `sort-liker-${suffix}-5`,
          `sort-liker-${suffix}-6`,
          `sort-liker-${suffix}-7`,
          `sort-liker-${suffix}-8`,
          `sort-liker-${suffix}-9`,
          `sort-liker-${suffix}-10`,
        ];
        await postgresSql.unsafe("DELETE FROM notifications WHERE user_id = ANY($1::text[])", [userIds]);
        await postgresSql.unsafe("DELETE FROM user_follows WHERE follower_id = ANY($1::text[]) OR followed_id = ANY($1::text[])", [userIds]);
        await postgresSql.unsafe("DELETE FROM user_profile_translations WHERE user_id = ANY($1::text[])", [userIds]);
        await postgresSql.unsafe("DELETE FROM user_profiles WHERE user_id = ANY($1::text[])", [userIds]);
        await postgresSql.unsafe("DELETE FROM revoked_sessions WHERE session_id = ANY($1::text[])", [[`contract-session-${suffix}`, `contract-expired-session-${suffix}`]]);
        await postgresSql.unsafe("DELETE FROM media_assets WHERE owner_id = $1", [`cursor-ms-owner-${suffix}`]);
        await postgresSql.unsafe("DELETE FROM auth_accounts WHERE user_id = ANY($1::text[])", [[`cursor-ms-author-${suffix}`, `cursor-ms-owner-${suffix}`, `identity-default-profile-${suffix}`]]);
        await postgresSql.unsafe("DELETE FROM articles WHERE slug LIKE $1", [`contract-retired-${suffix}%`]);
        await postgresSql.unsafe("DELETE FROM articles WHERE slug LIKE $1", [`cursor-ms-%-${suffix}`]);
        await postgresSql.unsafe("DELETE FROM articles WHERE slug = ANY($1::text[])", [[`contract-draft-${suffix}`, `contract-published-${suffix}`, `contract-liked-${suffix}`, `contract-comment-${suffix}`, `contract-comment-notifications-${suffix}`, `contract-create-once-${suffix}`, `contract-create-once-b-${suffix}`, `contract-create-twice-${suffix}`]]);
        // A deleted work keeps its row under a released slug (`...-deleted-<id>`).
        await postgresSql.unsafe("DELETE FROM articles WHERE slug LIKE $1", [`contract-delete-${suffix}%`]);
        // Restore and sweep leave reclaimed and released addresses behind.
        await postgresSql.unsafe("DELETE FROM articles WHERE slug LIKE $1", [`contract-restore-${suffix}%`]);
        await postgresSql.unsafe("DELETE FROM articles WHERE slug LIKE $1", [`contract-commenters-${suffix}%`]);
        await postgresSql.unsafe("DELETE FROM taxonomies WHERE slug = $1", [`contract-category-${suffix}`]);
        await postgresSql.unsafe("DELETE FROM taxonomies WHERE slug LIKE $1", [`%-${suffix}`]);
        await postgresSql.unsafe("DELETE FROM articles WHERE slug LIKE $1", [`feed-%-${suffix}`]);
        await postgresSql.unsafe("DELETE FROM articles WHERE slug LIKE $1", [`sort-%-${suffix}`]);
        await postgresSql.unsafe("DELETE FROM articles WHERE slug LIKE $1", [`search-%-${suffix}`]);
        await postgresSql.unsafe("DELETE FROM articles WHERE slug LIKE $1", [`cursor-%-${suffix}`]);
        await postgresSql.unsafe("DELETE FROM articles WHERE slug LIKE $1", [`auto-slug-%-${suffix}`]);
        // The list above is a record of what each test used to create, not a
        // guarantee: a new test that forgets to add its ids leaves a published
        // author behind, and the next test that pages the author directory fails
        // with somebody else's name. So sweep by the suffix itself, which every
        // row this run created carries by construction.
        await sweepBySuffix(suffix);
      }
    },
  };
}

/** Run identical behavior assertions against each persistence adapter. */
function registerAdapterContracts(adapterName, fixture, options = {}) {
  test(`${adapterName}: createIdentityAccount writes a default author profile in the same transaction`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const userId = `identity-default-profile-${suffix}`;
    const hour = new Date(Date.now() + 3_600_000).toISOString();
    try {
      const created = await runtime.store.createIdentityAccount({
        userId,
        email: `default-profile-${suffix}@example.test`,
        passwordHash: "hash-before",
        session: {
          sessionId: randomUUID(), userId, accessTokenId: randomUUID(),
          refreshHash: (suffix.replace(/-/g, "") + "a").padEnd(64, "a"), expiresAt: hour,
          accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
      });
      assert.equal(created, true);
      const profile = await runtime.store.getAuthorProfile({ userId, locale: "zh-CN", viewerId: null });
      assert.equal(profile?.displayName, DEFAULT_AUTHOR_DISPLAY_NAME);
      assert.equal(profile?.locale, "zh-CN");
      assert.equal(profile?.role, "member");
    } finally { await runtime.cleanup(null, suffix); }
  });

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

  test(`${adapterName}: a successful outbox dispatch marks a persisted event delivered`, options, async () => {
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
      assert.equal(await runtime.store.markOutboxDelivered({ eventId: delivered[0].id, leaseToken: delivered[0].lease_token }), false);
      assert.equal((await runtime.store.claimOutboxEvents({ limit: 10 })).length, 0);
    } finally {
      await runtime.cleanup(conversationId);
    }
  });

  test(`${adapterName}: the outbox backlog reports undelivered work and clears once delivered`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    let conversationId;
    try {
      // Compared as a delta: the shared PostgreSQL database can carry rows from
      // earlier tests, and this test is about the drain's own event.
      const before = await runtime.store.outboxBacklog();
      assert.ok(Number.isInteger(before.pendingEvents) && before.pendingEvents >= 0);
      assert.ok(before.oldestPendingAgeMs >= 0);

      const conversation = await runtime.store.createConversation({
        actorId: `sender-${suffix}`,
        participantIds: [`recipient-${suffix}`],
      });
      conversationId = conversation.id;
      await runtime.store.persistMessage({
        conversationId, senderId: `sender-${suffix}`, body: "counted in the backlog", idempotencyKey: `key-${suffix}`,
      });

      const pending = await runtime.store.outboxBacklog();
      assert.equal(pending.pendingEvents - before.pendingEvents, 1, "one persisted message queues exactly one event");

      const result = await dispatchOutboxBatch({
        store: runtime.store,
        deliver: async () => {},
        limit: 10,
      });
      assert.equal(result.delivered, 1);
      assert.equal((await runtime.store.outboxBacklog()).pendingEvents, before.pendingEvents);
    } finally {
      await runtime.cleanup(conversationId);
    }
  });

  test(`${adapterName}: opening a conversation is idempotent per caller and rejects a reused key with different participants`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const creator = `contract-user-a-${suffix}`;
    const invited = `contract-user-b-${suffix}`;
    const third = `contract-user-c-${suffix}`;
    let conversationId = null;
    try {
      const input = { actorId: creator, participantIds: [invited], idempotencyKey: `open-once-${suffix}` };
      const [first, retried, thirdAttempt] = await Promise.all([
        runtime.store.createConversation(input),
        runtime.store.createConversation(input),
        runtime.store.createConversation(input),
      ]);
      conversationId = first.id;
      assert.equal(new Set([first.id, retried.id, thirdAttempt.id]).size, 1, "concurrent retries must all return the one conversation");
      assert.equal(retried.id, first.id, "a retry must return the conversation the first attempt opened, not a second one beside it");
      assert.equal(
        (await runtime.store.listConversations({ actorId: creator, limit: 100 })).filter((item) => item.id === first.id).length,
        1,
      );

      await assert.rejects(
        Promise.resolve().then(() => runtime.store.createConversation({ ...input, participantIds: [third] })),
        IdempotencyConflictError,
        "the same key with a different body is a conflicting request, not a replay",
      );

      // The key is scoped to the caller: another user may reuse the same string.
      const theirs = await runtime.store.createConversation({ actorId: invited, participantIds: [creator], idempotencyKey: `open-once-${suffix}` });
      assert.notEqual(theirs.id, first.id);

      await assert.rejects(
        Promise.resolve().then(() => runtime.store.createConversation({ actorId: creator, participantIds: [invited], idempotencyKey: " not trimmed " })),
        ConversationInputError,
      );

      // A replay answers with what the conversation is now, not with a frozen
      // copy of the 201 the first attempt would have returned.
      await runtime.store.updateConversationParticipants({ conversationId: first.id, actorId: creator, addUserIds: [third], removeUserIds: [] });
      const replay = await runtime.store.createConversation(input);
      assert.equal(replay.id, first.id);
      assert.deepEqual(replay.participantIds, [creator, invited, third].sort());

      await runtime.store.deleteConversation({ conversationId: theirs.id, actorId: invited });
    } finally {
      await runtime.cleanup(conversationId, suffix);
    }
  });

  test(`${adapterName}: a participant update returns the same active member ids as every other provider`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const creator = `participants-creator-${suffix}`;
    const invited = `participants-invited-${suffix}`;
    const joined = `participants-joined-${suffix}`;
    let conversationId;
    try {
      const conversation = await runtime.store.createConversation({ actorId: creator, participantIds: [invited] });
      conversationId = conversation.id;
      const result = await runtime.store.updateConversationParticipants({
        conversationId, actorId: creator, addUserIds: [joined], removeUserIds: [invited],
      });
      assert.deepEqual(result, [creator, joined].sort());
      assert.deepEqual((await runtime.store.getConversation({ conversationId, actorId: creator })).participantIds, [creator, joined].sort());
    } finally {
      await runtime.cleanup(conversationId, suffix);
    }
  });

  test(`${adapterName}: expired and superseded outbox leases cannot acknowledge or postpone events`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    let conversationId;
    try {
      const conversation = await runtime.store.createConversation({
        actorId: `sender-${suffix}`,
        participantIds: [`recipient-${suffix}`],
      });
      conversationId = conversation.id;
      await runtime.store.persistMessage({
        conversationId, senderId: `sender-${suffix}`, body: "lease fencing", idempotencyKey: `key-${suffix}`,
      });

      const [first] = await runtime.store.claimOutboxEvents({ limit: 1, leaseSeconds: 60 });
      assert.ok(first);
      await assert.rejects(runtime.store.markOutboxDelivered({ eventId: first.id }), /leaseToken/);
      await assert.rejects(runtime.store.rescheduleOutboxEvent({ eventId: first.id, leaseToken: "not-a-uuid" }), /leaseToken/);
      assert.equal(await runtime.store.markOutboxDelivered({ eventId: first.id, leaseToken: randomUUID() }), false);
      assert.equal(await runtime.store.rescheduleOutboxEvent({ eventId: first.id, leaseToken: randomUUID() }), false);
      await runtime.makeOutboxAvailable(first.id);
      // Expiry alone invalidates the lease, even before another worker claims it.
      assert.equal(await runtime.store.markOutboxDelivered({ eventId: first.id, leaseToken: first.lease_token }), false);
      assert.equal(await runtime.store.rescheduleOutboxEvent({ eventId: first.id, leaseToken: first.lease_token }), false);

      const [second] = await runtime.store.claimOutboxEvents({ limit: 1, leaseSeconds: 60 });
      assert.equal(second.id, first.id);
      assert.equal(second.attempts, 2);
      assert.equal(typeof first.lease_token, "string");
      assert.equal(typeof second.lease_token, "string");
      assert.notEqual(second.lease_token, first.lease_token);
      assert.equal(await runtime.store.markOutboxDelivered({ eventId: first.id, leaseToken: first.lease_token }), false);
      assert.equal(await runtime.store.rescheduleOutboxEvent({ eventId: first.id, leaseToken: first.lease_token }), false);
      assert.equal((await runtime.store.claimOutboxEvents({ limit: 1 })).length, 0);
      assert.equal(await runtime.store.markOutboxDelivered({ eventId: second.id, leaseToken: second.lease_token }), true);
      assert.equal(await runtime.store.markOutboxDelivered({ eventId: second.id, leaseToken: second.lease_token }), false);
    } finally {
      await runtime.cleanup(conversationId);
    }
  });

  test(`${adapterName}: rescheduling releases a lease and a retry gets a new token`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    let conversationId;
    try {
      const conversation = await runtime.store.createConversation({
        actorId: `sender-${suffix}`,
        participantIds: [`recipient-${suffix}`],
      });
      conversationId = conversation.id;
      await runtime.store.persistMessage({
        conversationId, senderId: `sender-${suffix}`, body: "retry fencing", idempotencyKey: `key-${suffix}`,
      });
      const [first] = await runtime.store.claimOutboxEvents({ limit: 1 });
      assert.equal(await runtime.store.rescheduleOutboxEvent({ eventId: first.id, leaseToken: first.lease_token, delaySeconds: 60 }), true);
      assert.equal(await runtime.store.markOutboxDelivered({ eventId: first.id, leaseToken: first.lease_token }), false);
      assert.equal(await runtime.store.rescheduleOutboxEvent({ eventId: first.id, leaseToken: first.lease_token }), false);
      assert.equal((await runtime.store.claimOutboxEvents({ limit: 1 })).length, 0);
      await runtime.makeOutboxAvailable(first.id);
      const [retry] = await runtime.store.claimOutboxEvents({ limit: 1 });
      assert.equal(retry.id, first.id);
      assert.equal(retry.attempts, 2);
      assert.notEqual(retry.lease_token, first.lease_token);
      assert.equal(await runtime.store.markOutboxDelivered({ eventId: retry.id, leaseToken: retry.lease_token }), true);
    } finally {
      await runtime.cleanup(conversationId);
    }
  });

  test(`${adapterName}: concurrent workers cannot claim the same active outbox lease`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    let conversationId;
    try {
      const conversation = await runtime.store.createConversation({
        actorId: `sender-${suffix}`,
        participantIds: [`recipient-${suffix}`],
      });
      conversationId = conversation.id;
      await runtime.store.persistMessage({
        conversationId, senderId: `sender-${suffix}`, body: "one lease", idempotencyKey: `key-${suffix}`,
      });
      const claims = await Promise.all([
        runtime.store.claimOutboxEvents({ limit: 1 }),
        runtime.store.claimOutboxEvents({ limit: 1 }),
      ]);
      assert.equal(claims.flat().length, 1);
      const [event] = claims.flat();
      assert.equal(await runtime.store.markOutboxDelivered({ eventId: event.id, leaseToken: event.lease_token }), true);
    } finally {
      await runtime.cleanup(conversationId);
    }
  });

  for (const outcome of ["success", "failure"]) {
    test(`${adapterName}: a ${outcome} from a stale worker cannot disturb a newer lease`, options, async () => {
      const runtime = await fixture();
      const suffix = randomUUID();
      let conversationId;
      try {
        const conversation = await runtime.store.createConversation({
          actorId: `sender-${suffix}`,
          participantIds: [`recipient-${suffix}`],
        });
        conversationId = conversation.id;
        await runtime.store.persistMessage({
          conversationId, senderId: `sender-${suffix}`, body: "worker lease", idempotencyKey: `key-${suffix}`,
        });
        let newerLease;
        const result = await dispatchOutboxBatch({
          store: runtime.store,
          limit: 1,
          deliver: async (event) => {
            await runtime.makeOutboxAvailable(event.id);
            [newerLease] = await runtime.store.claimOutboxEvents({ limit: 1 });
            if (outcome === "failure") throw new Error("simulated stale delivery failure");
          },
        });
        assert.deepEqual(result, { claimed: 1, delivered: 0, failed: 1 });
        assert.ok(newerLease);
        assert.equal(await runtime.outboxAvailableAt(newerLease.id), new Date(newerLease.available_at).toISOString());
        assert.equal(await runtime.store.markOutboxDelivered({ eventId: newerLease.id, leaseToken: newerLease.lease_token }), true);
      } finally {
        await runtime.cleanup(conversationId);
      }
    });
  }

  test(`${adapterName}: a worker does not lease the rest of a batch while delivering one event`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    let conversationId;
    try {
      const conversation = await runtime.store.createConversation({
        actorId: `sender-${suffix}`,
        participantIds: [`recipient-${suffix}`],
      });
      conversationId = conversation.id;
      for (const key of ["first", "second"]) {
        await runtime.store.persistMessage({
          conversationId, senderId: `sender-${suffix}`, body: key, idempotencyKey: `${key}-${suffix}`,
        });
      }
      let otherWorkerEvent;
      const result = await dispatchOutboxBatch({
        store: runtime.store,
        limit: 2,
        deliver: async () => { [otherWorkerEvent] = await runtime.store.claimOutboxEvents({ limit: 1 }); },
      });
      assert.ok(otherWorkerEvent, "the next event should remain available to another worker");
      assert.deepEqual(result, { claimed: 1, delivered: 1, failed: 0 });
      assert.equal(await runtime.store.markOutboxDelivered({ eventId: otherWorkerEvent.id, leaseToken: otherWorkerEvent.lease_token }), true);
    } finally {
      await runtime.cleanup(conversationId);
    }
  });

  test(`${adapterName}: a partial inbox delivery retries without losing or duplicating notifications`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const sender = `sender-${suffix}`;
    const firstRecipient = `recipient-a-${suffix}`;
    const secondRecipient = `recipient-z-${suffix}`;
    let conversationId;
    try {
      const conversation = await runtime.store.createConversation({
        actorId: sender, participantIds: [firstRecipient, secondRecipient],
      });
      conversationId = conversation.id;
      const message = await runtime.store.persistMessage({
        conversationId, senderId: sender, body: "offline delivery", idempotencyKey: `key-${suffix}`,
      });
      let firstEvent;
      const firstAttempt = await dispatchOutboxBatch({
        store: runtime.store, limit: 1, retryDelaySeconds: 60,
        deliver: async (event) => {
          firstEvent = event;
          // Simulate an older worker that committed one recipient before it
          // crashed. The new atomic consumer must recover this legacy backlog.
          await runtime.store.createNotification({
            userId: firstRecipient,
            eventKey: event.event_key,
            payload: { type: "message.created", messageId: message.id, conversationId, senderId: sender },
          });
          throw new Error("simulated transient inbox failure");
        },
      });
      assert.deepEqual(firstAttempt, { claimed: 1, delivered: 0, failed: 1 });
      assert.equal((await runtime.store.listNotifications({ actorId: firstRecipient })).length, 1);
      assert.equal((await runtime.store.listNotifications({ actorId: secondRecipient })).length, 0);
      assert.equal((await runtime.store.listNotifications({ actorId: sender })).length, 0);
      assert.equal((await runtime.store.claimOutboxEvents({ limit: 1 })).length, 0);

      await runtime.makeOutboxAvailable(firstEvent.id);
      let retryEvent;
      const retry = await dispatchOutboxBatch({
        store: runtime.store, limit: 1,
        deliver: async (event) => {
          retryEvent = event;
          await createMessageNotificationDelivery({ store: runtime.store })(event);
        },
      });
      assert.deepEqual(retry, { claimed: 1, delivered: 1, failed: 0 });
      assert.equal(retryEvent.attempts, 2);
      assert.notEqual(retryEvent.lease_token, firstEvent.lease_token);
      for (const recipient of [firstRecipient, secondRecipient]) {
        const inbox = await runtime.store.listNotifications({ actorId: recipient });
        assert.equal(inbox.length, 1);
        assert.equal(inbox[0].eventKey, `message:${message.id}`);
        assert.equal(inbox[0].payload.messageId, message.id);
        assert.equal(inbox[0].payload.conversationId, conversationId);
        assert.equal(inbox[0].payload.senderId, sender);
      }
      assert.equal((await runtime.store.listNotifications({ actorId: sender })).length, 0);
      assert.equal((await runtime.store.claimOutboxEvents({ limit: 1 })).length, 0);
    } finally {
      await runtime.cleanup(conversationId);
    }
  });

  /**
   * The inbox cursor is the whole feature, and the two engines disagree about
   * time by default: SQLite stores the millisecond text it was given, PostgreSQL
   * stores `now()`'s microseconds. These assertions are the same on both, and the
   * ones about a shared millisecond are the reason migration 0030 exists.
   */
  test(`${adapterName}: the inbox pages backwards by (createdAt, id) without repeats or gaps`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const reader = `notif-page-reader-${suffix}`;
    const stranger = `notif-page-stranger-${suffix}`;
    // Newest first, oldest last, with three rows inside one millisecond so the id
    // tie-break has something to decide.
    const schedule = [
      "2026-06-01T00:00:00.125Z",
      "2026-06-01T00:00:00.123Z",
      "2026-06-01T00:00:00.123Z",
      "2026-06-01T00:00:00.123Z",
      "2026-06-01T00:00:00.121Z",
    ];
    /** The order a cursor walk must produce: newer first, then id descending. */
    const newestFirst = (rows) => [...rows].sort((left, right) => {
      if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1;
      return left.id < right.id ? 1 : -1;
    });
    try {
      const mine = [];
      for (const [index, createdAt] of schedule.entries()) {
        const created = await runtime.store.createNotification({
          userId: reader, eventKey: `page-${index}-${suffix}`, payload: { type: "page.test", index },
        });
        await runtime.setNotificationCreatedAt(created.id, createdAt);
        mine.push({ id: created.id, createdAt });
      }
      const theirs = [];
      for (const [index, createdAt] of schedule.slice(0, 2).entries()) {
        const created = await runtime.store.createNotification({
          userId: stranger, eventKey: `page-stranger-${index}-${suffix}`, payload: { type: "page.test" },
        });
        await runtime.setNotificationCreatedAt(created.id, createdAt);
        theirs.push({ id: created.id, createdAt });
      }
      const expected = newestFirst(mine).map((row) => row.id);

      /** Page like a client does: no cursor first, then the last row of each page. */
      const walk = async (pageSize, { onPage } = {}) => {
        const seen = [];
        let last = null;
        let page = 0;
        for (;;) {
          const rows = await runtime.store.listNotifications({
            actorId: reader,
            limit: pageSize,
            ...(last === null ? {} : { cursor: { at: last.createdAt, id: last.id } }),
          });
          if (rows.length === 0) break;
          assert.ok(rows.length <= pageSize, "a page never exceeds its limit");
          for (const row of rows) seen.push(row.id);
          last = rows[rows.length - 1];
          page += 1;
          assert.ok(page < 50, "the walk terminates");
          await onPage?.({ page, last, rows });
        }
        return seen;
      };

      // A three-page walk at a size that does not divide the rows.
      const walked = await walk(2);
      assert.deepEqual(walked, expected, "every notification is read once, in order");
      assert.deepEqual([...walked].sort(), [...expected].sort());
      assert.equal(new Set(walked).size, expected.length, "no notification is repeated");
      assert.ok(!walked.some((id) => theirs.some((row) => row.id === id)), "another account's inbox is invisible");

      // A size of one walks the same order.
      assert.deepEqual(await walk(1), expected);
      // And a page larger than the inbox returns everything, then an empty page.
      const all = await runtime.store.listNotifications({ actorId: reader, limit: 100 });
      assert.deepEqual(all.map((row) => row.id), expected);

      // Marking a notification read changes nothing about the order.
      await runtime.store.markNotificationRead({ notificationId: expected[2], actorId: reader });
      assert.deepEqual(await walk(2), expected, "read state does not move a row");

      // A notification that arrives mid-walk is newer than the cursor, so it must
      // not shift the older pages: no repeats, and nothing old is skipped.
      const seenWithIntruder = await walk(2, {
        onPage: async ({ page }) => {
          if (page !== 1) return;
          const intruder = await runtime.store.createNotification({
            userId: reader, eventKey: `page-intruder-${suffix}`, payload: { type: "page.test", intruder: true },
          });
          await runtime.setNotificationCreatedAt(intruder.id, "2026-06-01T00:00:09.000Z");
        },
      });
      assert.deepEqual(seenWithIntruder, expected, "a newer insert neither repeats nor hides an older row");

      // The stranger's own inbox pages independently.
      const strangerPage = await runtime.store.listNotifications({ actorId: stranger, limit: 1 });
      assert.equal(strangerPage.length, 1);
      assert.equal(strangerPage[0].userId, stranger);
      const strangerRest = await runtime.store.listNotifications({
        actorId: stranger, limit: 10,
        cursor: { at: strangerPage[0].createdAt, id: strangerPage[0].id },
      });
      assert.deepEqual(
        [...strangerPage, ...strangerRest].map((row) => row.id),
        newestFirst(theirs).map((row) => row.id),
      );

      // Limits and cursor shapes are validated, not guessed at.
      await assert.rejects(runtime.store.listNotifications({ actorId: reader, limit: 0 }), TypeError);
      await assert.rejects(runtime.store.listNotifications({ actorId: reader, limit: 101 }), TypeError);
      await assert.rejects(runtime.store.listNotifications({ actorId: reader, cursor: "not-a-cursor" }), TypeError);
      await assert.rejects(runtime.store.listNotifications({ actorId: reader, cursor: { at: "2026-06-01T00:00:00.123Z" } }), TypeError);
    } finally {
      await runtime.cleanup(undefined, suffix);
    }
  });

  test(`${adapterName}: a pending message notifies current members even after its sender leaves`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const owner = `owner-${suffix}`;
    const sender = `sender-${suffix}`;
    const remaining = `remaining-${suffix}`;
    const removed = `removed-${suffix}`;
    const joinedLater = `joined-later-${suffix}`;
    let conversationId;
    try {
      const conversation = await runtime.store.createConversation({
        actorId: owner, participantIds: [sender, remaining, removed],
      });
      conversationId = conversation.id;
      const message = await runtime.store.persistMessage({
        conversationId, senderId: sender, body: "pending notification", idempotencyKey: `key-${suffix}`,
      });
      await runtime.store.updateConversationParticipants({
        conversationId, actorId: owner, removeUserIds: [sender, removed], addUserIds: [joinedLater],
      });
      let deliveredEvent;
      const result = await dispatchOutboxBatch({
        store: runtime.store, limit: 1,
        deliver: async (event) => {
          deliveredEvent = event;
          await createMessageNotificationDelivery({ store: runtime.store })(event);
        },
      });
      assert.deepEqual(result, { claimed: 1, delivered: 1, failed: 0 });
      // Retrying an already committed delivery must remain safe.
      await createMessageNotificationDelivery({ store: runtime.store })(deliveredEvent);
      for (const user of [owner, remaining, joinedLater]) {
        const inbox = await runtime.store.listNotifications({ actorId: user });
        assert.equal(inbox.length, 1);
        assert.equal(inbox[0].eventKey, `message:${message.id}`);
        assert.equal(inbox[0].payload.senderId, sender);
      }
      assert.equal((await runtime.store.listNotifications({ actorId: sender })).length, 0);
      assert.equal((await runtime.store.listNotifications({ actorId: removed })).length, 0);
      assert.equal((await runtime.store.claimOutboxEvents({ limit: 1 })).length, 0);
    } finally {
      await runtime.cleanup(conversationId);
    }
  });

  test(`${adapterName}: a stale delivery after conversation deletion never creates orphaned inbox rows`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const owner = `delete-owner-${suffix}`;
    const recipient = `delete-recipient-${suffix}`;
    let conversationId;
    try {
      const conversation = await runtime.store.createConversation({ actorId: owner, participantIds: [recipient] });
      conversationId = conversation.id;
      await runtime.store.persistMessage({
        conversationId, senderId: owner, body: "delete while in flight", idempotencyKey: `key-${suffix}`,
      });
      const [event] = await runtime.store.claimOutboxEvents({ limit: 1 });
      assert.ok(event);
      assert.equal(await runtime.store.deleteConversation({ conversationId, actorId: owner }), true);
      await createMessageNotificationDelivery({ store: runtime.store })(event);
      assert.equal((await runtime.store.listNotifications({ actorId: recipient })).length, 0);
      assert.equal(await runtime.store.markOutboxDelivered({ eventId: event.id, leaseToken: event.lease_token }), false);
    } finally {
      await runtime.cleanup(conversationId);
    }
  });

  test(`${adapterName}: an inbox idempotency conflict rolls back the whole message delivery`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const sender = `rollback-sender-${suffix}`;
    const first = `rollback-a-${suffix}`;
    const conflicted = `rollback-z-${suffix}`;
    let conversationId;
    try {
      const conversation = await runtime.store.createConversation({ actorId: sender, participantIds: [first, conflicted] });
      conversationId = conversation.id;
      const message = await runtime.store.persistMessage({ conversationId, senderId: sender, body: "atomic inbox", idempotencyKey: `key-${suffix}` });
      await runtime.store.createNotification({ userId: conflicted, eventKey: `message:${message.id}`, payload: { type: "different" } });
      const [event] = await runtime.store.claimOutboxEvents({ limit: 1 });
      await assert.rejects(createMessageNotificationDelivery({ store: runtime.store })(event), IdempotencyConflictError);
      assert.equal((await runtime.store.listNotifications({ actorId: first })).length, 0);
      const conflictInbox = await runtime.store.listNotifications({ actorId: conflicted });
      assert.equal(conflictInbox.length, 1);
      assert.deepEqual(conflictInbox[0].payload, { type: "different" });
      assert.equal(await runtime.store.rescheduleOutboxEvent({ eventId: event.id, leaseToken: event.lease_token, delaySeconds: 1 }), true);
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

  /**
   * The batch inbox write (audit F-23).
   *
   * Deleting a work tells up to 200 commenters. The per-row call is a transaction
   * of its own, so the desk used to hold the SQLite write lock 200 times inside one
   * `DELETE` request. The batch must be *the same work*, not a cheaper variant:
   * same receipts, same duplicate handling, same payload-conflict refusal, and one
   * transaction that either lands whole or not at all.
   */
  test(`${adapterName}: batch inbox writes match the single writes, in order and in one transaction`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const users = [`batch-notify-a-${suffix}`, `batch-notify-b-${suffix}`, `batch-notify-c-${suffix}`];
    try {
      const events = users.map((userId, index) => ({
        userId,
        eventKey: `batch-event-${index}-${suffix}`,
        payload: { type: "contract.batch", index },
      }));

      // The per-row answer, for comparison.
      const singles = [];
      for (const event of events) singles.push(await runtime.store.createNotification(event));

      // A batch of the same events is all duplicates of what already exists, reported
      // in input order and with the ids the first writes produced.
      const duplicates = await runtime.store.createNotifications(events);
      assert.deepEqual(duplicates.map((receipt) => receipt.userId), users);
      assert.deepEqual(duplicates.map((receipt) => receipt.duplicate), [true, true, true]);
      assert.deepEqual(duplicates.map((receipt) => receipt.id), singles.map((receipt) => receipt.id));

      // New keys in one call: one receipt each, none of them a duplicate.
      const fresh = await runtime.store.createNotifications(
        users.map((userId, index) => ({
          userId,
          eventKey: `batch-fresh-${index}-${suffix}`,
          payload: { type: "contract.batch.fresh", index },
        })),
      );
      assert.deepEqual(fresh.map((receipt) => receipt.duplicate), [false, false, false]);
      assert.equal(new Set(fresh.map((receipt) => receipt.id)).size, users.length);
      assert.equal(await runtime.store.getUnreadNotificationCount({ actorId: users[0] }), 2);

      // One conflict inside a batch refuses the whole batch: a caller that asked
      // for three notices is never handed two and no error.
      const before = await runtime.store.getUnreadNotificationCount({ actorId: users[1] });
      await assert.rejects(
        runtime.store.createNotifications([
          { userId: users[1], eventKey: `batch-fresh-1-${suffix}`, payload: { type: "conflict.retry" } },
          { userId: users[1], eventKey: `batch-rollback-${suffix}`, payload: { type: "contract.batch.rollback" } },
        ]),
        IdempotencyConflictError,
      );
      assert.equal(await runtime.store.getUnreadNotificationCount({ actorId: users[1] }), before, "nothing from the failed batch landed");

      // An empty batch is a no-op, not an error.
      assert.deepEqual(await runtime.store.createNotifications([]), []);
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
    const richTextBlocks = [{
      id: "p1", type: "paragraph", text: "Shared contract content.",
      inlines: [{ text: "Shared " }, { text: "contract", marks: ["bold"] }, { text: " content.", href: "/articles/contract" }],
    }];
    let articleId;
    try {
      const draft = await runtime.store.createArticle({
        authorId: `author-${suffix}`, slug, title: "Contract draft", summary: "Not public yet",
        locale: "zh-CN", contentBlocks: richTextBlocks, contentBlocksVersion: 1, publish: false,
      });
      articleId = draft.id;
      assert.equal(draft.status, "draft");
      assert.equal(draft.contentBlocksVersion, 1);
      assert.deepEqual(draft.contentBlocks, richTextBlocks);
      assert.equal((await runtime.store.listPublishedArticles({ locale: "zh-CN", query: slug })).length, 0);
      assert.ok((await runtime.store.listMyArticles({ actorId: `author-${suffix}`, locale: "zh-CN" })).some((article) => article.id === articleId));
      await assert.rejects(Promise.resolve().then(() => runtime.store.updateArticle({
        articleId, actorId: `not-author-${suffix}`, slug, title: "Unauthorized update",
        locale: "zh-CN", contentBlocks: [{ id: "p1", type: "paragraph", text: "Shared contract content." }], publish: true,
      })), ArticleAuthorizationError);
      const published = await runtime.store.updateArticle({
        articleId, actorId: `author-${suffix}`, slug, title: "Now published", summary: "Visible in public feed",
        locale: "zh-CN", contentBlocks: richTextBlocks, contentBlocksVersion: 1, publish: true,
      });
      assert.equal(published.status, "published");
      assert.equal(published.contentBlocksVersion, 1);
      assert.deepEqual(published.contentBlocks, richTextBlocks);
      assert.ok((await runtime.store.listPublishedArticles({ locale: "zh-CN", query: "Now published" })).some((article) => article.id === articleId));
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  test(`${adapterName}: a retired work type cannot be created or retyped to, while a stored one stays editable`, options, async () => {
    // ADR 0016 / 38d087b retired 连载 (`serial`). #196 removed it from the desk's
    // create list, but the write contract still accepted it, so a client posting
    // directly could create work the product says it does not publish. The other
    // half matters just as much: legacy rows must keep being editable.
    const runtime = await fixture();
    const suffix = randomUUID();
    const slug = `contract-retired-${suffix}`;
    const block = [{ id: "p1", type: "paragraph", text: "Short form." }];
    try {
      await assert.rejects(
        Promise.resolve().then(() => runtime.store.createArticle({
          authorId: `author-${suffix}`, slug, title: "A serialised work", locale: "zh-CN",
          contentBlocks: block, workType: "serial",
        })),
        (error) => error instanceof ArticleInputError && /"serial" is retired/.test(error.message),
      );
      // Nothing was written, so the address is still free for a supported type.
      const created = await runtime.store.createArticle({
        authorId: `author-${suffix}`, slug, title: "A short story", locale: "zh-CN",
        contentBlocks: block, workType: "short_story",
      });
      assert.equal(created.workType, "short_story");

      // A row that predates the retirement: written below the contract, exactly
      // as the old API left it.
      await runtime.setArticleWorkType(created.id, "serial");
      const edited = await runtime.store.updateArticle({
        articleId: created.id, actorId: `author-${suffix}`, slug,
        title: "A short story, corrected", locale: "zh-CN", contentBlocks: block,
        publish: false, workType: "serial",
      });
      assert.equal(edited.workType, "serial", "saving an existing serial work must not retype or reject it");

      const retyped = await runtime.store.updateArticle({
        articleId: created.id, actorId: `author-${suffix}`, slug,
        title: "Now a short story", locale: "zh-CN", contentBlocks: block,
        publish: false, workType: "short_story",
      });
      assert.equal(retyped.workType, "short_story", "an author may retype legacy work to a supported type");

      await assert.rejects(
        Promise.resolve().then(() => runtime.store.updateArticle({
          articleId: created.id, actorId: `author-${suffix}`, slug,
          title: "Back to serial", locale: "zh-CN", contentBlocks: block,
          publish: false, workType: "serial",
        })),
        (error) => error instanceof ArticleInputError && /cannot be retyped to it/.test(error.message),
      );
      assert.equal(await runtime.articleWorkType(created.id), "short_story", "the rejected update changed nothing");
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  test(`${adapterName}: deleting a work takes it out of the desk and releases its address`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const slug = `contract-delete-${suffix}`;
    const authorId = `author-${suffix}`;
    const contentBlocks = [{ id: "p1", type: "paragraph", text: "Deleted on purpose." }];
    try {
      const created = await runtime.store.createArticle({
        authorId, slug, title: "Soon deleted", locale: "zh-CN", contentBlocks, publish: true,
      });
      // The public list searches titles and summaries, not addresses.
      assert.ok((await runtime.store.listPublishedArticles({ locale: "zh-CN", query: "Soon deleted" })).some((article) => article.id === created.id));

      await assert.rejects(Promise.resolve().then(() => runtime.store.deleteArticle({
        articleId: created.id, actorId: `not-author-${suffix}`,
      })), ArticleAuthorizationError);

      const deleted = await runtime.store.deleteArticle({ articleId: created.id, actorId: authorId });
      assert.equal(deleted.id, created.id);
      assert.ok(deleted.deletedAt, "deletion is timestamped, not silent");

      // Gone from the reader's feed and from the author's own desk.
      assert.equal((await runtime.store.listPublishedArticles({ locale: "zh-CN", query: "Soon deleted" })).length, 0);
      assert.equal((await runtime.store.listMyArticles({ actorId: authorId, locale: "zh-CN" })).filter((article) => article.id === created.id).length, 0);

      // A tombstone is not a work any more: it cannot be updated, and deleting it
      // twice is a 404 rather than a second tombstone over the first.
      await assert.rejects(Promise.resolve().then(() => runtime.store.updateArticle({
        articleId: created.id, actorId: authorId, slug, title: "Back again", locale: "zh-CN", contentBlocks, publish: true,
      })), ArticleNotFoundError);
      await assert.rejects(Promise.resolve().then(() => runtime.store.deleteArticle({
        articleId: created.id, actorId: authorId,
      })), ArticleNotFoundError);

      // The address is released, so rewriting the same title is not a dead end.
      const rewritten = await runtime.store.createArticle({
        authorId, slug, title: "Written again", locale: "zh-CN", contentBlocks, publish: true,
      });
      assert.equal(rewritten.slug, slug);
      assert.ok((await runtime.store.listPublishedArticles({ locale: "zh-CN", query: "Written again" })).some((article) => article.id === rewritten.id));
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  test(`${adapterName}: a deleted work can be restored, and a tombstone past its window is swept`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const slug = `contract-restore-${suffix}`;
    const authorId = `author-${suffix}`;
    const contentBlocks = [{ id: "p1", type: "paragraph", text: "Restored on purpose." }];
    try {
      const created = await runtime.store.createArticle({
        authorId, slug, title: "Soon restored", locale: "zh-CN", contentBlocks, publish: true,
      });
      // A reader's words, written before the deletion: the sweep removes them
      // with the work, so the recycle bin has to name them.
      await runtime.store.createArticleComment({
        slug, locale: "zh-CN", actorId: `commenter-a-${suffix}`, content: "A reader's words.",
      });
      await runtime.store.deleteArticle({ articleId: created.id, actorId: authorId });

      // The recycle bin is the author's own tombstones, each one timestamped.
      const tombstones = await runtime.store.listMyDeletedArticles({ actorId: authorId, locale: "zh-CN" });
      assert.ok(tombstones.some((article) => article.id === created.id), "a deleted work is still the author's to find");
      assert.ok(tombstones.every((article) => typeof article.deletedAt === "string" && article.deletedAt.length > 0));
      // The cost of the window is other people's words, and it is counted here
      // rather than guessed by the desk.
      assert.equal(tombstones.find((article) => article.id === created.id)?.commentCount, 1);
      // One author's recycle bin is not another author's.
      assert.equal((await runtime.store.listMyDeletedArticles({ actorId: `other-${suffix}`, locale: "zh-CN" })).filter((article) => article.id === created.id).length, 0);

      // Restoring is owner-scoped, and an unknown id is the same 404 as a live work.
      await assert.rejects(Promise.resolve().then(() => runtime.store.restoreArticle({
        articleId: created.id, actorId: `not-author-${suffix}`,
      })), ArticleAuthorizationError);
      await assert.rejects(Promise.resolve().then(() => runtime.store.restoreArticle({
        articleId: randomUUID(), actorId: authorId,
      })), ArticleNotFoundError);

      const restored = await runtime.store.restoreArticle({ articleId: created.id, actorId: authorId, locale: "zh-CN" });
      assert.equal(restored.id, created.id);
      // A restored work is a draft: deleting withdrew it, and putting a public
      // address back is the author's decision to make again, not a side effect
      // of undoing a mistake.
      assert.equal(restored.status, "draft");
      assert.equal(restored.slug, slug, "the address the tombstone released comes back with it");
      assert.ok((await runtime.store.listMyArticles({ actorId: authorId, locale: "zh-CN" })).some((article) => article.id === created.id));
      assert.equal((await runtime.store.listMyDeletedArticles({ actorId: authorId, locale: "zh-CN" })).filter((article) => article.id === created.id).length, 0);
      assert.equal((await runtime.store.listPublishedArticles({ locale: "zh-CN", query: "Soon restored" })).length, 0, "restoring must not republish");
      // A second restore is a 404, exactly like a second delete.
      await assert.rejects(Promise.resolve().then(() => runtime.store.restoreArticle({
        articleId: created.id, actorId: authorId,
      })), ArticleNotFoundError);

      // The sweep is bounded by the window, not by how long ago the row was
      // written: inside it the work is still recoverable, past it, it is gone.
      const swept = await runtime.store.createArticle({ authorId, slug: `${slug}-swept`, title: "Soon swept", locale: "zh-CN", contentBlocks });
      await runtime.store.deleteArticle({ articleId: swept.id, actorId: authorId });
      assert.equal((await runtime.store.listMyDeletedArticles({ actorId: authorId, locale: "zh-CN" })).find((article) => article.id === swept.id)?.commentCount, 0);
      const kept = await runtime.store.createArticle({ authorId, slug: `${slug}-kept`, title: "Not yet swept", locale: "zh-CN", contentBlocks });
      await runtime.store.deleteArticle({ articleId: kept.id, actorId: authorId });
      const deletedAt = new Date();
      assert.equal((await runtime.store.purgeExpiredArticles({ retentionDays: 30, now: deletedAt })).purged, 0);
      const past = await runtime.store.purgeExpiredArticles({ retentionDays: 30, now: new Date(deletedAt.getTime() + 31 * 86_400_000), limit: 10 });
      assert.equal(past.purged, 2, "both tombstones are past the window");
      assert.equal((await runtime.store.listMyDeletedArticles({ actorId: authorId, locale: "zh-CN" })).length, 0);
      // Purged means gone, not hidden: there is nothing left to restore.
      await assert.rejects(Promise.resolve().then(() => runtime.store.restoreArticle({
        articleId: swept.id, actorId: authorId,
      })), ArticleNotFoundError);
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  /**
   * #241: delete/restore must be a cycle, not a ratchet.
   *
   * Two invariants were broken by appending `-deleted-<id8>` to whatever the row
   * already held. The suffix stacked — 17 characters per delete, forever — and a
   * long address went over the 160-character stored contract, so a restored
   * draft could be deleted but never saved again: `validateArticleSlug` refuses
   * the very slug the store had just written.
   */
  test(`${adapterName}: repeated delete and restore keeps the tombstone slug storable`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const authorId = `slug-cycle-${suffix}`;
    // A legal address at the edge of the contract: 150 characters, so any suffix
    // takes it over 160 unless the base makes room.
    const longSlug = `cycle-${"a".repeat(150 - "cycle-".length)}`;
    assert.equal(longSlug.length, 150);
    const contentBlocks = [{ id: "p1", type: "paragraph", text: "Long addressed work." }];
    try {
      const created = await runtime.store.createArticle({
        authorId, slug: longSlug, title: "Long address", summary: "", locale: "zh-CN", contentBlocks, publish: true,
      });

      // First delete: the released address must already fit the contract.
      const deleted = await runtime.store.deleteArticle({ articleId: created.id, actorId: authorId });
      assert.equal(deleted.id, created.id);
      const tombstone = (await runtime.store.listMyDeletedArticles({ actorId: authorId, locale: "zh-CN" }))
        .find((article) => article.id === created.id);
      assert.ok(tombstone, "the tombstone exists");
      assert.ok(tombstone.slug.length <= 160, `a tombstone slug must fit the contract, got ${tombstone.slug.length}`);
      assert.match(tombstone.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      assert.equal(tombstone.slug.endsWith(`-deleted-${created.id.slice(0, 8)}`), true);

      // Somebody else takes the address the tombstone released.
      const squatter = await runtime.store.createArticle({
        authorId: `squatter-${suffix}`, slug: longSlug, title: "Same address", summary: "",
        locale: "zh-CN", contentBlocks, publish: false,
      });

      // Restoring must succeed, and must not stack. For an address this long the
      // released slug was truncated to make room for its suffix, so the address
      // the restore can reclaim is that truncated one — shorter than the original,
      // still legal, and never a failure over an address the author cannot see.
      const restored = await runtime.store.restoreArticle({ articleId: created.id, actorId: authorId, locale: "zh-CN" });
      assert.ok(restored.slug.length <= 160, `restored slug must fit the contract, got ${restored.slug.length}`);
      assert.match(restored.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      assert.notEqual(restored.slug, longSlug, "the squatter holds the original address");
      assert.equal(longSlug.startsWith(restored.slug), true, "and what comes back is that address, truncated to fit");

      // The draft has to be editable again: this is the failure the issue
      // reported — a slug the store wrote but the contract refuses.
      const saved = await runtime.store.updateArticle({
        articleId: created.id, actorId: authorId, slug: restored.slug,
        title: "Long address, edited after restore", summary: "", locale: "zh-CN",
        contentBlocks, publish: false,
      });
      assert.equal(saved.id, created.id);

      // And delete twice more: the suffix must not accumulate.
      for (let cycle = 0; cycle < 2; cycle += 1) {
        await runtime.store.deleteArticle({ articleId: created.id, actorId: authorId });
        const current = (await runtime.store.listMyDeletedArticles({ actorId: authorId, locale: "zh-CN" }))
          .find((article) => article.id === created.id);
        assert.ok(current);
        assert.ok(current.slug.length <= 160, `cycle ${cycle + 2}: ${current.slug.length} characters`);
        assert.equal(
          current.slug.split("-deleted-").length - 1, 1,
          `cycle ${cycle + 2} must not stack suffixes: ${current.slug}`,
        );
        const back = await runtime.store.restoreArticle({ articleId: created.id, actorId: authorId, locale: "zh-CN" });
        assert.ok(back.slug.length <= 160);
        assert.equal(back.slug.includes("-deleted-"), false, "a restore reclaims an address; it does not keep the tombstone's");
      }

      // The squatter's address is never disturbed by any of this.
      const squatterNow = (await runtime.store.listMyArticles({ actorId: `squatter-${suffix}`, locale: "zh-CN" }))
        .find((article) => article.id === squatter.id);
      assert.equal(squatterNow?.slug, longSlug);
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  test(`${adapterName}: tombstone sweeps honor the strict cutoff, age order, and batch limit`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID(), authorId = `author-${suffix}`;
    const times = [
      "2000-01-01T00:00:00.000Z", "2000-01-01T12:00:00.000Z",
      "2000-01-02T00:00:00.000Z", "2000-01-02T00:00:00.001Z",
    ];
    const ids: string[] = [];
    try {
      for (const [index, deletedAt] of times.entries()) {
        const article = await runtime.store.createArticle({
          authorId, slug: `contract-restore-${suffix}-boundary-${index}`, title: `Boundary ${index}`,
          locale: "zh-CN", contentBlocks: [{ id: "p1", type: "paragraph", text: "Boundary test." }],
        });
        ids.push(article.id);
        await runtime.store.deleteArticle({ articleId: article.id, actorId: authorId });
        await runtime.setArticleDeletedAt(article.id, deletedAt);
      }
      const remaining = async () => new Set((await runtime.store.listMyDeletedArticles({ actorId: authorId })).map((article) => article.id));
      const input = { retentionDays: 30, now: "2000-02-01T00:00:00.000Z", limit: 1 };
      assert.equal((await runtime.store.purgeExpiredArticles(input)).purged, 1);
      assert.deepEqual(await remaining(), new Set(ids.slice(1)), "the oldest eligible tombstone is removed first");
      assert.equal((await runtime.store.purgeExpiredArticles(input)).purged, 1);
      assert.deepEqual(await remaining(), new Set(ids.slice(2)), "limit bounds each sweep");
      assert.equal((await runtime.store.purgeExpiredArticles(input)).purged, 0, "exactly at the cutoff is not older than the window");
      assert.equal((await runtime.store.purgeExpiredArticles({ ...input, now: "2000-02-01T00:00:00.001Z" })).purged, 1);
      assert.deepEqual(await remaining(), new Set([ids[3]]));
      assert.equal((await runtime.store.purgeExpiredArticles({ ...input, now: "2000-02-01T00:00:00.002Z" })).purged, 1);
      assert.equal((await remaining()).size, 0);
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  test(`${adapterName}: a work's commenters are listed once each, in the order they first wrote`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const slug = `contract-commenters-${suffix}`;
    const articleId = `commenter-article-${suffix}`;
    try {
      const article = await runtime.store.createArticle({
        authorId: `article-author-${suffix}`, slug, title: "Commenters contract article", summary: "",
        locale: "zh-CN", contentBlocks: [{ id: "p1", type: "paragraph", text: "Shared contract content." }], publish: true,
      });
      // One reader who wrote twice is still one reader with one inbox.
      await runtime.store.createArticleComment({ slug, locale: "zh-CN", actorId: `commenter-a-${suffix}`, content: "First." });
      await runtime.store.createArticleComment({ slug, locale: "zh-CN", actorId: `commenter-b-${suffix}`, content: "Second." });
      await runtime.store.createArticleComment({ slug, locale: "zh-CN", actorId: `commenter-a-${suffix}`, content: "Again." });

      assert.deepEqual(
        await runtime.store.listArticleCommentAuthorIds({ articleId: article.id }),
        [`commenter-a-${suffix}`, `commenter-b-${suffix}`],
      );
      // Bounded, because the list is read inside the request that deletes the
      // work: a work with ten thousand commenters is not a reason to hold it open.
      assert.deepEqual(await runtime.store.listArticleCommentAuthorIds({ articleId: article.id, limit: 1 }), [`commenter-a-${suffix}`]);
      assert.deepEqual(await runtime.store.listArticleCommentAuthorIds({ articleId: randomUUID() }), []);
      await assert.rejects(
        Promise.resolve().then(() => runtime.store.listArticleCommentAuthorIds({ articleId: "not-a-uuid" })),
        { code: "BAD_USER_INPUT" },
      );
      await assert.rejects(
        Promise.resolve().then(() => runtime.store.listArticleCommentAuthorIds({ articleId, limit: 0 })),
        { code: "BAD_USER_INPUT" },
      );
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  test(`${adapterName}: published articles are discoverable through their assigned taxonomy`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const slug = `contract-published-${suffix}`;
    try {
      const taxonomy = await runtime.store.createTaxonomy({
        actorId: `taxonomy-owner-${suffix}`, actorIsEditor: true, kind: "category", slug: `contract-category-${suffix}`,
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
          actorId: `taxonomy-owner-${suffix}`, actorIsEditor: true, kind: "category",
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

  test(`${adapterName}: categories are editor-controlled while hashtags stay open`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const editorId = `taxonomy-editor-${suffix}`;
    const memberId = `taxonomy-member-${suffix}`;
    const categorySlug = `editor-category-${suffix}`;
    try {
      // ADR 0016, decision 1. A hashtag is the author's own words: no role asked.
      const tag = await runtime.store.createTaxonomy({
        actorId: memberId, kind: "tag", slug: `open-tag-${suffix}`, name: "Open tag", locale: "zh-CN",
      });
      assert.equal(tag.kind, "tag");

      // A category is the platform speaking: the same account may not mint one
      // without the role, and a caller that never asks gets no benefit of the
      // doubt (`actorIsEditor` defaults to false).
      await assert.rejects(Promise.resolve().then(() => runtime.store.createTaxonomy({
        actorId: memberId, kind: "category", slug: `member-category-${suffix}`, name: "Member category", locale: "zh-CN",
      })), ArticleAuthorizationError);
      await assert.rejects(Promise.resolve().then(() => runtime.store.createTaxonomy({
        actorId: memberId, actorIsEditor: false, kind: "category", slug: `member-category-${suffix}`, name: "Member category", locale: "zh-CN",
      })), ArticleAuthorizationError);

      const category = await runtime.store.createTaxonomy({
        actorId: editorId, actorIsEditor: true, kind: "category", slug: categorySlug, name: "Editor category", locale: "zh-CN",
      });
      // The public taxonomy is maintained by the editors as a group: another
      // editor may add a translation to a category they did not create.
      const translated = await runtime.store.createTaxonomy({
        actorId: memberId, actorIsEditor: true, kind: "category", slug: categorySlug, name: "编辑分类", locale: "zh-TW",
      });
      assert.equal(translated.id, category.id);

      // Deleting draws the same line: a category needs the role even from the
      // account that created it, while a tag stays its creator's to retract.
      await assert.rejects(Promise.resolve().then(() => runtime.store.deleteTaxonomy({
        taxonomyId: category.id, actorId: editorId,
      })), ArticleAuthorizationError);
      await assert.rejects(Promise.resolve().then(() => runtime.store.deleteTaxonomy({
        taxonomyId: tag.id, actorId: editorId, actorIsEditor: true,
      })), ArticleAuthorizationError);
      assert.equal(await runtime.store.deleteTaxonomy({ taxonomyId: tag.id, actorId: memberId }), true);
      assert.equal(await runtime.store.deleteTaxonomy({ taxonomyId: category.id, actorId: memberId, actorIsEditor: true }), true);
    } finally {
      await runtime.cleanup(undefined, suffix);
    }
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
      const rootInput = {
        slug, locale: "zh-CN", actorId: commenterA, content: "Root comment",
        idempotencyKey: `root-comment-once-${suffix}`,
      };
      const [root, rootRetry] = await Promise.all([
        runtime.store.createArticleComment(rootInput),
        runtime.store.createArticleComment(rootInput),
      ]);
      assert.equal(rootRetry.id, root.id, "concurrent retries must return the original comment");
      await assert.rejects(
        Promise.resolve().then(() => runtime.store.createArticleComment({ ...rootInput, content: "different comment" })),
        IdempotencyConflictError,
      );
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
  /**
   * A thread has a bottom (#246).
   *
   * The write path used to accept any reply and the read path stopped at a fixed
   * level, so a deep reply was created successfully and then never came back:
   * the writer saw 201, refreshed, and found nothing. The cap is therefore
   * enforced where the comment is written, and the assertion that matters is not
   * "depth 9 is refused" but "everything that was accepted comes back".
   */
  test(`${adapterName}: a comment thread stops at the depth the reader can see`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const slug = `contract-comment-depth-${suffix}`;
    const articleAuthor = `depth-author-${suffix}`;
    const commenter = `depth-commenter-${suffix}`;
    // The cap is a published contract, so the test reads it rather than repeating
    // a number that could drift away from the message the writer is shown.
    const deepestAllowed = MAX_COMMENT_REPLY_DEPTH;
    try {
      await runtime.store.createArticle({
        authorId: articleAuthor, slug, title: "Depth contract article", summary: "",
        locale: "zh-CN", contentBlocks: [{ id: "p1", type: "paragraph", text: "Depth contract content." }], publish: true,
      });
      const chain = [];
      let parentCommentId = null;
      for (let depth = 0; depth <= deepestAllowed; depth += 1) {
        const comment = await runtime.store.createArticleComment({
          slug, locale: "zh-CN", actorId: commenter, content: `Depth ${depth}`, parentCommentId,
        });
        chain.push(comment.id);
        parentCommentId = comment.id;
      }

      // One level deeper is refused, with a message that says what to do.
      await assert.rejects(
        Promise.resolve().then(() => runtime.store.createArticleComment({
          slug, locale: "zh-CN", actorId: commenter, content: "Too Deep", parentCommentId,
        })),
        (error) => error instanceof CommentDepthError
          && error.code === "COMMENT_DEPTH_EXCEEDED"
          && error.message === COMMENT_DEPTH_LIMIT_MESSAGE,
      );

      // Everything the store accepted is returned, one node per level, in order.
      const flattened = [];
      const walk = (nodes) => { for (const node of nodes) { flattened.push(node.id); walk(node.replies); } };
      walk(await runtime.store.listArticleComments({ slug, locale: "zh-CN" }));
      assert.deepEqual(flattened, chain, "a comment that was accepted must never be truncated away");
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  /**
   * The thread's first page used to be the only page (#248 follow-up).
   *
   * `GET /articles/:slug/comments` counts `limit` in top-level comments and the
   * route had no other parameter, so on a work with more roots than that the rest
   * existed in the database and nowhere a reader could reach. The cursor is the
   * last root of the page; what has to hold is that every root appears exactly
   * once across pages, in the same oldest-first order one big page would use,
   * that replies travel with their root, and that the boundary millisecond loses
   * nothing — which is only true because comment times are stored at the
   * precision the cursor can name (migration 0031).
   */
  test(`${adapterName}: a comment thread pages by root and loses nothing at a boundary`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const slug = `contract-comment-pages-${suffix}`;
    const otherSlug = `contract-comment-pages-other-${suffix}`;
    const authorId = `paging-author-${suffix}`;
    const commenter = `paging-commenter-${suffix}`;
    // Two roots share this millisecond; that is what the `id` half is for.
    const shared = "2026-06-01T00:00:00.123Z";
    try {
      for (const target of [slug, otherSlug]) {
        await runtime.store.createArticle({
          authorId, slug: target, title: "Paging contract article", summary: "",
          locale: "zh-CN", contentBlocks: [{ id: "p1", type: "paragraph", text: "Paging contract content." }], publish: true,
        });
      }
      const create = (target, content, parentCommentId = null) =>
        runtime.store.createArticleComment({ slug: target, locale: "zh-CN", actorId: commenter, content, parentCommentId });

      const roots = [];
      for (const [content, at] of [
        ["root-1", "2026-06-01T00:00:00.121Z"],
        ["root-2", shared],
        ["root-3", shared],
        ["root-4", "2026-06-01T00:00:00.124Z"],
        ["root-5", "2026-06-01T00:00:00.125Z"],
      ]) {
        const root = await create(slug, content);
        await runtime.setArticleCommentCreatedAt(root.id, at);
        roots.push({ id: root.id, at });
      }
      const otherRoot = await create(otherSlug, "other-work's-comment");
      await runtime.setArticleCommentCreatedAt(otherRoot.id, "2026-06-01T00:00:00.122Z");
      const reply = await create(slug, "reply-to-root-2", roots[1].id);
      await runtime.setArticleCommentCreatedAt(reply.id, "2026-06-01T00:00:00.130Z");
      const nested = await create(slug, "reply-to-reply", reply.id);
      await runtime.setArticleCommentCreatedAt(nested.id, "2026-06-01T00:00:00.131Z");

      // The order one unbounded page would return: oldest first, id breaking the
      // tie inside a millisecond.
      const expected = [...roots]
        .sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? -1 : 1))
        .map((root) => root.id);

      const walk = async (limit) => {
        const seen = [];
        const pages = [];
        let cursor = null;
        for (let guard = 0; guard < 20; guard += 1) {
          const page = await runtime.store.listArticleComments({
            slug, locale: "zh-CN", limit, ...(cursor === null ? {} : { cursor }),
          });
          if (page.length === 0) { pages.push(0); break; }
          pages.push(page.length);
          seen.push(...page.map((node) => node.id));
          const last = page[page.length - 1];
          cursor = { at: last.createdAt, id: last.id };
        }
        return { seen, pages };
      };

      const twoAtATime = await walk(2);
      assert.deepEqual(twoAtATime.seen, expected, "every root appears once, in thread order, across pages of two");
      assert.deepEqual(twoAtATime.pages, [2, 2, 1, 0], "a short page still reports what it holds, and the end is empty");
      // The boundary falls inside the shared millisecond, which is exactly the
      // case a millisecond-truncating read gets wrong.
      assert.ok(twoAtATime.pages.length >= 3);

      const oneAtATime = await walk(1);
      assert.deepEqual(oneAtATime.seen, expected, "page size is a client choice, not a contract change");

      // A reply is never a page of its own: it arrives with the root it answers,
      // all the way down, and the page still counts one root.
      const secondPage = await runtime.store.listArticleComments({
        slug, locale: "zh-CN", limit: 2, cursor: { at: roots[0].at, id: roots[0].id },
      });
      const rootWithReplies = secondPage.find((node) => node.replies.length > 0);
      assert.ok(rootWithReplies, "the reply's root is on the page the reply belongs to");
      assert.equal(rootWithReplies.id, roots[1].id);
      assert.equal(rootWithReplies.replies.length, 1);
      assert.equal(rootWithReplies.replies[0].id, reply.id);
      assert.deepEqual(rootWithReplies.replies[0].replies.map((node) => node.id), [nested.id]);

      // Another work's comment is not on this thread, whatever its timestamp.
      assert.ok(!twoAtATime.seen.includes(otherRoot.id), "a page belongs to one work");

      // Reading past the end is empty, not an error, and not a repeat.
      const lastRoot = expected[expected.length - 1];
      const past = await runtime.store.listArticleComments({
        slug, locale: "zh-CN", limit: 2,
        cursor: { at: roots.find((root) => root.id === lastRoot).at, id: lastRoot },
      });
      assert.deepEqual(past, []);

      // A cursor is two strings; anything else is the caller's bug, and it is
      // refused here rather than surfacing as a database error.
      for (const bad of [{ at: 1, id: lastRoot }, { at: shared, id: 2 }]) {
        await assert.rejects(
          Promise.resolve().then(() => runtime.store.listArticleComments({
            slug, locale: "zh-CN", limit: 2, cursor: bad,
          })),
          { code: "BAD_USER_INPUT" },
        );
      }
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  /**
   * The media library's persistence (ADR 0022).
   *
   * The assertions that matter are the ones the application layer depends on:
   * the list is one owner's, newest first, and walks with a cursor; a delete is
   * scoped to its owner so "not yours" and "not there" are the same answer; and
   * the reference scan hands back raw JSON text on both providers, which is the
   * only reason the application layer can parse it with one code path.
   */
  /**
   * The media library's persistence (ADR 0022, hardened after the orphan scan
   * offered live cover images and avatars as deletable).
   *
   * The assertions that matter are the ones the application layer depends on:
   * the list is one owner's, newest first, and walks with a cursor; **a delete is
   * guarded by the scan inside the provider**, so a work saved between two
   * statements cannot lose its images; the scan sees **both** spellings of a
   * media address and **both** places one can live — a work's body and a
   * member's avatar — because missing either one marked a live image as an
   * orphan; and a delete is scoped to its owner so "not yours" and "not there"
   * are the same answer.
   */
  test(`${adapterName}: the media library lists one owner's assets and deletes only theirs`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID().slice(0, 8);
    const ownerId = `media-owner-${suffix}`;
    const strangerId = `media-stranger-${suffix}`;
    const hour = new Date(Date.now() + 3_600_000).toISOString();
    /**
     * The refresh hash is unique across the whole table, not just this account,
     * so it has to carry the run's suffix. A fixed hash ("a".repeat(64)) looks
     * tidier and fails somewhere else entirely: the PostgreSQL fixture shares
     * one database across every test in this file, so the collision surfaces in
     * whichever test runs second — here that was the identity contract.
     */
    const hash = (seed) => (seed + suffix.replace(/-/g, "")).padEnd(64, seed);
    const account = (userId, seed) => ({
      userId,
      email: `media-${userId}@example.test`,
      passwordHash: "hash-before",
      session: {
        sessionId: randomUUID(), userId, accessTokenId: randomUUID(),
        refreshHash: hash(seed), expiresAt: hour,
        accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    });
    await runtime.store.createIdentityAccount(account(ownerId, "a"));
    await runtime.store.createIdentityAccount(account(strangerId, "b"));

    const asset = (index) => ({
      id: `0000000${index}-1111-4111-8111-${suffix.replace(/-/g, "0").padStart(12, "0")}`,
      ownerId,
      storageKey: `assets/${ownerId}/${index}.webp`,
      contentType: "image/webp",
      byteSize: 2048,
      width: 20,
      height: 10,
      sha256: "c".repeat(64),
    });
    const strangerAssetId = `00000009-1111-4111-8111-${suffix.replace(/-/g, "0").padStart(12, "0")}`;
    // The adapter is handed the decoded cursor: decoding is the application
    // layer's job, and the predicate below is the adapter's.
    const cursorFor = (row) => ({ at: new Date(row.createdAt).toISOString(), id: row.id });
    try {
      for (const index of [1, 2, 3]) await runtime.store.createMediaAsset(asset(index));
      await runtime.store.createMediaAsset({ ...asset(9), id: strangerAssetId, ownerId: strangerId, storageKey: `assets/${strangerId}/9.webp` });

      // `limit + 1`: the adapter reads one row past the page so the application
      // layer can tell "exactly a page" from "the end" without a second query.
      const first = await runtime.store.listMediaAssets({ ownerId, cursor: null, limit: 1 });
      assert.equal(first.length, 2, "a page of one, plus the row that proves there is another");
      assert.ok(first.every((row) => row.ownerId === ownerId), "the stranger's asset is never in this list");

      const second = await runtime.store.listMediaAssets({ ownerId, cursor: cursorFor(first[0]), limit: 1 });
      assert.equal(second.length, 2, "the second page still has one row behind it");
      assert.notEqual(second[0].id, first[0].id, "no row is repeated across pages");

      const third = await runtime.store.listMediaAssets({ ownerId, cursor: cursorFor(second[0]), limit: 1 });
      assert.equal(third.length, 1, "the last page has no row behind it");
      assert.notEqual(third[0].id, first[0].id);
      assert.notEqual(third[0].id, second[0].id);

      const fourth = await runtime.store.listMediaAssets({ ownerId, cursor: cursorFor(third[0]), limit: 1 });
      assert.deepEqual(fourth, [], "an empty page is the end of the list");

      // Deleting is scoped by owner: another account asking for this asset gets
      // the same `null` they would get for one that does not exist.
      assert.equal(await runtime.store.deleteUnusedMediaAsset({ id: first[0].id, ownerId: strangerId }), null);
      const gone = await runtime.store.deleteUnusedMediaAsset({ id: first[0].id, ownerId });
      assert.ok(gone?.deleted, "the owner's unused asset is deleted");
      assert.deepEqual(gone.usedBy, []);
      const remaining = await runtime.store.listMediaAssets({ ownerId, cursor: null, limit: 10 });
      assert.equal(remaining.some((row) => row.id === first[0].id), false);
      assert.equal(await runtime.store.deleteUnusedMediaAsset({ id: first[0].id, ownerId }), null, "already gone");
    } finally {
      for (const index of [1, 2, 3]) await runtime.store.deleteUnusedMediaAsset({ id: asset(index).id, ownerId });
      await runtime.store.deleteUnusedMediaAsset({ id: strangerAssetId, ownerId: strangerId });
    }
  });

  /**
   * The guarded delete: the scan and the delete are one operation.
   *
   * This is the whole fix for the race. Two statements in the application layer
   * leave a gap a concurrent save fits through — the scan sees nothing, a work is
   * saved with the image in it, the delete removes the row, and the work that
   * was just saved has lost its picture. Here the provider has to answer "in
   * use" and delete nothing, in that order, without the caller's help.
   */
  test(`${adapterName}: a media delete is refused, inside one operation, when a body or an avatar uses the asset`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID().slice(0, 8);
    const ownerId = `media-guard-${suffix}`;
    const authorId = `media-guard-author-${suffix}`;
    const usedId = `0000000a-1111-4111-8111-${suffix.replace(/-/g, "0").padStart(12, "0")}`;
    const avatarId = `0000000b-1111-4111-8111-${suffix.replace(/-/g, "0").padStart(12, "0")}`;
    const freeId = `0000000c-1111-4111-8111-${suffix.replace(/-/g, "0").padStart(12, "0")}`;
    const asset = (id) => ({
      id, ownerId, storageKey: `assets/${ownerId}/${id}.webp`, contentType: "image/webp",
      byteSize: 2048, width: 20, height: 10, sha256: "d".repeat(64),
    });
    // An asset and a profile are both foreign keys to the account, so both the
    // owner and the author have to exist: an avatar is somebody's picture before
    // it is a media reference.
    const hour = new Date(Date.now() + 3_600_000).toISOString();
    const account = (userId, seed) => ({
      userId,
      email: `media-${userId}@example.test`,
      passwordHash: "hash-before",
      session: {
        sessionId: randomUUID(), userId, accessTokenId: randomUUID(),
        refreshHash: (seed + suffix.replace(/-/g, "")).padEnd(64, seed), expiresAt: hour,
        accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    });
    try {
      await runtime.store.createIdentityAccount(account(ownerId, "7"));
      await runtime.store.createIdentityAccount(account(authorId, "8"));
      for (const id of [usedId, avatarId, freeId]) await runtime.store.createMediaAsset(asset(id));

      // The two addresses a body can hold: the Web app's `/api/media/…` and the
      // API's own `/api/v1/media/…`, which is what a direct client stored.
      const created = await runtime.store.createArticle({
        authorId,
        slug: `media-guard-${suffix}`,
        title: "封面与头像",
        summary: "",
        locale: "zh-CN",
        contentBlocks: [
          { id: "block-1", type: "image", src: `/api/v1/media/${usedId}`, alt: "" },
          { id: "block-2", type: "paragraph", text: "正文里有两张图。" },
        ],
        publish: false,
      });
      // An avatar: a media URL that lives on a profile, in no body at all.
      await runtime.store.upsertAuthorProfile({ userId: authorId, locale: "zh-CN", displayName: "头像作者", bio: "", avatarUrl: `/api/v1/media/${avatarId}` });

      const scan = await runtime.store.listMediaScanRows();
      assert.ok(scan.some((row) => row.kind === "work"), "bodies are scanned");
      assert.ok(scan.some((row) => row.kind === "avatar"), "and so are avatars");

      const used = await runtime.store.deleteUnusedMediaAsset({ id: usedId, ownerId });
      assert.equal(used?.deleted, null, "a body that uses the image blocks the delete");
      assert.equal(used?.usedBy.length, 1);
      assert.equal(used?.usedBy[0]?.kind, "work");
      assert.equal(used?.usedBy[0]?.work?.articleId, created.id);
      assert.equal(typeof used?.usedBy[0]?.work?.authorId, "string", "who wrote it is part of what the scan knows");

      const avatar = await runtime.store.deleteUnusedMediaAsset({ id: avatarId, ownerId });
      assert.equal(avatar?.deleted, null, "a profile picture blocks the delete too");
      assert.ok(avatar?.usedBy.some((row) => row.kind === "avatar"));

      const free = await runtime.store.deleteUnusedMediaAsset({ id: freeId, ownerId });
      assert.ok(free?.deleted, "an asset nothing uses is deleted");
    } finally {
      await runtime.store.deleteUnusedMediaAsset({ id: usedId, ownerId });
      await runtime.store.deleteUnusedMediaAsset({ id: avatarId, ownerId });
      await runtime.store.deleteUnusedMediaAsset({ id: freeId, ownerId });
      const scan = await runtime.store.listMediaScanRows();
      for (const row of scan) {
        if (row.kind === "work" && row.work?.slug === `media-guard-${suffix}`) {
          await runtime.store.deleteArticle({ articleId: row.work.articleId, actorId: authorId });
        }
      }
    }
  });

  /**
   * #217, from the other side: a reference row can be *missing*.
   *
   * `ON DELETE RESTRICT` only refuses a delete it can see a row for. A provider
   * replay that predates reference capture, an older writer or a direct SQL fix
   * can leave the body holding the URL while the row is gone — and the guard then
   * answered "unused" and deleted an image a published work still shows. The
   * materialised table is the fast path; the body is the evidence.
   */
  test(`${adapterName}: a missing materialised reference cannot authorise a delete`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const ownerId = `drift-owner-${suffix}`;
    const hour = new Date(Date.now() + 3_600_000).toISOString();
    try {
      await runtime.store.createIdentityAccount({
        userId: ownerId, email: `drift-${suffix}@example.test`, passwordHash: "hash",
        session: {
          sessionId: randomUUID(), userId: ownerId, accessTokenId: randomUUID(),
          refreshHash: (suffix.replace(/-/g, "") + "f").padEnd(64, "f"), expiresAt: hour,
          accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
      });
      const asset = await runtime.store.createMediaAsset({
        id: randomUUID(), ownerId, storageKey: `${suffix}/drift.webp`, contentType: "image/webp",
        byteSize: 12, width: 2, height: 2, sha256: "f".repeat(64),
      });
      const article = await runtime.store.createArticle({
        authorId: ownerId, slug: `drift-${suffix}`, title: "仍然在用", summary: "",
        locale: "zh-CN", publish: true,
        contentBlocks: [{ id: "i1", type: "image", src: `/api/v1/media/${asset.id}`, alt: "" }],
      });

      // The write materialised the reference, so the fast path knows the work.
      assert.equal((await runtime.store.listReferencesForAssets({ assetIds: [asset.id] })).length, 1);

      // Now the drift: the row goes, the body stays.
      await runtime.dropMediaReference(asset.id);
      assert.deepEqual(
        await runtime.store.listReferencesForAssets({ assetIds: [asset.id] }),
        [],
        "the materialised table no longer knows about the work",
      );

      const refused = await runtime.store.deleteUnusedMediaAsset({ id: asset.id, ownerId });
      assert.equal(refused?.deleted ?? null, null, "the body is still evidence that the image is in use");
      assert.ok(
        (refused?.usedBy ?? []).some((row) => row.kind === "work" && row.work?.articleId === article.id),
        "and the caller is told which work holds it",
      );
      const evidence = [...new Set((refused?.usedBy ?? []).map((row) => row.content))];
      assert.equal(evidence.length, 1, "one work holds the asset");
      assert.match(
        String(evidence[0]),
        new RegExp(`/media/${asset.id}\"`),
        "the evidence is the work's own body, and it really does name this asset as a URL",
      );
      assert.ok(await runtime.store.getMediaAsset({ id: asset.id }), "the asset row survives");

      // A tombstone keeps its translation, so the evidence has to go with a purge.
      await runtime.store.deleteArticle({ articleId: article.id, actorId: ownerId });
      await runtime.store.purgeExpiredArticles({
        retentionDays: 30, now: new Date(Date.now() + 400 * 86_400_000), limit: 100,
      });
      const allowed = await runtime.store.deleteUnusedMediaAsset({ id: asset.id, ownerId });
      assert.equal(allowed?.deleted?.id, asset.id, "once nothing mentions it, the delete goes through");
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  /**
   * #243: mentioning an id is not referencing an asset.
   *
   * The delete-time backstop asked SQL whether the id appears anywhere in the
   * body and then handed the caller a fabricated `content` — `/media/<id>` — so
   * its own extraction step agreed with the answer it had already decided. A
   * technical article quoting a UUID in prose therefore pinned the image forever,
   * while the library page, which extracts from the real body, showed it as
   * orphaned. The badge and the refusal have to be the same rule.
   */
  test(`${adapterName}: a body that only mentions an asset id does not block the delete`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const ownerId = `mention-owner-${suffix}`;
    const hour = new Date(Date.now() + 3_600_000).toISOString();
    try {
      await runtime.store.createIdentityAccount({
        userId: ownerId, email: `mention-${suffix}@example.test`, passwordHash: "hash",
        session: {
          sessionId: randomUUID(), userId: ownerId, accessTokenId: randomUUID(),
          refreshHash: (suffix.replace(/-/g, "") + "b").padEnd(64, "b"), expiresAt: hour,
          accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
      });
      const asset = await runtime.store.createMediaAsset({
        id: randomUUID(), ownerId, storageKey: `${suffix}/mention.webp`, contentType: "image/webp",
        byteSize: 12, width: 2, height: 2, sha256: "b".repeat(64),
      });
      // A published article that quotes the UUID as text: no image block, no
      // reference row, no reference. This is the shape the issue reproduced with.
      await runtime.store.createArticle({
        authorId: ownerId, slug: `mention-${suffix}`, title: "调试日志", summary: "",
        locale: "zh-CN", publish: true,
        contentBlocks: [{ id: "p1", type: "paragraph", text: `调试记录 ID: ${asset.id}` }],
      });

      // The library's own answer, from the real body: unreferenced.
      const scan = await runtime.store.listMediaScanRows();
      const mentions = scan.filter((row) => row.kind === "work" && String(row.content).includes(asset.id));
      assert.equal(mentions.length, 1, "the prose really is in the scan's input");

      const allowed = await runtime.store.deleteUnusedMediaAsset({ id: asset.id, ownerId });
      assert.equal(allowed?.deleted?.id, asset.id, "a quoted id is not a reference");
      assert.deepEqual(allowed?.usedBy, []);
      assert.equal(await runtime.store.getMediaAsset({ id: asset.id }), null);
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  /**
   * The avatar half of the same drift: a picture stored only as a URL on the
   * profile, with no `avatar_media_id` to make the foreign key refuse.
   */
  test(`${adapterName}: an avatar URL with no materialised avatar id still blocks the delete`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const ownerId = `drift-avatar-owner-${suffix}`;
    const hour = new Date(Date.now() + 3_600_000).toISOString();
    try {
      await runtime.store.createIdentityAccount({
        userId: ownerId, email: `drift-avatar-${suffix}@example.test`, passwordHash: "hash",
        session: {
          sessionId: randomUUID(), userId: ownerId, accessTokenId: randomUUID(),
          refreshHash: (suffix.replace(/-/g, "") + "a").padEnd(64, "a"), expiresAt: hour,
          accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
      });
      const asset = await runtime.store.createMediaAsset({
        id: randomUUID(), ownerId, storageKey: `${suffix}/face.webp`, contentType: "image/webp",
        byteSize: 12, width: 2, height: 2, sha256: "a".repeat(64),
      });
      await runtime.store.upsertAuthorProfile({
        userId: ownerId, locale: "zh-CN", displayName: "有头像的人", bio: "",
        avatarUrl: `/api/v1/media/${asset.id}`,
      });
      await runtime.clearAvatarMediaId(ownerId);

      const refused = await runtime.store.deleteUnusedMediaAsset({ id: asset.id, ownerId });
      assert.equal(refused?.deleted ?? null, null, "the stored URL is evidence even without the id column");
      assert.ok((refused?.usedBy ?? []).some((row) => row.kind === "avatar"));
      assert.ok(await runtime.store.getMediaAsset({ id: asset.id }));
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  test(`${adapterName}: the media reference scan returns raw JSON text for every draft and tombstone`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const authorId = `media-scan-author-${suffix}`;
    const mediaId = "abcdef01-2345-4678-89ab-cdef01234567";
    const blocks = [{ id: "block-1", type: "image", src: `/api/media/${mediaId}`, alt: "" }];
    const created = await runtime.store.createArticle({
      authorId, slug: `media-scan-${suffix}`, title: "用了这张图", summary: "", locale: "zh-CN", contentBlocks: blocks, publish: false,
    });
    try {
      const rows = await runtime.store.listMediaScanRows();
      const found = rows.filter((row) => row.kind === "work" && String(row.content).includes(mediaId));
      assert.equal(found.length, 1, "the draft that uses the image is in the scan");
      assert.equal(typeof found[0].content, "string", "both providers hand the application layer JSON text");
      assert.equal(found[0].kind, "work");
      assert.equal(found[0].work?.status, "draft");
      assert.equal(found[0].work?.deletedAt, null);
      assert.equal(found[0].work?.locale, "zh-CN");
      assert.equal(found[0].work?.authorId, authorId);
    } finally {
      await runtime.store.deleteArticle({ articleId: created.id, actorId: authorId });
    }
  });

  test(`${adapterName}: recovery and verification tokens are single-use, purpose-scoped and expire`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const userId = `identity-user-${suffix}`;
    const email = `identity-${suffix}@example.test`;
        // Keyed digests, derived from this run's suffix: a fixed literal would
    // collide on its primary key the second time this suite runs against the
    // same database, failing a test that has nothing to do with reruns.
    const tokenHash = (label: string) => createHash("sha256").update(`${suffix}:${label}`).digest("hex");
const hour = new Date(Date.now() + 3_600_000).toISOString();
    const session = {
      sessionId: randomUUID(), userId, accessTokenId: randomUUID(),
      refreshHash: tokenHash("a"), expiresAt: hour,
      accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    assert.equal(await runtime.store.createIdentityAccount({ userId, email, passwordHash: "hash-before", session }), true);
    // A second device, so a revocation can be asked to spare one of two.
    const secondSession = {
      sessionId: randomUUID(), userId, accessTokenId: randomUUID(),
      refreshHash: tokenHash("0"), expiresAt: hour,
      accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    assert.equal(await runtime.store.createIdentitySession(secondSession, { email, passwordHash: "hash-before" }), true);

    const resetHash = tokenHash("b");
    await runtime.store.issueIdentityToken({ userId, purpose: "password_reset", email, tokenHash: resetHash, expiresAt: hour });
    assert.equal(await runtime.store.consumeIdentityToken({ tokenHash: resetHash, purpose: "email_verification" }), null,
      "a reset link must not be redeemable as a verification link");
    assert.deepEqual(await runtime.store.consumeIdentityToken({ tokenHash: resetHash, purpose: "password_reset" }), { userId, email });
    assert.equal(await runtime.store.consumeIdentityToken({ tokenHash: resetHash, purpose: "password_reset" }), null,
      "the link works exactly once");

    const expiredHash = tokenHash("c");
    await runtime.store.issueIdentityToken({ userId, purpose: "password_reset", email, tokenHash: expiredHash, expiresAt: new Date(Date.now() - 1000).toISOString() });
    assert.equal(await runtime.store.consumeIdentityToken({ tokenHash: expiredHash, purpose: "password_reset" }), null);

    // Issuing again supersedes the link that is already out: two live recovery
    // links is a support problem and doubles what a phished mailbox exposes.
    const superseded = tokenHash("d");
    const replacement = tokenHash("e");
    await runtime.store.issueIdentityToken({ userId, purpose: "email_verification", email, tokenHash: superseded, expiresAt: hour });
    await runtime.store.issueIdentityToken({ userId, purpose: "email_verification", email, tokenHash: replacement, expiresAt: hour });
    assert.equal(await runtime.store.consumeIdentityToken({ tokenHash: superseded, purpose: "email_verification" }), null);
    assert.ok(await runtime.store.consumeIdentityToken({ tokenHash: replacement, purpose: "email_verification" }));

    // The credential and the sign-out are one operation, so there is no
    // observable moment with the new credential and the old sessions alive.
    const changed = await runtime.store.replaceIdentityPassword({
      userId, passwordHash: "hash-after", exceptSessionId: session.sessionId,
    });
    assert.equal(changed.updated, true);
    // A password *change* is made from inside a session and spares it: two
    // live sessions, one named, so exactly the other one ends.
    assert.equal(changed.revokedSessions, 1, "the session that made the change keeps its own");
    assert.equal((await runtime.store.findIdentityAccount({ email })).passwordHash, "hash-after");

    const rotated = await runtime.store.rotateIdentityRefresh({
      refreshHash: tokenHash("a"), nextRefreshHash: tokenHash("f"),
      accessTokenId: randomUUID(), issuedAt: new Date().toISOString(),
      accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    assert.equal(rotated.status, "rotated", "the spared device keeps its refresh family");
    // The second device was live too — it was signed out, not already dead.
    const signedOut = await runtime.store.rotateIdentityRefresh({
      refreshHash: tokenHash("0"), nextRefreshHash: tokenHash("1"),
      accessTokenId: randomUUID(), issuedAt: new Date().toISOString(),
      accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    assert.equal(signedOut.status, "invalid", "every other device is signed out");

    // A reset has no device that proved anything, so it spares nothing.
    const reset = await runtime.store.replaceIdentityPassword({ userId, passwordHash: "hash-final", exceptSessionId: null });
    assert.equal(reset.updated, true);
    assert.equal(reset.revokedSessions, 1, "a reset ends the session the owner was using too");
    assert.equal(await runtime.store.replaceIdentityPassword({ userId, passwordHash: "hash-final-2", exceptSessionId: null }).then((r) => r.revokedSessions), 0,
      "a second sweep finds nothing left to revoke");
    const afterRevocation = await runtime.store.rotateIdentityRefresh({
      refreshHash: tokenHash("f"), nextRefreshHash: tokenHash("2"),
      accessTokenId: randomUUID(), issuedAt: new Date().toISOString(),
      accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    assert.equal(afterRevocation.status, "invalid", "a revoked session must not rotate");

    await runtime.store.markIdentityEmailVerified({ userId, verifiedAt: new Date().toISOString() });
    const account = await runtime.store.findIdentityAccountByUserId({ userId });
    assert.equal(account.email, email);
    assert.ok(account.emailVerifiedAt, "verification is stamped on the account");
    assert.equal(await runtime.store.findIdentityAccountByUserId({ userId: `nobody-${suffix}` }), null);
    // The credential has an accessor of its own, so the account record a
    // caller may forward to a response never carries the hash with it.
    assert.deepEqual(await runtime.store.findIdentityCredentials({ userId }), { userId, passwordHash: "hash-final-2" });
    assert.equal(await runtime.store.findIdentityCredentials({ userId: `nobody-${suffix}` }), null);

    /**
     * Moving an account to another address.
     *
     * Two properties, and the second is the one that has to be settled by the
     * database: the proof on file was for the *old* address, so it goes; and one
     * address cannot end up on two accounts, however close together two callers
     * ask for it.
     */
    const movedEmail = `identity-moved-${suffix}@example.test`;
    assert.equal(await runtime.store.setIdentityEmail({ userId, email: movedEmail }), true);
    const moved = await runtime.store.findIdentityAccountByUserId({ userId });
    assert.equal(moved.email, movedEmail);
    assert.equal(moved.emailVerifiedAt, null, "proof of the old address is not proof of the new one");

    const otherUserId = `identity-other-${suffix}`;
    const otherEmail = `identity-other-${suffix}@example.test`;
    const otherSession = {
      sessionId: randomUUID(), userId: otherUserId, accessTokenId: randomUUID(),
      refreshHash: tokenHash("5"), expiresAt: hour,
      accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    assert.equal(await runtime.store.createIdentityAccount({
      userId: otherUserId, email: otherEmail, passwordHash: "hash-other", session: otherSession,
    }), true);
    assert.equal(await runtime.store.setIdentityEmail({ userId, email: otherEmail }), false,
      "one address cannot belong to two accounts");
    assert.equal((await runtime.store.findIdentityAccountByUserId({ userId })).email, movedEmail,
      "a refused move must leave the account where it was");
    assert.equal(await runtime.store.setIdentityEmail({ userId: `nobody-${suffix}`, email: `nowhere-${suffix}@example.test` }), false,
      "an account that does not exist cannot be moved either");
  });

  test(`${adapterName}: a session requires the current account and the verified credentials`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID(), userId = `identity-login-${suffix}`, email = `identity-login-${suffix}@example.test`;
    const expiry = new Date(Date.now() + 3_600_000).toISOString();
    const makeSession = () => ({ userId, sessionId: randomUUID(), accessTokenId: randomUUID(),
      refreshHash: randomBytes(32).toString("hex"), expiresAt: expiry, accessExpiresAt: expiry });
    const registered = makeSession(), late = makeSession();
    const oldProof = { email, passwordHash: "fixture-before" };
    assert.equal(await runtime.store.createIdentityAccount({ userId, ...oldProof, session: registered }), true);
    for (const proof of [undefined, null, { email }, { ...oldProof, email: `wrong-${email}` }, { ...oldProof, passwordHash: "wrong" }]) {
      assert.equal(await runtime.store.createIdentitySession(late, proof), false);
    }
    assert.equal(await runtime.store.createIdentitySession({ ...late, userId: `missing-${suffix}` }, oldProof), false);
    assert.equal(await runtime.store.createIdentitySession(late, oldProof), true);
    assert.deepEqual(await runtime.store.replaceIdentityPassword({ userId, passwordHash: "fixture-after" }), { updated: true, revokedSessions: 2 });
    const afterPassword = makeSession(), newProof = { email, passwordHash: "fixture-after" };
    assert.equal(await runtime.store.createIdentitySession(afterPassword, oldProof), false);
    assert.equal(await runtime.store.createIdentitySession(afterPassword, newProof), true);
    const moved = `moved-${email}`, afterEmail = makeSession();
    assert.equal(await runtime.store.setIdentityEmail({ userId, email: moved }), true);
    assert.equal(await runtime.store.createIdentitySession(afterEmail, newProof), false);
    assert.equal(await runtime.store.createIdentitySession(afterEmail, { ...newProof, email: moved }), true);
    assert.deepEqual((await runtime.store.listIdentitySessions({ userId, limit: 50 })).map((s) => s.sessionId).sort(),
      [afterPassword.sessionId, afterEmail.sessionId].sort());
  });

  test(`${adapterName}: a signed-in change is refused once its proof no longer matches`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID(), userId = `identity-proof-${suffix}`, email = `identity-proof-${suffix}@example.test`;
    const expiry = new Date(Date.now() + 3_600_000).toISOString();
    const makeSession = () => ({ userId, sessionId: randomUUID(), accessTokenId: randomUUID(),
      refreshHash: randomBytes(32).toString("hex"), expiresAt: expiry, accessExpiresAt: expiry });
    const first = makeSession();
    assert.equal(await runtime.store.createIdentityAccount({ userId, email, passwordHash: "hash-before", session: first }), true);
    const verified = { email, passwordHash: "hash-before" }, stale = { ...verified, passwordHash: "hash-superseded" };
    // A proof for an account that never had these facts is refused, including
    // one for an address this account no longer (or never did) hold.
    assert.deepEqual(await runtime.store.replaceIdentityPassword({ userId, passwordHash: "hash-from-stale", proof: stale }), { updated: false, revokedSessions: 0 });
    assert.equal(await runtime.store.setIdentityEmail({ userId, email: `stale-${email}`, proof: { ...verified, email: `old-${email}` } }), false);
    assert.equal(await runtime.store.setIdentityEmail({ userId: `missing-${suffix}`, email: `nowhere-${suffix}@example.test`, proof: verified }), false);
    assert.equal((await runtime.store.findIdentityAccountByUserId({ userId }))?.email, email, "a refused move leaves the address alone");
    assert.deepEqual((await runtime.store.findIdentityCredentials({ userId }))?.passwordHash, "hash-before");
    // The reset lands, as it would between the verification and the stale write.
    assert.deepEqual(await runtime.store.replaceIdentityPassword({ userId, passwordHash: "hash-reset" }), { updated: true, revokedSessions: 1 });
    const afterReset = makeSession();
    assert.equal(await runtime.store.createIdentitySession(afterReset, { email, passwordHash: "hash-reset" }), true);
    assert.deepEqual(await runtime.store.replaceIdentityPassword({ userId, passwordHash: "hash-stale", exceptSessionId: afterReset.sessionId, proof: verified }),
      { updated: false, revokedSessions: 0 }, "the older verified password cannot be written over the reset");
    assert.equal(await runtime.store.setIdentityEmail({ userId, email: `stale-${email}`, proof: verified }), false,
      "nor can the address move on a proof the reset invalidated");
    assert.equal((await runtime.store.findIdentityCredentials({ userId }))?.passwordHash, "hash-reset");
    assert.equal((await runtime.store.findIdentityAccountByUserId({ userId }))?.email, email);
    assert.deepEqual((await runtime.store.listIdentitySessions({ userId, limit: 50 })).map((s) => s.sessionId), [afterReset.sessionId],
      "the refused change revokes nothing");
    // The current state is accepted, so the guard is not simply refusing.
    assert.deepEqual(await runtime.store.replaceIdentityPassword({
      userId, passwordHash: "hash-next", exceptSessionId: afterReset.sessionId, proof: { email, passwordHash: "hash-reset" },
    }), { updated: true, revokedSessions: 0 });
    assert.equal(await runtime.store.setIdentityEmail({ userId, email: `moved-${email}`, proof: { email, passwordHash: "hash-next" } }), true);
  });

  test(`${adapterName}: a password replacement that cannot be written leaves every session as it was`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const userId = `identity-user-${suffix}`;
    const email = `identity-${suffix}@example.test`;
    const hour = new Date(Date.now() + 3_600_000).toISOString();
    // Random, not spelled out: the PostgreSQL half of this file runs against one
    // shared database, and a refresh hash is a primary key.
    const hash = () => randomBytes(32).toString("hex");
    const thisRefresh = hash();
    const otherRefresh = hash();
    const session = {
      sessionId: randomUUID(), userId, accessTokenId: randomUUID(),
      refreshHash: thisRefresh, expiresAt: hour,
      accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    assert.equal(await runtime.store.createIdentityAccount({ userId, email, passwordHash: "hash-before", session }), true);
    const secondSession = {
      sessionId: randomUUID(), userId, accessTokenId: randomUUID(),
      refreshHash: otherRefresh, expiresAt: hour,
      accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    assert.equal(await runtime.store.createIdentitySession(secondSession, { email, passwordHash: "hash-before" }), true);

    /**
     * The point of the whole method: the sessions and the credential are two
     * statements that must never be observable apart. If the write cannot
     * happen, everything the call did has to come back — otherwise the failure
     * looks like "the password did not change" while quietly having signed the
     * owner's other devices out.
     *
     * `password_hash` is NOT NULL in both providers, so this is the one way a
     * test can make the write fail the same way on both.
     */
    await assert.rejects(() => runtime.store.replaceIdentityPassword({
      userId, passwordHash: null as unknown as string, exceptSessionId: session.sessionId,
    }));

    assert.equal((await runtime.store.findIdentityAccount({ email })).passwordHash, "hash-before",
      "a failed replacement leaves the old credential in place");
    const otherDevice = await runtime.store.rotateIdentityRefresh({
      refreshHash: otherRefresh, nextRefreshHash: hash(),
      accessTokenId: randomUUID(), issuedAt: new Date().toISOString(),
      accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    assert.equal(otherDevice.status, "rotated", "and the sessions it would have revoked are still signed in");
    const thisDevice = await runtime.store.rotateIdentityRefresh({
      refreshHash: thisRefresh, nextRefreshHash: hash(),
      accessTokenId: randomUUID(), issuedAt: new Date().toISOString(),
      accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    assert.equal(thisDevice.status, "rotated", "the session that would have been spared never notices");

    /**
     * Naming a session that is not this account's spares nothing. The sparing is
     * a filter on the account's own sessions, so a session id taken from
     * somewhere else cannot keep this account's thief signed in.
     */
    const otherUserId = `identity-other-${suffix}`;
    const foreignRefresh = hash();
    const otherSession = {
      sessionId: randomUUID(), userId: otherUserId, accessTokenId: randomUUID(),
      refreshHash: foreignRefresh, expiresAt: hour,
      accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    assert.equal(await runtime.store.createIdentityAccount({
      userId: otherUserId, email: `identity-other-${suffix}@example.test`, passwordHash: "hash-other", session: otherSession,
    }), true);
    const foreign = await runtime.store.replaceIdentityPassword({
      userId, passwordHash: "hash-after", exceptSessionId: otherSession.sessionId,
    });
    assert.equal(foreign.revokedSessions, 2, "a session that is not this account's spares none of its sessions");
    const foreignSession = await runtime.store.rotateIdentityRefresh({
      refreshHash: foreignRefresh, nextRefreshHash: hash(),
      accessTokenId: randomUUID(), issuedAt: new Date().toISOString(),
      accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    assert.equal(foreignSession.status, "rotated", "and the other account is untouched by it");
  });

  test(`${adapterName}: a device can be listed, ended on its own, and ended along with the others`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const userId = `identity-user-${suffix}`;
    const email = `identity-${suffix}@example.test`;
    const hour = new Date(Date.now() + 3_600_000).toISOString();
    const hash = () => randomBytes(32).toString("hex");
    const makeSession = () => ({
      sessionId: randomUUID(), userId, accessTokenId: randomUUID(),
      refreshHash: hash(), expiresAt: hour,
      accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    const phone = makeSession();
    const laptop = makeSession();
    assert.equal(await runtime.store.createIdentityAccount({ userId, email, passwordHash: "hash-before", session: phone }), true);
    assert.equal(await runtime.store.createIdentitySession(laptop, { email, passwordHash: "hash-before" }), true);
    // A session that already expired is not a device anybody can be asked about.
    assert.equal(await runtime.store.createIdentitySession({ ...makeSession(), expiresAt: new Date(Date.now() - 1000).toISOString() }, { email, passwordHash: "hash-before" }), true);

    const listed = await runtime.store.listIdentitySessions({ userId, limit: 50 });
    assert.deepEqual(listed.map((session) => session.sessionId).sort(), [phone.sessionId, laptop.sessionId].sort(),
      "only live sessions are devices; the expired one is not offered as a choice");
    for (const session of listed) {
      assert.equal(session.lastUsedAt, null, "nothing has refreshed yet");
      assert.ok(new Date(session.expiresAt).getTime() > Date.now());
      assert.ok(new Date(session.createdAt).getTime() <= Date.now());
    }

    // Refreshing is the only activity the store can honestly report.
    const rotated = await runtime.store.rotateIdentityRefresh({
      refreshHash: phone.refreshHash, nextRefreshHash: hash(),
      accessTokenId: randomUUID(), issuedAt: new Date().toISOString(),
      accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    assert.equal(rotated.status, "rotated");
    const afterUse = await runtime.store.listIdentitySessions({ userId, limit: 50 });
    const used = afterUse.find((session) => session.sessionId === phone.sessionId);
    assert.ok(used?.lastUsedAt, "the device that refreshed shows when");
    assert.equal(afterUse.length, 2, "and it is still the same two devices");
    assert.equal(afterUse[0]?.sessionId, phone.sessionId, "newest activity first");

    // Ending one device: exactly that one stops working.
    assert.equal(await runtime.store.revokeIdentitySession({ userId, sessionId: laptop.sessionId }), true);
    assert.equal(await runtime.store.revokeIdentitySession({ userId, sessionId: laptop.sessionId }), false,
      "ending it twice is not a second device");
    assert.equal(await runtime.store.revokeIdentitySession({ userId, sessionId: randomUUID() }), false,
      "an id that is not a session of this account is not ended");
    const laptopAfter = await runtime.store.rotateIdentityRefresh({
      refreshHash: laptop.refreshHash, nextRefreshHash: hash(),
      accessTokenId: randomUUID(), issuedAt: new Date().toISOString(),
      accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    assert.equal(laptopAfter.status, "invalid", "the ended device cannot refresh");
    const listedAfter = await runtime.store.listIdentitySessions({ userId, limit: 50 });
    assert.deepEqual(listedAfter.map((session) => session.sessionId), [phone.sessionId]);

    // Ending every other device keeps the one that asked.
    const third = makeSession();
    assert.equal(await runtime.store.createIdentitySession(third, { email, passwordHash: "hash-before" }), true);
    assert.equal(await runtime.store.revokeIdentitySessions({ userId, exceptSessionId: phone.sessionId }), 1,
      "the new device goes, the one that asked stays");
    const thirdAfter = await runtime.store.rotateIdentityRefresh({
      refreshHash: third.refreshHash, nextRefreshHash: hash(),
      accessTokenId: randomUUID(), issuedAt: new Date().toISOString(),
      accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    assert.equal(thirdAfter.status, "invalid");
    assert.equal(await runtime.store.revokeIdentitySessions({ userId, exceptSessionId: phone.sessionId }), 0,
      "a second sweep finds nothing left to end");

    // Sparing nothing ends the device that asked too.
    assert.equal(await runtime.store.revokeIdentitySessions({ userId, exceptSessionId: null }), 1);
    assert.deepEqual(await runtime.store.listIdentitySessions({ userId, limit: 50 }), []);

    // The list is bounded, because it is rendered as a choice.
    for (let index = 0; index < 3; index += 1) assert.equal(await runtime.store.createIdentitySession(makeSession(), { email, passwordHash: "hash-before" }), true);
    assert.equal((await runtime.store.listIdentitySessions({ userId, limit: 2 })).length, 2);
    // ...and another account's devices are never in it.
    const otherUserId = `identity-other-${suffix}`;
    assert.equal(await runtime.store.createIdentityAccount({
      userId: otherUserId, email: `identity-other-${suffix}@example.test`, passwordHash: "hash-other", session: makeSession(),
    }), true);
    assert.equal(await runtime.store.revokeIdentitySession({ userId, sessionId: phone.sessionId }), false,
      "an ended session is not a device of this account any more");
  });

  test(`${adapterName}: publishing a work is idempotent per author and does not leave a second copy behind`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const author = `article-author-${suffix}`;
    const other = `article-author-b-${suffix}`;
    const blocks = [{ id: "p1", type: "paragraph", text: "Shared persistence contract content." }];
    const slug = `contract-create-once-${suffix}`;
    const input = {
      authorId: author, slug, requestedSlug: slug, title: "Create once", summary: "",
      locale: "zh-CN", contentBlocks: blocks, publish: true, idempotencyKey: `publish-once-${suffix}`,
    };
    try {
      // Three at once, not two: a single pair raced rarely enough that the
      // PostgreSQL half passed by luck locally and failed under CI's load, and
      // the failure it hides is either a duplicate work or a bogus slug conflict.
      const attempts = await Promise.all([
        runtime.store.createArticle(input),
        runtime.store.createArticle(input),
        runtime.store.createArticle(input),
      ]);
      const [first, retried] = attempts;
      assert.equal(new Set(attempts.map((article) => article.id)).size, 1, "concurrent retries must all return the one work");
      assert.equal(retried.id, first.id, "a retry must return the work the first attempt published");
      assert.equal(retried.slug, first.slug, "and must not have been handed a uniquified second address");
      assert.equal(
        (await runtime.store.listMyArticles({ actorId: author, locale: "zh-CN", limit: 100 })).filter((item) => item.id === first.id).length,
        1,
      );

      await assert.rejects(
        Promise.resolve().then(() => runtime.store.createArticle({ ...input, title: "A different work" })),
        IdempotencyConflictError,
        "the same key with a different work is a conflicting request, not a replay",
      );

      // Without a key the same address is simply taken: turning a genuinely
      // different work into a new address is the route's uniquifier, not the
      // store's, and a replay must not lean on it.
      const unkeyed = {
        ...input,
        idempotencyKey: null,
        slug: `contract-create-twice-${suffix}`,
        requestedSlug: `contract-create-twice-${suffix}`,
      };
      await runtime.store.createArticle(unkeyed);
      await assert.rejects(
        Promise.resolve().then(() => runtime.store.createArticle(unkeyed)),
        ArticleSlugConflictError,
      );

      // The key is scoped to the author: someone else may reuse the same string
      // for their own work.
      const theirs = await runtime.store.createArticle({
        ...input,
        authorId: other,
        slug: `contract-create-once-b-${suffix}`,
        requestedSlug: `contract-create-once-b-${suffix}`,
      });
      assert.notEqual(theirs.id, first.id);
    } finally {
      await runtime.cleanup(undefined, suffix);
    }
  });

  test(`${adapterName}: an auto-generated slug replay survives suffix uniquification`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const author = `article-author-${suffix}`;
    const blocks = [{ id: "p1", type: "paragraph", text: "Auto slug replay contract content." }];
    try {
      // Draft and published writes must answer the same way: the bug was in the
      // request fingerprint, not in the status the article ended up with.
      for (const publish of [false, true]) {
        const base = `auto-slug-${publish ? "published" : "draft"}-${suffix}`;
        const key = `auto-slug-${publish ? "published" : "draft"}-key-${suffix}`;
        const common = {
          authorId: author, title: "Auto slug replay", summary: "", locale: "zh-CN",
          contentBlocks: blocks, publish, idempotencyKey: key, requestedSlug: null,
        };

        // The route's first attempt would hit a taken base slug; this call
        // stands in for the successful `-2` attempt.
        const first = await runtime.store.createArticle({ ...common, slug: `${base}-2` });
        assert.equal(first.slug, `${base}-2`);

        // A sequential replay starts again at the base candidate. It must still
        // return the one work that was actually stored.
        const replay = await runtime.store.createArticle({ ...common, slug: base });
        assert.equal(replay.id, first.id, "a sequential replay must return the first work");
        assert.equal(replay.slug, first.slug, "and must keep the suffix the first write committed");

        // Concurrent replays may arrive at different candidate slugs.
        const attempts = await Promise.all([
          runtime.store.createArticle({ ...common, slug: base }),
          runtime.store.createArticle({ ...common, slug: `${base}-2` }),
          runtime.store.createArticle({ ...common, slug: `${base}-3` }),
        ]);
        assert.equal(new Set(attempts.map((article) => article.id)).size, 1);
        assert.equal(attempts[0].slug, first.slug);

        // A client-supplied slug is part of the fingerprint: reusing the key
        // with a different explicit address is still a conflict.
        await assert.rejects(
          Promise.resolve().then(() => runtime.store.createArticle({
            ...common,
            slug: `${base}-explicit`,
            requestedSlug: `${base}-explicit`,
          })),
          IdempotencyConflictError,
          "an explicit slug change must not be accepted as a replay",
        );
      }
    } finally {
      await runtime.cleanup(undefined, suffix);
    }
  });

  test(`${adapterName}: the following feed lists published work from followed authors, newest first`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const readerId = `feed-reader-${suffix}`;
    const authorA = `feed-author-a-${suffix}`;
    const authorB = `feed-author-b-${suffix}`;
    const strangerId = `feed-stranger-${suffix}`;
    const blocks = [{ id: "p1", type: "paragraph", text: "Feed contract body." }];
    try {
      for (const [userId, displayName] of [[authorA, "Feed A"], [authorB, "Feed B"], [strangerId, "Stranger"]]) {
        await runtime.store.upsertAuthorProfile({ userId, displayName, locale: "zh-CN" });
      }
      await runtime.store.createArticle({ authorId: authorA, slug: `feed-older-${suffix}`, title: "A 的旧作", summary: "", locale: "zh-CN", contentBlocks: blocks, publish: true });
      await runtime.store.createArticle({ authorId: authorA, slug: `feed-draft-${suffix}`, title: "A 的草稿", summary: "", locale: "zh-CN", contentBlocks: blocks, publish: false });
      await runtime.store.createArticle({ authorId: authorB, slug: `feed-newer-${suffix}`, title: "B 的新作", summary: "", locale: "zh-CN", contentBlocks: blocks, publish: true });
      await runtime.store.createArticle({ authorId: strangerId, slug: `feed-unfollowed-${suffix}`, title: "陌生人的作品", summary: "", locale: "zh-CN", contentBlocks: blocks, publish: true });
      await runtime.setArticlePublishedAt(`feed-older-${suffix}`, "2024-01-01T00:00:00.000Z");
      await runtime.setArticlePublishedAt(`feed-newer-${suffix}`, "2024-06-01T00:00:00.000Z");

      // Following nobody is an empty feed, not an error and not the global feed.
      assert.deepEqual(await runtime.store.listFollowingArticles({ actorId: readerId, locale: "zh-CN" }), []);

      assert.equal(await runtime.store.followUser({ actorId: readerId, targetUserId: authorA }), true);
      assert.equal(await runtime.store.followUser({ actorId: readerId, targetUserId: authorB }), true);

      const feed = await runtime.store.listFollowingArticles({ actorId: readerId, locale: "zh-CN" });
      assert.deepEqual(feed.map((article) => article.slug), [`feed-newer-${suffix}`, `feed-older-${suffix}`]);
      // A draft the followed author has not published is not an update yet.
      assert.ok(!feed.some((article) => article.slug === `feed-draft-${suffix}`));
      assert.ok(!feed.some((article) => article.authorId === strangerId));

      // Locale is a property of the translation the reader asked for, not of the author.
      assert.deepEqual(await runtime.store.listFollowingArticles({ actorId: readerId, locale: "en" }), []);

      // Offset pagination walks the same set once, without repeats or gaps.
      const firstPage = await runtime.store.listFollowingArticles({ actorId: readerId, locale: "zh-CN", limit: 1, offset: 0 });
      const secondPage = await runtime.store.listFollowingArticles({ actorId: readerId, locale: "zh-CN", limit: 1, offset: 1 });
      const thirdPage = await runtime.store.listFollowingArticles({ actorId: readerId, locale: "zh-CN", limit: 1, offset: 2 });
      assert.deepEqual(firstPage.map((article) => article.slug), [`feed-newer-${suffix}`]);
      assert.deepEqual(secondPage.map((article) => article.slug), [`feed-older-${suffix}`]);
      assert.deepEqual(thirdPage, []);

      // Unfollowing removes the author's work from the feed immediately.
      await runtime.store.unfollowUser({ actorId: readerId, targetUserId: authorA });
      assert.deepEqual(
        (await runtime.store.listFollowingArticles({ actorId: readerId, locale: "zh-CN" })).map((article) => article.slug),
        [`feed-newer-${suffix}`],
      );

      // The same bounds as every other article list, so a client page size cannot
      // become an unbounded scan.
      await assert.rejects(Promise.resolve().then(() => runtime.store.listFollowingArticles({ actorId: readerId, locale: "zh-CN", limit: 0 })), ArticleInputError);
      await assert.rejects(Promise.resolve().then(() => runtime.store.listFollowingArticles({ actorId: readerId, locale: "zh-CN", limit: 101 })), ArticleInputError);
      await assert.rejects(Promise.resolve().then(() => runtime.store.listFollowingArticles({ actorId: readerId, locale: "zh-CN", offset: -1 })), ArticleInputError);
      await assert.rejects(Promise.resolve().then(() => runtime.store.listFollowingArticles({ actorId: readerId, locale: "zh-CN", offset: 100001 })), ArticleInputError);
      await assert.rejects(Promise.resolve().then(() => runtime.store.listFollowingArticles({ actorId: "  ", locale: "zh-CN" })), ArticleInputError);
      await assert.rejects(Promise.resolve().then(() => runtime.store.listFollowingArticles({ actorId: readerId, locale: "klingon" })), ArticleInputError);
    } finally {
      await runtime.cleanup(undefined, suffix);
    }
  });

  test(`${adapterName}: discovery sorts by newest, or by how many times a work was ever saved`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const authorId = `sort-author-${suffix}`;
    const otherAuthorId = `sort-other-author-${suffix}`;
    const now = new Date("2026-06-01T00:00:00.000Z");
    const daysAgo = (days) => new Date(now.getTime() - days * 86400000).toISOString();
    const blocks = [{ id: "p1", type: "paragraph", text: "Sort contract body." }];
    const publish = async (author, slug, title, days) => {
      // The title carries the suffix so every query below can scope itself to the
      // rows this test owns: the PostgreSQL fixture is one shared database, unlike
      // SQLite's per-test `:memory:` file, so an unscoped list assertion would read
      // whatever another contract left behind.
      await runtime.store.createArticle({ authorId: author, slug, title: `${title}-${suffix}`, summary: "", locale: "zh-CN", contentBlocks: blocks, publish: true });
      await runtime.setArticlePublishedAt(slug, daysAgo(days));
    };
    const like = async (slug, howMany) => {
      for (let index = 1; index <= howMany; index += 1) {
        await runtime.store.setArticleLike({ slug, locale: "zh-CN", actorId: `sort-liker-${suffix}-${index}`, liked: true });
      }
    };
    try {
      await runtime.store.upsertAuthorProfile({ userId: authorId, displayName: "Sort Author", locale: "zh-CN" });
      await runtime.store.upsertAuthorProfile({ userId: otherAuthorId, displayName: "Other Author", locale: "zh-CN" });
      await publish(authorId, `sort-quiet-${suffix}`, "安静的新作", 1);
      await publish(authorId, `sort-popular-${suffix}`, "寻找春天", 3);
      await publish(authorId, `sort-edge-in-${suffix}`, "刚好在窗口内", 30);
      await publish(authorId, `sort-edge-out-${suffix}`, "刚好在窗口外", 31);
      await publish(authorId, `sort-old-${suffix}`, "两年前的旧作", 60);
      await publish(otherAuthorId, `sort-other-work-${suffix}`, "别人的作品", 2);
      // Nothing is excluded for being old: the tab is "most saved", so a work
      // that collected its likes two years ago outranks one published yesterday.
      await like(`sort-edge-out-${suffix}`, 10);
      await like(`sort-old-${suffix}`, 5);
      await like(`sort-popular-${suffix}`, 3);

      const slugs = (articles) => articles.map((article) => article.slug);
      const latest = await runtime.store.listPublishedArticles({ locale: "zh-CN", query: suffix, limit: 20 });
      assert.deepEqual(slugs(latest), [
        `sort-quiet-${suffix}`, `sort-other-work-${suffix}`, `sort-popular-${suffix}`,
        `sort-edge-in-${suffix}`, `sort-edge-out-${suffix}`, `sort-old-${suffix}`,
      ]);

      // Every save the work ever had, then newest first to break a tie. The
      // two-year-old piece with 5 saves sits above yesterday's quiet new work.
      const popular = await runtime.store.listPublishedArticles({ locale: "zh-CN", query: suffix, sort: "popular", limit: 20 });
      assert.deepEqual(slugs(popular), [
        `sort-edge-out-${suffix}`, `sort-old-${suffix}`, `sort-popular-${suffix}`,
        `sort-quiet-${suffix}`, `sort-other-work-${suffix}`, `sort-edge-in-${suffix}`,
      ]);

      const tail = await runtime.store.listPublishedArticles({ locale: "zh-CN", query: suffix, sort: "popular", limit: 20, offset: 3 });
      assert.deepEqual(slugs(tail), [`sort-quiet-${suffix}`, `sort-other-work-${suffix}`, `sort-edge-in-${suffix}`]);

      // Sort composes with the existing filters instead of replacing them.
      const searched = await runtime.store.listPublishedArticles({ locale: "zh-CN", query: `春天-${suffix}`, sort: "popular", limit: 20 });
      assert.deepEqual(slugs(searched), [`sort-popular-${suffix}`]);
      const byAuthor = await runtime.store.listPublishedArticles({ locale: "zh-CN", query: suffix, authorId, sort: "popular", limit: 20 });
      assert.deepEqual(slugs(byAuthor), [
        `sort-edge-out-${suffix}`, `sort-old-${suffix}`, `sort-popular-${suffix}`,
        `sort-quiet-${suffix}`, `sort-edge-in-${suffix}`,
      ]);

      // Pagination walks the sorted set once.
      const firstTwo = await runtime.store.listPublishedArticles({ locale: "zh-CN", query: suffix, sort: "popular", limit: 2, offset: 0 });
      const nextTwo = await runtime.store.listPublishedArticles({ locale: "zh-CN", query: suffix, sort: "popular", limit: 2, offset: 2 });
      const lastTwo = await runtime.store.listPublishedArticles({ locale: "zh-CN", query: suffix, sort: "popular", limit: 2, offset: 4 });
      assert.deepEqual(slugs(firstTwo).concat(slugs(nextTwo), slugs(lastTwo)), slugs(popular));

      await assert.rejects(Promise.resolve().then(() => runtime.store.listPublishedArticles({ locale: "zh-CN", query: suffix, sort: "hottest" })), ArticleInputError);
    } finally {
      await runtime.cleanup(undefined, suffix);
    }
  });

  /**
   * A reader who remembers one line of a story has no title to search for. The
   * body is therefore searched too — block by block, and never as the JSON it is
   * stored as, because matching the raw text would make "paragraph" the most
   * successful query on the site.
   *
   * "One line" is not always a paragraph: it can be a bullet or a line of code
   * (#245). Both engines search every field a reader wrote, and neither searches
   * the block vocabulary.
   */
  test(`${adapterName}: a search finds a work by a word that appears only in its body`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const authorId = `search-author-${suffix}`;
    const blocks = (text) => [{ id: "p1", type: "paragraph", text }];
    const publish = async (slug, title, summary, text) => {
      await runtime.store.createArticle({ authorId, slug, title, summary, locale: "zh-CN", contentBlocks: blocks(text), publish: true });
    };
    try {
      await runtime.store.upsertAuthorProfile({ userId: authorId, displayName: "Search Author", locale: "zh-CN" });
      await publish(`search-in-title-${suffix}`, `雨-${suffix}`, `雨的摘要-${suffix}`, "正文里没有那个字。");
      await publish(`search-in-body-${suffix}`, `无题-${suffix}`, `平淡的摘要-${suffix}`, "她把书翻到第七十页，窗外正下着雨。");
      await publish(`search-absent-${suffix}`, `别的-${suffix}`, `别的摘要-${suffix}`, "完全无关的一段正文。");
      // The word is in the *second* block, so a body search that stops at the
      // first block it reads would miss it.
      await runtime.store.createArticle({
        authorId,
        slug: `search-later-block-${suffix}`,
        title: `两段-${suffix}`,
        summary: `两段的摘要-${suffix}`,
        locale: "zh-CN",
        contentBlocks: [
          { id: "p1", type: "paragraph", text: "第一段里没有那个字。" },
          { id: "p2", type: "paragraph", text: "第二段写着：雨停了。" },
        ],
        publish: true,
      });

      const slugs = (articles) => articles.map((article) => article.slug).sort();
      const byWord = await runtime.store.listPublishedArticles({ locale: "zh-CN", query: "雨", limit: 50 });
      assert.deepEqual(
        slugs(byWord),
        [`search-in-body-${suffix}`, `search-in-title-${suffix}`, `search-later-block-${suffix}`].sort(),
      );

      // The body adds hits; it does not replace the fields that were already
      // searched, and it is not searched at the cost of them.
      const bySummary = await runtime.store.listPublishedArticles({ locale: "zh-CN", query: `雨的摘要-${suffix}`, limit: 50 });
      assert.deepEqual(slugs(bySummary), [`search-in-title-${suffix}`]);

      // A list's items and a code block's code are text the reader wrote (#245),
      // and on a technical site they are often the only place a term appears.
      await runtime.store.createArticle({
        authorId,
        slug: `search-list-code-${suffix}`,
        title: `代码与清单-${suffix}`,
        summary: `技术笔记的摘要-${suffix}`,
        locale: "zh-CN",
        contentBlocks: [
          { id: "l1", type: "list", ordered: false, items: ["列表独有词条阿尔法"] },
          { id: "c1", type: "code", language: "ts", code: "const uniqueCodeTokenBeta = 1;" },
        ],
        publish: true,
      });
      const byListItem = await runtime.store.listPublishedArticles({ locale: "zh-CN", query: "阿尔法", limit: 50 });
      assert.deepEqual(slugs(byListItem), [`search-list-code-${suffix}`], "a list item is body text");
      // The needle is folded by the engine, so the same hit is found in any case.
      const byCode = await runtime.store.listPublishedArticles({ locale: "zh-CN", query: "uniquecodetokenbeta", limit: 50 });
      assert.deepEqual(slugs(byCode), [`search-list-code-${suffix}`], "so is a line of code");

      // Storage is not content: a block's own vocabulary is not findable.
      assert.deepEqual(await runtime.store.listPublishedArticles({ locale: "zh-CN", query: "paragraph", limit: 50 }), []);
      assert.deepEqual(await runtime.store.listPublishedArticles({ locale: "zh-CN", query: "ordered", limit: 50 }), []);

      // The body search composes with what surrounds it.
      const scoped = await runtime.store.listPublishedArticles({ locale: "zh-CN", query: "雨", authorId, sort: "popular", limit: 50 });
      assert.deepEqual(
        slugs(scoped),
        [`search-in-body-${suffix}`, `search-in-title-${suffix}`, `search-later-block-${suffix}`].sort(),
      );
    } finally {
      await runtime.cleanup(undefined, suffix);
    }
  });

  /**
   * The two orders have different ceilings, and the store enforces the same one
   * the route applies (audit F-23).
   *
   * `latest` can be walked exactly by a cursor, so a deep `OFFSET` is merely
   * expensive. `popular` orders by a count that changes as it is read, so there
   * is no cursor to fall back on and the honest answer past the ceiling is a
   * refusal rather than a page that may be wrong before it is rendered.
   */
  test(`${adapterName}: the most-saved order is not pageable past its ceiling`, options, async () => {
    const runtime = await fixture();
    const suffix = `offset-ceiling-${randomUUID().slice(0, 8)}`;
    try {
      await assert.rejects(
        Promise.resolve().then(() =>
          runtime.store.listPublishedArticles({ locale: "zh-CN", sort: "popular", offset: MAX_ARTICLE_OFFSET_POPULAR + 1 }),
        ),
        (error) => error instanceof ArticleInputError && /sort=popular/.test(error.message),
      );
      // The same depth is allowed newest-first, and the newest-first ceiling is
      // still the one the transport publishes.
      assert.deepEqual(await runtime.store.listPublishedArticles({ locale: "zh-CN", offset: MAX_ARTICLE_OFFSET_POPULAR + 1 }), []);
      await assert.rejects(
        Promise.resolve().then(() => runtime.store.listPublishedArticles({ locale: "zh-CN", offset: MAX_ARTICLE_OFFSET + 1 })),
        ArticleInputError,
      );
    } finally {
      await runtime.cleanup(undefined, suffix);
    }
  });

  /**
   * Why a cursor exists: an offset counts rows, so a work published while the
   * reader is scrolling pushes everything down and they meet one twice. A
   * cursor names the last work they saw instead, so the answer does not depend
   * on what happened above it.
   *
   * The test publishes a new work between the two reads, which is the whole
   * point — and then asks the same question by offset to show the difference.
   */
  /**
   * The public author directory (ADR 0024).
   *
   * The assertions that matter are the ones a reader can see and the ones a
   * directory has to get right to be worth publishing:
   *
   * - **only authors a reader can go and read** — somebody who has published in
   *   this locale. An account with no work is not an author here, and listing
   *   one would turn the directory into a member list;
   * - **works counted in the requested locale only** — a draft, a tombstone and
   *   another locale's work are all published-elsewhere, not published-here;
   * - **relevance before reach** — searching a name puts the name that *starts*
   *   with the term above the name that merely contains it, even when the second
   *   author has more followers; with no term at all, reach is the order, because
   *   the point of a directory is discovery.
   */
  test(`${adapterName}: the author directory lists published authors of this locale, relevance first`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID().slice(0, 8);
    const prefixId = `dir-prefix-${suffix}`;
    const containsId = `dir-contains-${suffix}`;
    const englishId = `dir-english-${suffix}`;
    const silentId = `dir-silent-${suffix}`;
    const followerId = `dir-follower-${suffix}`;
    const blocks = [{ id: "p1", type: "paragraph", text: "A published body." }];
    const publish = (authorId, slug, locale = "zh-CN") =>
      runtime.store.createArticle({ authorId, slug, title: slug, summary: "", locale, contentBlocks: blocks, publish: true });
    const names = (rows) => rows.map((row) => row.displayName);
    const byId = (rows, userId) => rows.find((row) => row.userId === userId);
    try {
      await runtime.store.upsertAuthorProfile({ userId: prefixId, displayName: `林晚 ${suffix}`, bio: "写小说", locale: "zh-CN" });
      await runtime.store.upsertAuthorProfile({ userId: containsId, displayName: `苏林 ${suffix}`, bio: "写诗", locale: "zh-CN" });
      await runtime.store.upsertAuthorProfile({ userId: englishId, displayName: `English Only ${suffix}`, locale: "en" });
      await runtime.store.upsertAuthorProfile({ userId: silentId, displayName: `没有作品 ${suffix}`, locale: "zh-CN" });
      await runtime.store.upsertAuthorProfile({ userId: followerId, displayName: `Follower ${suffix}`, locale: "zh-CN" });

      // 林晚: two published Chinese works, plus a draft and a tombstone that must
      // not be counted, and an English work that belongs to the other locale.
      await publish(prefixId, `dir-prefix-1-${suffix}`);
      await publish(prefixId, `dir-prefix-2-${suffix}`);
      await runtime.store.createArticle({ authorId: prefixId, slug: `dir-prefix-draft-${suffix}`, title: "草稿", summary: "", locale: "zh-CN", contentBlocks: blocks, publish: false });
      const doomed = await runtime.store.createArticle({ authorId: prefixId, slug: `dir-prefix-gone-${suffix}`, title: "回收站", summary: "", locale: "zh-CN", contentBlocks: blocks, publish: true });
      await runtime.store.deleteArticle({ articleId: doomed.id, actorId: prefixId });
      await publish(prefixId, `dir-prefix-en-${suffix}`, "en");
      await publish(containsId, `dir-contains-1-${suffix}`);
      await publish(englishId, `dir-english-1-${suffix}`, "en");
      // 苏林 is the more-followed of the two: the ordering test only means
      // something if reach and relevance disagree.
      await runtime.store.followUser({ actorId: followerId, targetUserId: containsId });

      const directory = await runtime.store.searchAuthors({ locale: "zh-CN", limit: 50 });
      const ids = directory.map((row) => row.userId);
      assert.ok(ids.includes(prefixId), "an author with published work in this locale is listed");
      assert.ok(ids.includes(containsId));
      assert.equal(ids.includes(silentId), false, "an account that has published nothing is not an author here");
      assert.equal(ids.includes(englishId), false, "and neither is somebody who published only in another locale");
      assert.equal(byId(directory, prefixId).workCount, 2, "the draft, the tombstone and the English work are not counted");
      assert.equal(byId(directory, containsId).workCount, 1);
      assert.equal(byId(directory, prefixId).followerCount, 0);
      assert.equal(byId(directory, containsId).followerCount, 1);

      // No term: reach is the order.
      assert.equal(names(directory)[0], `苏林 ${suffix}`, "the author with more followers comes first");

      // With a term: relevance is the order, and it outranks reach.
      const searched = await runtime.store.searchAuthors({ locale: "zh-CN", query: "林", limit: 50 });
      assert.deepEqual(names(searched), [`林晚 ${suffix}`, `苏林 ${suffix}`], "a name that starts with the term beats one that only contains it");

      // The directory is locale-scoped, like every other public list: it is the
      // *works* that decide membership, not the language of the profile. 林晚 also
      // published in English, so 林晚 is in the English directory — under the only
      // name they have, which is the Chinese one. 苏林 did not, so 苏林 is not.
      const english = await runtime.store.searchAuthors({ locale: "en", limit: 50 });
      const englishIds = english.map((row) => row.userId);
      assert.ok(englishIds.includes(englishId), "the English author is in the English directory");
      assert.ok(englishIds.includes(prefixId), "and so is the Chinese author who published there too");
      assert.equal(englishIds.includes(containsId), false, "an author who published only in Chinese is not");

      // Paging is offset-based, like the category index it sits beside.
      assert.deepEqual(names(await runtime.store.searchAuthors({ locale: "zh-CN", limit: 1, offset: 0 })), [`苏林 ${suffix}`]);
      assert.deepEqual(names(await runtime.store.searchAuthors({ locale: "zh-CN", limit: 1, offset: 1 })), [`林晚 ${suffix}`]);
      assert.deepEqual(names(await runtime.store.searchAuthors({ locale: "zh-CN", limit: 1, offset: 2 })), [], "past the end is an empty page");

      // A name nobody has: empty, not everything.
      assert.deepEqual(await runtime.store.searchAuthors({ locale: "zh-CN", query: `no-such-author-${suffix}` }), []);
    } finally {
      await runtime.cleanup(undefined, suffix);
    }
  });

  test(`${adapterName}: the author directory refuses unbounded queries and pages`, options, async () => {
    const runtime = await fixture();
    const bad = [
      { query: "x".repeat(201) },
      { limit: 0 },
      { limit: 101 },
      { offset: -1 },
      { offset: 100_001 },
    ];
    for (const input of bad) {
      await assert.rejects(
        Promise.resolve().then(() => runtime.store.searchAuthors({ locale: "zh-CN", ...input })),
        ProfileInputError,
        `rejects ${JSON.stringify(input)}`,
      );
    }
    // An empty query is not an invalid one: it is the whole directory.
    assert.ok(Array.isArray(await runtime.store.searchAuthors({ locale: "zh-CN", query: "", limit: 1 })));
  });

  test(`${adapterName}: a cursor walks the newest works once, even if one is published mid-scroll`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const authorId = `cursor-author-${suffix}`;
    const blocks = [{ id: "p1", type: "paragraph", text: "Cursor contract body." }];
    const now = new Date("2026-06-01T00:00:00.000Z");
    const daysAgo = (days) => new Date(now.getTime() - days * 86400000).toISOString();
    const publish = async (slug, days) => {
      await runtime.store.createArticle({ authorId, slug, title: `${slug}`, summary: "", locale: "zh-CN", contentBlocks: blocks, publish: true });
      await runtime.setArticlePublishedAt(slug, daysAgo(days));
    };
    const list = (extra) => runtime.store.listPublishedArticles({ locale: "zh-CN", query: suffix, ...extra });
    const slugs = (rows) => rows.map((article) => article.slug);
    const cursorAfter = (rows) => encodeArticleCursor(rows[rows.length - 1].publishedAt, rows[rows.length - 1].id);
    try {
      await runtime.store.upsertAuthorProfile({ userId: authorId, displayName: "Cursor Author", locale: "zh-CN" });
      for (let index = 1; index <= 5; index += 1) await publish(`cursor-work-${index}-${suffix}`, index);

      const first = await list({ limit: 2 });
      assert.deepEqual(slugs(first), [`cursor-work-1-${suffix}`, `cursor-work-2-${suffix}`]);

      // Mid-scroll: the newest work on the site appears above where the reader is.
      await publish(`cursor-intruder-${suffix}`, 0);

      const second = await list({ limit: 2, cursor: cursorAfter(first) });
      assert.deepEqual(slugs(second), [`cursor-work-3-${suffix}`, `cursor-work-4-${suffix}`], "no repeat, nothing skipped");
      const third = await list({ limit: 2, cursor: cursorAfter(second) });
      assert.deepEqual(slugs(third), [`cursor-work-5-${suffix}`]);
      // The end of a list is an empty page, not a special field to parse.
      assert.deepEqual(slugs(await list({ limit: 2, cursor: cursorAfter(third) })), []);

      // The same two rows by offset: the intruder has pushed work 2 into them.
      assert.deepEqual(slugs(await list({ limit: 2, offset: 2 })), [`cursor-work-2-${suffix}`, `cursor-work-3-${suffix}`]);

      // A cursor is a place in a particular order, not a token to wave around.
      const cursor = cursorAfter(first);
      await assert.rejects(Promise.resolve().then(() => list({ limit: 2, cursor, sort: "popular" })), ArticleInputError);
      await assert.rejects(Promise.resolve().then(() => list({ limit: 2, cursor, offset: 2 })), ArticleInputError);
      await assert.rejects(Promise.resolve().then(() => list({ limit: 2, cursor: "not-a-cursor" })), ArticleInputError);
      await assert.rejects(Promise.resolve().then(() => list({ limit: 2, cursor: "" })), ArticleInputError);
    } finally {
      await runtime.cleanup(undefined, suffix);
    }
  });

  test(`${adapterName}: account roles default to member, ride on the profile, and cannot be self-assigned`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const editorId = `role-editor-${suffix}`;
    const targetId = `role-target-${suffix}`;
    const missingId = `role-missing-${suffix}`;
    try {
      // Absence of a record is absence of privilege, not an error: a brand-new
      // instance must not fail open just because the column is empty.
      assert.equal(await runtime.store.getUserRole({ userId: missingId }), "member");
      await runtime.store.upsertAuthorProfile({ userId: editorId, displayName: "Editor", locale: "zh-CN" });
      await runtime.store.upsertAuthorProfile({ userId: targetId, displayName: "Target", locale: "zh-CN" });
      assert.equal(await runtime.store.getUserRole({ userId: targetId }), "member");
      assert.equal((await runtime.store.getAuthorProfile({ userId: targetId, locale: "zh-CN" })).role, "member");

      assert.equal(await runtime.store.setUserRole({ actorId: editorId, userId: targetId, role: "editor" }), "editor");
      assert.equal(await runtime.store.getUserRole({ userId: targetId }), "editor");
      // The role rides along on the profile the client already fetches, so no
      // endpoint has to be added just to ask "may I show editorial controls?".
      assert.equal((await runtime.store.getAuthorProfile({ userId: targetId, locale: "zh-CN" })).role, "editor");

      // Assigning the same role again is a no-op, and promoting someone does not
      // quietly promote the actor.
      assert.equal(await runtime.store.setUserRole({ actorId: editorId, userId: targetId, role: "editor" }), "editor");
      assert.equal(await runtime.store.getUserRole({ userId: editorId }), "member");
      assert.equal(await runtime.store.setUserRole({ actorId: editorId, userId: targetId, role: "member" }), "member");
      assert.equal(await runtime.store.getUserRole({ userId: targetId }), "member");

      // ADR 0016, decision 3: nobody edits their own role, in either direction.
      await assert.rejects(Promise.resolve().then(() => runtime.store.setUserRole({ actorId: editorId, userId: editorId, role: "editor" })), ProfileInputError);
      await assert.rejects(Promise.resolve().then(() => runtime.store.setUserRole({ actorId: editorId, userId: editorId, role: "member" })), ProfileInputError);
      assert.equal(await runtime.store.getUserRole({ userId: editorId }), "member");

      // An unknown role is refused before it can reach the CHECK constraint, and
      // so is a role for an account that has no profile.
      await assert.rejects(Promise.resolve().then(() => runtime.store.setUserRole({ actorId: editorId, userId: targetId, role: "admin" })), ProfileInputError);
      await assert.rejects(Promise.resolve().then(() => runtime.store.setUserRole({ actorId: editorId, userId: targetId, role: "EDITOR" })), ProfileInputError);
      await assert.rejects(Promise.resolve().then(() => runtime.store.setUserRole({ actorId: editorId, userId: missingId, role: "editor" })), ProfileNotFoundError);
      await assert.rejects(Promise.resolve().then(() => runtime.store.setUserRole({ actorId: "  ", userId: targetId, role: "editor" })), ArticleInputError);
      await assert.rejects(Promise.resolve().then(() => runtime.store.setUserRole({ actorId: editorId, userId: "  ", role: "editor" })), ArticleInputError);
    } finally {
      await runtime.cleanup(undefined, suffix);
    }
  });

  test(`${adapterName}: the featured shelf is ordered, published-only, and editor-arranged`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const editorId = `featured-editor-${suffix}`;
    const memberId = `featured-member-${suffix}`;
    const blocks = [{ id: "p1", type: "paragraph", text: "Featured body." }];
    const publish = (slug, title) => runtime.store.createArticle({
      authorId: editorId, slug, title, summary: "", locale: "zh-CN", contentBlocks: blocks, publish: true,
    });
    const slugs = (articles) => articles.map((article) => article.slug);
    const shelf = () => runtime.store.listFeaturedArticles({ locale: "zh-CN" });
    const arrange = (actorId, articleIds) => runtime.store.setFeaturedArticles({ actorId, actorIsEditor: true, articleIds });
    try {
      await runtime.store.upsertAuthorProfile({ userId: editorId, displayName: "Editor", locale: "zh-CN" });
      const first = await publish(`featured-first-${suffix}`, "第一篇");
      const second = await publish(`featured-second-${suffix}`, "第二篇");
      const draft = await runtime.store.createArticle({
        authorId: editorId, slug: `featured-draft-${suffix}`, title: "草稿", summary: "",
        locale: "zh-CN", contentBlocks: blocks, publish: false,
      });

      // An empty shelf is an empty list, not an error.
      assert.deepEqual(await shelf(), []);

      // Only an editor arranges it, and only published work goes on it: a draft
      // on the public shelf is a promise the reader cannot collect.
      await assert.rejects(Promise.resolve().then(() => runtime.store.setFeaturedArticles({ actorId: memberId, articleIds: [first.id] })), ArticleAuthorizationError);
      await assert.rejects(Promise.resolve().then(() => arrange(editorId, [draft.id])), ArticleInputError);
      await assert.rejects(Promise.resolve().then(() => arrange(editorId, [first.id, first.id])), ArticleInputError);
      await assert.rejects(Promise.resolve().then(() => arrange(editorId, ["not-an-article"])), ArticleInputError);
      assert.deepEqual(await shelf(), []);

      // The order is the order the editor sent.
      await arrange(editorId, [first.id, second.id]);
      assert.deepEqual(slugs(await shelf()), [`featured-first-${suffix}`, `featured-second-${suffix}`]);
      // …and a later write replaces the whole shelf, so reordering, dropping one
      // and emptying it are all the same operation.
      await arrange(editorId, [second.id, first.id]);
      assert.deepEqual(slugs(await shelf()), [`featured-second-${suffix}`, `featured-first-${suffix}`]);
      await arrange(editorId, [first.id]);
      assert.deepEqual(slugs(await shelf()), [`featured-first-${suffix}`]);
      await arrange(editorId, []);
      assert.deepEqual(await shelf(), []);

      // A soft-deleted work stops being offered. The featured row survives, so
      // the work comes back to the place the editors gave it — but restoring puts
      // it in the drafts, not back on the front page, so it stays off the shelf
      // until its author publishes it again.
      await arrange(editorId, [first.id, second.id]);
      await runtime.store.deleteArticle({ articleId: first.id, actorId: editorId });
      assert.deepEqual(slugs(await shelf()), [`featured-second-${suffix}`]);
      const restored = await runtime.store.restoreArticle({ articleId: first.id, actorId: editorId });
      assert.equal(restored.status, "draft");
      assert.deepEqual(slugs(await shelf()), [`featured-second-${suffix}`]);
      await runtime.store.updateArticle({
        articleId: first.id, actorId: editorId, slug: restored.slug, title: "第一篇",
        locale: "zh-CN", contentBlocks: blocks, publish: true,
      });
      assert.deepEqual(slugs(await shelf()), [`featured-first-${suffix}`, `featured-second-${suffix}`]);

      // Pagination walks the shelf in the arranged order.
      const firstPage = await runtime.store.listFeaturedArticles({ locale: "zh-CN", limit: 1, offset: 0 });
      const secondPage = await runtime.store.listFeaturedArticles({ locale: "zh-CN", limit: 1, offset: 1 });
      assert.deepEqual(slugs(firstPage), [`featured-first-${suffix}`]);
      assert.deepEqual(slugs(secondPage), [`featured-second-${suffix}`]);
      // A locale with no translation has nothing to show.
      assert.deepEqual(await runtime.store.listFeaturedArticles({ locale: "en" }), []);
    } finally {
      await runtime.cleanup(undefined, suffix);
    }
  });

  test(`${adapterName}: a comment edit replaces the text, keeps the thread and is owner-only`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const slug = `contract-comment-edit-${suffix}`;
    const author = `comment-editor-${suffix}`;
    const stranger = `comment-stranger-${suffix}`;
    try {
      await runtime.store.createArticle({
        authorId: `edit-article-author-${suffix}`, slug, title: "Comment editing contract", summary: "",
        locale: "zh-CN", contentBlocks: [{ id: "p1", type: "paragraph", text: "Shared contract content." }], publish: true,
      });
      const comment = await runtime.store.createArticleComment({
        slug, locale: "zh-CN", actorId: author, content: "First wording of the thought.",
      });
      assert.equal(comment.editedAt, null, "a comment as written carries no edit marker");

      // Somebody else's comment is an authorization failure, not a silent no-op
      // and not a different answer that would reveal which ids exist.
      await assert.rejects(
        Promise.resolve().then(() => runtime.store.updateArticleComment({
          commentId: comment.id, actorId: stranger, content: "Somebody else's words now.",
        })),
        ArticleAuthorizationError,
      );

      const edited = await runtime.store.updateArticleComment({
        commentId: comment.id, actorId: author, locale: "zh-CN", content: "Second wording of the thought.",
      });
      assert.ok(edited, "an edit of an existing comment returns the row");
      assert.equal(edited.id, comment.id);
      assert.equal(edited.content, "Second wording of the thought.");
      assert.equal(edited.authorId, author, "an edit does not move a comment to another account");
      assert.equal(edited.parentCommentId, null, "an edit does not re-parent a comment");
      assert.equal(edited.createdAt, comment.createdAt, "an edit does not reorder the thread");
      assert.equal(typeof edited.editedAt, "string");
      assert.ok((edited.editedAt ?? "").length > 0);

      // The list read is the one the public page uses, so the correction must be
      // what a reader sees — and the marker must survive the projection.
      const listed = await runtime.store.listArticleComments({ slug, locale: "zh-CN" });
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.content, "Second wording of the thought.");
      assert.equal(typeof listed[0]?.editedAt, "string");

      // An edit that upgrades to the versioned block document keeps the two
      // content columns consistent; the schema check rejects a mismatch.
      const withBlocks = await runtime.store.updateArticleComment({
        commentId: comment.id, actorId: author, locale: "zh-CN", content: "Rich wording of the thought.",
        contentBlocks: [{ id: "p1", type: "paragraph", text: "Rich wording of the thought." }], contentBlocksVersion: 1,
      });
      assert.equal(withBlocks?.contentBlocksVersion, 1);
      assert.deepEqual(withBlocks?.contentBlocks, [{ id: "p1", type: "paragraph", text: "Rich wording of the thought." }]);

      // A comment that does not exist answers `null`: "not found" and "not yours"
      // stay distinguishable to the caller, and only the second is an error.
      assert.equal(await runtime.store.updateArticleComment({
        commentId: randomUUID(), actorId: author, content: "Nothing to edit.",
      }), null);

      // Deleting the edit's target removes it, and editing it afterwards is
      // `null` rather than a resurrected row.
      assert.equal(await runtime.store.deleteArticleComment({ commentId: comment.id, actorId: author }), true);
      assert.equal(await runtime.store.updateArticleComment({
        commentId: comment.id, actorId: author, content: "After deletion.",
      }), null);
    } finally { await runtime.cleanup(undefined, suffix); }
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


  test(`${adapterName}: cursors keep every same-millisecond row, then an empty page`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const authorId = `cursor-ms-author-${suffix}`;
    const ownerId = `cursor-ms-owner-${suffix}`;
    const sameMs = "2026-06-01T00:00:00.123Z";
    const newerMs = "2026-06-01T00:00:00.124Z";
    const olderMs = "2026-06-01T00:00:00.122Z";
    const intruderMs = "2026-06-01T00:00:00.125Z";
    const blocks = [{ id: "p1", type: "paragraph", text: "Cursor contract body." }];
    const hour = new Date(Date.now() + 3_600_000).toISOString();
    const account = (userId, seed) => ({
      userId,
      email: `cursor-ms-${seed}-${suffix}@example.test`,
      passwordHash: "hash-before",
      session: {
        sessionId: randomUUID(), userId, accessTokenId: randomUUID(),
        refreshHash: (seed + suffix.replace(/-/g, "")).padEnd(64, seed), expiresAt: hour,
        accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    });
    const newestFirst = (rows, timeKey) => [...rows].sort((a, b) => {
      const left = a[timeKey];
      const right = b[timeKey];
      if (left !== right) return left < right ? 1 : -1;
      return a.id < b.id ? 1 : -1;
    }).map((row) => row.id);
    await runtime.store.createIdentityAccount(account(ownerId, "a"));
    try {
      const articleRows = [];
      for (let index = 0; index < 5; index += 1) {
        const slug = `cursor-ms-work-${index}-${suffix}`;
        const created = await runtime.store.createArticle({
          authorId, slug, title: slug, summary: "", locale: "zh-CN", contentBlocks: blocks, publish: true,
        });
        articleRows.push({ id: created.id, slug, publishedAt: null });
      }
      // Assign times in descending-id order: the smallest id is newest and the
      // largest id is oldest, so UUID order and time order deliberately disagree.
      const articlesById = [...articleRows].sort((a, b) => a.id < b.id ? -1 : 1);
      [newerMs, sameMs, sameMs, sameMs, olderMs].forEach((at, index) => { articlesById[index].publishedAt = at; });
      for (const row of articleRows) await runtime.setArticlePublishedAt(row.slug, row.publishedAt);

      const mediaRows = [];
      for (let index = 0; index < 5; index += 1) {
        const id = randomUUID();
        await runtime.store.createMediaAsset({
          id, ownerId, storageKey: `assets/${ownerId}/${id}.webp`, contentType: "image/webp",
          byteSize: 2048, width: 20, height: 10, sha256: "c".repeat(64),
        });
        mediaRows.push({ id, createdAt: null });
      }
      const assetsById = [...mediaRows].sort((a, b) => a.id < b.id ? -1 : 1);
      [newerMs, sameMs, sameMs, sameMs, olderMs].forEach((at, index) => { assetsById[index].createdAt = at; });
      for (const row of mediaRows) await runtime.setMediaAssetCreatedAt(row.id, row.createdAt);

      const expectedArticleIds = newestFirst(articleRows, "publishedAt");
      const expectedMediaIds = newestFirst(mediaRows, "createdAt");
      const intruderSlug = `cursor-ms-intruder-${suffix}`;
      const intruderAssetId = randomUUID();
      let intruderArticleId = null;
      const insertIntruderArticle = async () => {
        const created = await runtime.store.createArticle({
          authorId, slug: intruderSlug, title: intruderSlug, summary: "", locale: "zh-CN",
          contentBlocks: blocks, publish: true,
        });
        intruderArticleId = created.id;
        await runtime.setArticlePublishedAt(intruderSlug, intruderMs);
      };
      const insertIntruderAsset = async () => {
        await runtime.store.createMediaAsset({
          id: intruderAssetId, ownerId, storageKey: `assets/${ownerId}/${intruderAssetId}.webp`,
          contentType: "image/webp", byteSize: 2048, width: 20, height: 10, sha256: "d".repeat(64),
        });
        await runtime.setMediaAssetCreatedAt(intruderAssetId, intruderMs);
      };

      const walkArticlePages = async () => {
        const seen = [];
        let cursor = null;
        let rows = await runtime.store.listPublishedArticles({ locale: "zh-CN", query: suffix, limit: 1, cursor });
        for (let index = 0; index < expectedArticleIds.length; index += 1) {
          const row = rows[0];
          assert.ok(row, `article page ${index + 1} exists`);
          seen.push(row.id);
          cursor = encodeArticleCursor(row.publishedAt, row.id);
          if (index === 0) await insertIntruderArticle();
          rows = await runtime.store.listPublishedArticles({ locale: "zh-CN", query: suffix, limit: 1, cursor });
        }
        assert.deepEqual(rows, [], "the article tail page is empty");
        assert.deepEqual([...seen].sort(), [...expectedArticleIds].sort(), "every article is read once");
        assert.equal(new Set(seen).size, expectedArticleIds.length, "no article is repeated");
        assert.ok(!seen.includes(intruderArticleId), "a newer insert does not rewind the cursor");
      };
      const walkMediaPages = async () => {
        const seen = [];
        let cursor = null;
        let rows = await runtime.store.listMediaAssets({ ownerId, cursor, limit: 1 });
        for (let index = 0; index < expectedMediaIds.length; index += 1) {
          const row = rows[0];
          assert.ok(row, `media page ${index + 1} exists`);
          seen.push(row.id);
          cursor = { at: new Date(row.createdAt).toISOString(), id: row.id };
          if (index === 0) await insertIntruderAsset();
          rows = await runtime.store.listMediaAssets({ ownerId, cursor, limit: 1 });
        }
        assert.deepEqual(rows, [], "the media tail page is empty");
        assert.deepEqual([...seen].sort(), [...expectedMediaIds].sort(), "every asset is read once");
        assert.equal(new Set(seen).size, expectedMediaIds.length, "no asset is repeated");
        assert.ok(!seen.includes(intruderAssetId), "a newer asset does not rewind the cursor");
      };
      await walkArticlePages();
      await walkMediaPages();
    } finally {
      await runtime.cleanup(undefined, suffix);
    }
  });


  /**
   * The batch port methods (#162).
   *
   * The list serializer now reads a page's authors and taxonomies with two
   * statements instead of three per article. That only holds if the batch
   * answer equals the per-article answer, so these assert equality directly
   * rather than spot-checking a field.
   */
  test(`${adapterName}: batch author profiles equal the per-user reads`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const authorIds = [`batch-author-a-${suffix}`, `batch-author-b-${suffix}`];
    const viewerId = `batch-viewer-${suffix}`;
    try {
      await runtime.store.upsertAuthorProfile({ userId: authorIds[0], displayName: "批量作者甲", bio: "简介甲", locale: "zh-CN" });
      await runtime.store.upsertAuthorProfile({ userId: authorIds[1], displayName: "批量作者乙", bio: "简介乙", locale: "zh-CN" });
      await runtime.store.followUser({ actorId: viewerId, targetUserId: authorIds[0] });

      const batched = await runtime.store.getAuthorProfilesByIds({ userIds: authorIds, locale: "zh-CN", viewerId });
      assert.deepEqual(Object.keys(batched).sort(), [...authorIds].sort());
      for (const userId of authorIds) {
        const single = await runtime.store.getAuthorProfile({ userId, locale: "zh-CN", viewerId });
        assert.deepEqual(batched[userId], single, `${userId}: batch and single must agree`);
      }
      // The viewer's follow state is part of the answer, per author, exactly as
      // the single call reports it.
      assert.equal(batched[authorIds[0]].isFollowing, true);
      assert.equal(batched[authorIds[1]].isFollowing, false);

      // Duplicates are the common case (a three-author page names each author
      // many times); the record must still be keyed by user id and not repeat
      // or drop anyone.
      const withDuplicates = await runtime.store.getAuthorProfilesByIds({
        userIds: [authorIds[0], authorIds[0], authorIds[1], authorIds[0]], locale: "zh-CN", viewerId: null,
      });
      assert.deepEqual(Object.keys(withDuplicates).sort(), [...authorIds].sort());

      // An empty page is a legitimate request: no ids in, no queries needed.
      assert.deepEqual(await runtime.store.getAuthorProfilesByIds({ userIds: [], locale: "zh-CN", viewerId: null }), {});
      // An unknown id is absent from the record rather than an error or a null.
      const missing = await runtime.store.getAuthorProfilesByIds({ userIds: [`batch-missing-${suffix}`], locale: "zh-CN", viewerId: null });
      assert.deepEqual(missing, {});

      // Locale selection is per request, matching the single read.
      await runtime.store.upsertAuthorProfile({ userId: authorIds[0], displayName: "Batch Author A", bio: "Bio A", locale: "en" });
      const english = await runtime.store.getAuthorProfilesByIds({ userIds: [authorIds[0]], locale: "en", viewerId: null });
      assert.equal(english[authorIds[0]].displayName, "Batch Author A");
      const chinese = await runtime.store.getAuthorProfilesByIds({ userIds: [authorIds[0]], locale: "zh-CN", viewerId: null });
      assert.equal(chinese[authorIds[0]].displayName, "批量作者甲");
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  test(`${adapterName}: batch article taxonomies equal the per-article reads`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const actorId = `batch-taxonomy-actor-${suffix}`;
    try {
      // Two taxonomies per kind, named so that ordering is observable: the
      // per-article query sorts by lowercased name then id, and the batch must
      // reproduce that within each article.
      const categories = [];
      for (const name of ["批次乙类", "批次甲类"]) {
        categories.push(await runtime.store.createTaxonomy({
          actorId, actorIsEditor: true, kind: "category",
          slug: `batch-cat-${name.endsWith("甲类") ? "a" : "b"}-${suffix}`,
          name, description: "", locale: "zh-CN",
        }));
      }
      const tag = await runtime.store.createTag({ actorId, name: `#批次标签${suffix.slice(0, 6)}`, locale: "zh-CN" });

      const first = await runtime.store.createArticle({
        authorId: actorId, slug: `batch-taxonomy-first-${suffix}`, title: "第一款", summary: "",
        locale: "zh-CN", contentBlocks: [{ id: "p1", type: "paragraph", text: "正文" }], publish: true,
        categoryIds: categories.map((item) => item.id), tagIds: [tag.id],
      });
      const second = await runtime.store.createArticle({
        authorId: actorId, slug: `batch-taxonomy-second-${suffix}`, title: "第二款", summary: "",
        locale: "zh-CN", contentBlocks: [{ id: "p1", type: "paragraph", text: "正文" }], publish: true,
        categoryIds: [categories[0].id], tagIds: [],
      });
      const third = await runtime.store.createArticle({
        authorId: actorId, slug: `batch-taxonomy-third-${suffix}`, title: "第三款", summary: "",
        locale: "zh-CN", contentBlocks: [{ id: "p1", type: "paragraph", text: "正文" }], publish: true,
      });
      const articleIds = [first.id, second.id, third.id];

      for (const kind of ["category", "tag"]) {
        const batched = await runtime.store.listArticlesTaxonomies({ articleIds, kind, locale: "zh-CN" });
        assert.deepEqual(Object.keys(batched).sort(), [...articleIds].sort(), `${kind}: every article is a key`);
        for (const articleId of articleIds) {
          const single = await runtime.store.listArticleTaxonomies({ articleId, kind, locale: "zh-CN" });
          assert.deepEqual(batched[articleId], single, `${kind}/${articleId}: batch and single must agree, including order`);
        }
        // An article with no taxonomies of the kind is an empty list, not absent.
        assert.deepEqual(batched[third.id], []);
        // And the duplicate-id case must not double any row.
        const duplicated = await runtime.store.listArticlesTaxonomies({ articleIds: [first.id, first.id], kind, locale: "zh-CN" });
        assert.deepEqual(duplicated[first.id], batched[first.id]);
      }
      assert.equal((await runtime.store.listArticlesTaxonomies({ articleIds, kind: "category", locale: "zh-CN" }))[first.id].length, 2, "both categories survived the batch");

      assert.deepEqual(await runtime.store.listArticlesTaxonomies({ articleIds: [], kind: "category", locale: "zh-CN" }), {});
    } finally { await runtime.cleanup(undefined, suffix); }
  });


  /**
   * The materialised media references (#163).
   *
   * The library used to answer "is this image an orphan?" by reading every work
   * body on the site. It now reads a table kept current by the writer's own
   * transaction. That trade is only sound if the table says exactly what the old
   * scan said, at every moment the scan could have been asked — so these assert
   * the *same* answer from `listReferencesForAssets` and from the full scan,
   * rather than checking that a row exists.
   */
  test(`${adapterName}: media references stay in step with the bodies that name them`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const ownerId = `media-ref-owner-${suffix}`;
    const hour = new Date(Date.now() + 3_600_000).toISOString();
    let articleId;
    try {
      await runtime.store.createIdentityAccount({
        userId: ownerId,
        email: `media-ref-${suffix}@example.test`,
        passwordHash: "hash",
        session: {
          sessionId: randomUUID(), userId: ownerId, accessTokenId: randomUUID(),
          refreshHash: (suffix.replace(/-/g, "") + "b").padEnd(64, "b"), expiresAt: hour,
          accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
      });
      const asset = await runtime.store.createMediaAsset({
        id: randomUUID(), ownerId, storageKey: `${suffix}/a.webp`, contentType: "image/webp",
        byteSize: 12, width: 2, height: 2, sha256: "c".repeat(64),
      });
      const bodyWithImage = [
        { id: "p1", type: "paragraph", text: "有图" },
        { id: "i1", type: "image", src: `/api/media/${asset.id}`, alt: "图" },
      ];

      const article = await runtime.store.createArticle({
        authorId: ownerId, slug: `media-ref-${suffix}`, title: "引用作品", summary: "",
        locale: "zh-CN", publish: true, contentBlocks: bodyWithImage,
      });
      articleId = article.id;

      const fromTable = await runtime.store.listReferencesForAssets({ assetIds: [asset.id] });
      assert.equal(fromTable.length, 1, "the create wrote one reference");
      const fromScan = (await runtime.store.listMediaScanRows()).filter((row) =>
        String(row?.content ?? "").toLowerCase().includes(asset.id.toLowerCase()));
      // Same number of uses, same work, same locale: the table is a substitute for
      // the scan, not a different opinion.
      assert.equal(fromTable.length, fromScan.length, "table and scan must agree on how many uses there are");
      assert.equal(fromTable[0].work.articleId, article.id);
      assert.equal(fromTable[0].work.locale, "zh-CN");
      assert.equal(fromTable[0].work.title, "引用作品");

      // Removing the image from the body must remove the reference in the same
      // transaction — this is the half a backfill cannot do.
      await runtime.store.updateArticle({
        articleId: article.id, actorId: ownerId, slug: article.slug, title: "引用作品",
        summary: "", locale: "zh-CN", publish: true,
        contentBlocks: [{ id: "p1", type: "paragraph", text: "图没了" }],
      });
      assert.deepEqual(await runtime.store.listReferencesForAssets({ assetIds: [asset.id] }), [], "an edit that drops the image drops the reference");

      // And adding a different image adds exactly that one.
      const second = await runtime.store.createMediaAsset({
        id: randomUUID(), ownerId, storageKey: `${suffix}/b.webp`, contentType: "image/webp",
        byteSize: 12, width: 2, height: 2, sha256: "d".repeat(64),
      });
      await runtime.store.updateArticle({
        articleId: article.id, actorId: ownerId, slug: article.slug, title: "引用作品",
        summary: "", locale: "zh-CN", publish: true,
        contentBlocks: [{ id: "i2", type: "image", src: `/api/v1/media/${second.id}`, alt: "新图" }],
      });
      const afterSecond = await runtime.store.listReferencesForAssets({ assetIds: [asset.id, second.id] });
      assert.equal(afterSecond.length, 1, "only the current image is referenced");
      assert.equal(afterSecond[0].work.articleId, article.id);

      // A body may name an id that was never uploaded here; the save must still
      // succeed and the phantom must not become a row.
      const phantom = randomUUID();
      await runtime.store.updateArticle({
        articleId: article.id, actorId: ownerId, slug: article.slug, title: "引用作品",
        summary: "", locale: "zh-CN", publish: true,
        contentBlocks: [{ id: "i3", type: "image", src: `/api/media/${phantom}`, alt: "外部" }],
      });
      assert.deepEqual(await runtime.store.listReferencesForAssets({ assetIds: [phantom] }), [], "an unknown id is not a reference row");

      // An empty page asks nothing and gets nothing.
      assert.deepEqual(await runtime.store.listReferencesForAssets({ assetIds: [] }), []);
    } finally {
      if (articleId) await runtime.cleanup(undefined, suffix);
    }
  });

  test(`${adapterName}: an avatar is a reference with no article behind it`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const ownerId = `avatar-ref-owner-${suffix}`;
    const hour = new Date(Date.now() + 3_600_000).toISOString();
    try {
      await runtime.store.createIdentityAccount({
        userId: ownerId,
        email: `avatar-ref-${suffix}@example.test`,
        passwordHash: "hash",
        session: {
          sessionId: randomUUID(), userId: ownerId, accessTokenId: randomUUID(),
          refreshHash: (suffix.replace(/-/g, "") + "e").padEnd(64, "e"), expiresAt: hour,
          accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
      });
      const asset = await runtime.store.createMediaAsset({
        id: randomUUID(), ownerId, storageKey: `${suffix}/face.webp`, contentType: "image/webp",
        byteSize: 12, width: 2, height: 2, sha256: "f".repeat(64),
      });
      // The avatar half is the one a body-only view misses entirely, which is how
      // a live account's picture used to be offered as an orphan.
      await runtime.store.upsertAuthorProfile({
        userId: ownerId, displayName: "头像作者", bio: "", locale: "zh-CN",
        avatarUrl: `/api/media/${asset.id}`,
      });
      const refs = await runtime.store.listReferencesForAssets({ assetIds: [asset.id] });
      assert.equal(refs.length, 1);
      assert.equal(refs[0].kind, "avatar", "an avatar is reported as an avatar, not as a work");

      // Clearing the avatar clears the reference.
      await runtime.store.upsertAuthorProfile({ userId: ownerId, displayName: "头像作者", bio: "", locale: "zh-CN", avatarUrl: null });
      assert.deepEqual(await runtime.store.listReferencesForAssets({ assetIds: [asset.id] }), []);
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  /**
   * #156: the database, not a read, decides whether an image is in use.
   *
   * Every check that reads and then writes has a window between the two. The
   * reference table (#163) made the check cheap; this makes it impossible to get
   * wrong, because `ON DELETE RESTRICT` is enforced by the DELETE itself. The
   * test does not simulate a race — it asserts the constraint directly, which is
   * what a race would end up hitting, and which no amount of retrying can slip
   * past.
   */
  test(`${adapterName}: the database refuses to delete an image a work still uses`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const ownerId = `restrict-owner-${suffix}`;
    const hour = new Date(Date.now() + 3_600_000).toISOString();
    try {
      await runtime.store.createIdentityAccount({
        userId: ownerId, email: `restrict-${suffix}@example.test`, passwordHash: "hash",
        session: {
          sessionId: randomUUID(), userId: ownerId, accessTokenId: randomUUID(),
          refreshHash: (suffix.replace(/-/g, "") + "c").padEnd(64, "c"), expiresAt: hour,
          accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
      });
      const asset = await runtime.store.createMediaAsset({
        id: randomUUID(), ownerId, storageKey: `${suffix}/r.webp`, contentType: "image/webp",
        byteSize: 12, width: 2, height: 2, sha256: "d".repeat(64),
      });
      const article = await runtime.store.createArticle({
        authorId: ownerId, slug: `restrict-${suffix}`, title: "在用图片", summary: "",
        locale: "zh-CN", publish: true,
        contentBlocks: [{ id: "i1", type: "image", src: `/api/media/${asset.id}`, alt: "图" }],
      });

      // The guarded delete reports it as in use rather than deleting it.
      const refused = await runtime.store.deleteUnusedMediaAsset({ id: asset.id, ownerId });
      assert.equal(refused?.deleted ?? null, null, "an in-use image is not deleted");
      assert.ok((refused?.usedBy ?? []).length > 0, "and the caller is told what uses it");

      // Deleting the work first releases it, and then the same call succeeds.
      await runtime.store.deleteArticle({ articleId: article.id, actorId: ownerId });
      await runtime.store.purgeExpiredArticles({
        retentionDays: 30, now: new Date(Date.now() + 400 * 86_400_000), limit: 100,
      });
      const allowed = await runtime.store.deleteUnusedMediaAsset({ id: asset.id, ownerId });
      assert.equal(allowed?.deleted?.id, asset.id, "once nothing references it, the delete goes through");
    } finally { await runtime.cleanup(undefined, suffix); }
  });

  /**
   * #156, the half that was missing entirely: an avatar is a reference too, and
   * it used to be `ON DELETE SET NULL`, so deleting someone's picture succeeded
   * and silently blanked the avatar.
   */
  test(`${adapterName}: the database refuses to delete an image in use as an avatar`, options, async () => {
    const runtime = await fixture();
    const suffix = randomUUID();
    const ownerId = `restrict-avatar-owner-${suffix}`;
    const hour = new Date(Date.now() + 3_600_000).toISOString();
    try {
      await runtime.store.createIdentityAccount({
        userId: ownerId, email: `restrict-avatar-${suffix}@example.test`, passwordHash: "hash",
        session: {
          sessionId: randomUUID(), userId: ownerId, accessTokenId: randomUUID(),
          refreshHash: (suffix.replace(/-/g, "") + "d").padEnd(64, "d"), expiresAt: hour,
          accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
      });
      const asset = await runtime.store.createMediaAsset({
        id: randomUUID(), ownerId, storageKey: `${suffix}/face.webp`, contentType: "image/webp",
        byteSize: 12, width: 2, height: 2, sha256: "e".repeat(64),
      });
      await runtime.store.upsertAuthorProfile({
        userId: ownerId, displayName: "头像作者", bio: "", locale: "zh-CN",
        avatarUrl: `/api/media/${asset.id}`,
      });

      const refused = await runtime.store.deleteUnusedMediaAsset({ id: asset.id, ownerId });
      assert.equal(refused?.deleted ?? null, null, "an avatar image is not deleted");
      assert.ok((refused?.usedBy ?? []).some((entry) => entry.kind === "avatar"), "and it is reported as an avatar");

      // Clearing the avatar releases the image.
      await runtime.store.upsertAuthorProfile({ userId: ownerId, displayName: "头像作者", bio: "", locale: "zh-CN", avatarUrl: null });
      const allowed = await runtime.store.deleteUnusedMediaAsset({ id: asset.id, ownerId });
      assert.equal(allowed?.deleted?.id, asset.id, "after the avatar is cleared, the delete goes through");
    } finally { await runtime.cleanup(undefined, suffix); }
  });

}

registerAdapterContracts("SQLite", sqliteFixture);
registerAdapterContracts(
  "PostgreSQL",
  postgresFixture,
  { skip: !connectionString && "Set TEST_DATABASE_URL to run PostgreSQL persistence contracts." },
);
