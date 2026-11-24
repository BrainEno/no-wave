/**
 * Fixtures for the persistence adapter contract suites. Not a test file: node:test discovers
 * only `*.test.ts`, and each suite registers its own tests against these fixtures.
 */
import { after, before } from "node:test";
import { createPostgresClient, createPostgresStore } from "../postgres.ts";
import { createSqliteClient, runSqliteMigrations } from "../sqlite.ts";
import { createSqliteStore } from "../sqlite-store.ts";
import { runMigrations } from "../migrate.ts";

/**
 * Connection state for the PostgreSQL engine. Each suite file runs in its own
 * process and calls {@link registerPostgresStore} once; the bindings below are live,
 * so a suite reads whatever the lifecycle hook connected.
 */
export const connectionString = process.env.TEST_DATABASE_URL;
export let postgresSql!: Awaited<ReturnType<typeof createPostgresClient>>;
export let postgresStore: ReturnType<typeof createPostgresStore> | undefined;

/** Connect once before, and close after, the PostgreSQL contracts of this file. */
export function registerPostgresStore(): void {
  before(async () => {
    if (!connectionString) return;
    postgresSql = await createPostgresClient({ connectionString, max: 4 });
    await runMigrations(postgresSql);
    postgresStore = createPostgresStore(postgresSql);
  });

  after(async () => {
    if (postgresSql) await postgresSql.end({ timeout: 5 });
  });
}

/** Run one contract registration for both engines, in the original order. */
export function registerForEngines(
  register: (
    adapterName: string,
    fixture: () => Promise<unknown>,
    options?: { skip?: string | false },
  ) => void,
): void {
  register("SQLite", sqliteFixture);
  register("PostgreSQL", postgresFixture, {
    skip: !connectionString && "Set TEST_DATABASE_URL to run PostgreSQL persistence contracts.",
  });
}

export async function sqliteFixture() {
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
    async makeOutboxAvailable(eventId: string) {
      db.prepare("UPDATE outbox_events SET available_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", eventId);
    },
    async outboxAvailableAt(eventId: string) {
      return new Date((db.prepare("SELECT available_at FROM outbox_events WHERE id = ?").get(eventId) as { available_at: string }).available_at).toISOString();
    },
    async setArticlePublishedAt(slug: string, publishedAt: string) {
      db.prepare("UPDATE articles SET published_at = ? WHERE slug = ?").run(publishedAt, slug);
    },
    async setArticleDeletedAt(id: string, deletedAt: string) {
      db.prepare("UPDATE articles SET deleted_at = ? WHERE id = ?").run(deletedAt, id);
    },
    /**
     * Write the type directly, bypassing the store.
     *
     * Writes below the contract, to prove the database refuses a folded work
     * type on its own (ADR 0054), not only the store.
     */
    async setArticleWorkType(id: string, workType: string) {
      db.prepare("UPDATE articles SET work_type = ? WHERE id = ?").run(workType, id);
    },
    async articleWorkType(id: string) {
      return (db.prepare("SELECT work_type FROM articles WHERE id = ?").get(id) as { work_type: string }).work_type;
    },
    async setMediaAssetCreatedAt(id: string, createdAt: string) {
      db.prepare("UPDATE media_assets SET created_at = ? WHERE id = ?").run(createdAt, id);
    },
    /**
     * Pin a notification's stored time.
     *
     * The inbox is ordered by `(created_at, id)`, and the interesting cases are
     * rows that share a millisecond — which `now()` will not produce on demand.
     */
    async setNotificationCreatedAt(id: string, createdAt: string) {
      db.prepare("UPDATE notifications SET created_at = ? WHERE id = ?").run(createdAt, id);
    },
    /**
     * Pin a comment's stored time.
     *
     * A thread pages by `(created_at, id)`, and the cases that matter are roots
     * sharing one millisecond — which `now()` will not produce on demand — and a
     * cursor that lands inside such a millisecond.
     */
    async setArticleCommentCreatedAt(id: string, createdAt: string) {
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
    async dropMediaReference(assetId: string) {
      db.prepare("DELETE FROM article_media_refs WHERE asset_id = ?").run(assetId);
    },
    async clearAvatarMediaId(userId: string) {
      db.prepare("UPDATE user_profiles SET avatar_media_id = NULL WHERE user_id = ?").run(userId);
    },
    async cleanup(conversationId?: string, suffix?: string) {
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

export async function postgresFixture() {
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
    async makeOutboxAvailable(eventId: string) {
      await postgresSql.unsafe("UPDATE outbox_events SET available_at = '2000-01-01T00:00:00Z' WHERE id = $1", [eventId]);
    },
    async outboxAvailableAt(eventId: string) {
      const [row] = await postgresSql.unsafe("SELECT available_at FROM outbox_events WHERE id = $1", [eventId]);
      return new Date(row.available_at).toISOString();
    },
    async setArticlePublishedAt(slug: string, publishedAt: string) {
      await postgresSql.unsafe("UPDATE articles SET published_at = $1 WHERE slug = $2", [publishedAt, slug]);
    },
    async setArticleDeletedAt(id: string, deletedAt: string) {
      await postgresSql.unsafe("UPDATE articles SET deleted_at = $1 WHERE id = $2", [deletedAt, id]);
    },
    async setArticleWorkType(id: string, workType: string) {
      await postgresSql.unsafe("UPDATE articles SET work_type = $2 WHERE id = $1", [id, workType]);
    },
    async articleWorkType(id: string) {
      const [row] = await postgresSql.unsafe("SELECT work_type FROM articles WHERE id = $1", [id]);
      return row.work_type;
    },
    async setMediaAssetCreatedAt(id: string, createdAt: string) {
      await postgresSql.unsafe("UPDATE media_assets SET created_at = $1 WHERE id = $2", [createdAt, id]);
    },
    async setNotificationCreatedAt(id: string, createdAt: string) {
      await postgresSql.unsafe("UPDATE notifications SET created_at = $1 WHERE id = $2", [createdAt, id]);
    },
    async setArticleCommentCreatedAt(id: string, createdAt: string) {
      await postgresSql.unsafe("UPDATE article_comments SET created_at = $1 WHERE id = $2", [createdAt, id]);
    },
    async dropMediaReference(assetId: string) {
      await postgresSql.unsafe("DELETE FROM article_media_refs WHERE asset_id = $1", [assetId]);
    },
    async clearAvatarMediaId(userId: string) {
      await postgresSql.unsafe("UPDATE user_profiles SET avatar_media_id = NULL WHERE user_id = $1", [userId]);
    },
    async cleanup(conversationId?: string, suffix?: string) {
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
