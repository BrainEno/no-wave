import { createHash, randomUUID } from "node:crypto";
import {
  articleIdempotencyFingerprint,
  articleIdempotencyKeyHash,
  articleIdempotencyReplayMatches,
} from "../application/article-idempotency.ts";
import { createMigrationTransactionId } from "./provider-migration-journal.ts";
import { createPostgresProviderMigrationCapture, migrationEntityKey } from "./postgres-provider-migration-capture.ts";
import {
  IdempotencyConflictError,
  ConversationAccessError,
  ConversationInputError,
  ConversationNotFoundError,
  InvalidMessageCursorError,
  ArticleInputError,
  ArticleSlugConflictError,
  ArticleAuthorizationError,
  ArticleNotFoundError,
  ProfileInputError,
  ProfileNotFoundError,
  TaxonomyConflictError,
  TaxonomyNotFoundError,
} from "../domain/errors.ts";
import { normalizeHashtag, validateTaxonomyKind } from "../domain/taxonomy.ts";
import {
  validateArticleLocale,
  validateArticleSlug,
  normalizeArticleInput,
  normalizeTaxonomyIds,
  MAX_FEATURED_ARTICLES,
  resolveArticleCursor,
} from "../domain/article.ts";
import {
  AUTHOR_OFFSET_MAX,
  AUTHOR_QUERY_MAX_LENGTH,
  normalizeStoredRole,
  validateUserRole,
} from "../domain/profile.ts";
import { validateStoredCommentContent } from "../domain/comment-content.ts";
import { isUuid, requiredText } from "../domain/validation.ts";
import { normalizeParticipantIds } from "../domain/conversation.ts";
import { validateProfileUrl } from "../domain/profile.ts";
import { assertOutboxLease } from "./outbox-lease.ts";
import { requestHash, parseJsonValue, isoDate } from "./postgres-helpers.ts";
import type { TypedPersistenceAdapterContract } from "../application/persistence-ports.ts";

function mapAuthorProfile(row) {
  const iso = (value) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  return {
    userId: row.user_id,
    role: normalizeStoredRole(row.role),
    displayName: row.display_name,
    bio: row.bio,
    avatarUrl: row.avatar_url,
    websiteUrl: row.website_url,
    locale: row.locale,
    followerCount: Number(row.follower_count ?? 0),
    followingCount: Number(row.following_count ?? 0),
    isFollowing: Boolean(row.is_following_viewer ?? false),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
/**
 * The featured shelf, in the order the editors put it in. Defined outside the
 * returned object so the writer can re-read it after its transaction commits
 * without re-entering the transaction — a read inside the open transaction would
 * either take a second connection or see its own uncommitted rows only.
 */
async function findAuthorProfile(executor, { userId, locale = "zh-CN", viewerId = null }) {
  requiredText("userId", userId, 300);
  validateArticleLocale(locale);
  if (viewerId !== null) requiredText("viewerId", viewerId, 300);
  const rows = await executor.unsafe(
    `SELECT p.user_id, p.role, p.avatar_url, p.website_url, p.created_at,
            GREATEST(p.updated_at, translated.updated_at) AS updated_at,
            translated.display_name, translated.bio, translated.locale,
            (SELECT count(*)::int FROM user_follows f WHERE f.followed_id = p.user_id) AS follower_count,
            (SELECT count(*)::int FROM user_follows f WHERE f.follower_id = p.user_id) AS following_count,
            CASE WHEN $3::text IS NULL THEN false ELSE EXISTS(
              SELECT 1 FROM user_follows f WHERE f.follower_id = $3 AND f.followed_id = p.user_id
            ) END AS is_following_viewer
     FROM user_profiles AS p
     JOIN LATERAL (
       SELECT t.display_name, t.bio, t.locale, t.updated_at
       FROM user_profile_translations AS t
       WHERE t.user_id = p.user_id
       ORDER BY (t.locale = $2) DESC, (t.locale = 'zh-TW') DESC, t.locale
       LIMIT 1
     ) AS translated ON true
     WHERE p.user_id = $1
     LIMIT 1`,
    [userId, locale, viewerId],
  );
  return rows[0] ? mapAuthorProfile(rows[0]) : null;
}
async function listRelatedProfiles(executor, { relationship, userId, locale = "zh-CN", viewerId = null, limit = 50 }) {
  requiredText("userId", userId, 300);
  validateArticleLocale(locale);
  if (viewerId !== null) requiredText("viewerId", viewerId, 300);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ProfileInputError("limit must be an integer between 1 and 100.");
  const join = relationship === "following"
    ? "relation.follower_id = $1 AND relation.followed_id = p.user_id"
    : "relation.followed_id = $1 AND relation.follower_id = p.user_id";
  const rows = await executor.unsafe(
    `SELECT p.user_id, p.role, p.avatar_url, p.website_url, p.created_at,
            GREATEST(p.updated_at, translated.updated_at) AS updated_at,
            translated.display_name, translated.bio, translated.locale,
            (SELECT count(*)::int FROM user_follows f WHERE f.followed_id = p.user_id) AS follower_count,
            (SELECT count(*)::int FROM user_follows f WHERE f.follower_id = p.user_id) AS following_count,
            CASE WHEN $3::text IS NULL THEN false ELSE EXISTS(
              SELECT 1 FROM user_follows f WHERE f.follower_id = $3 AND f.followed_id = p.user_id
            ) END AS is_following_viewer
     FROM user_follows AS relation
     JOIN user_profiles AS p ON ${join}
     JOIN LATERAL (
       SELECT t.display_name, t.bio, t.locale, t.updated_at
       FROM user_profile_translations AS t
       WHERE t.user_id = p.user_id
       ORDER BY (t.locale = $2) DESC, (t.locale = 'zh-TW') DESC, t.locale
       LIMIT 1
     ) AS translated ON true
     ORDER BY relation.created_at DESC, p.user_id
     LIMIT $4`,
    [userId, locale, viewerId, limit],
  );
  return rows.map(mapAuthorProfile);
}


export function createPostgresProfileStore(sql: any): Partial<TypedPersistenceAdapterContract> {
  if (!sql || typeof sql.unsafe !== "function" || typeof sql.begin !== "function") {
    throw new TypeError("A postgres.js SQL client is required.");
  }
  const migrationCapture = createPostgresProviderMigrationCapture(sql);
    async function captureChanges(tx, transactionId, changes) {
    await migrationCapture.captureInTransaction(tx, transactionId, changes);
  }

  return Object.freeze({
    async getAuthorProfile({ userId, locale = "zh-CN", viewerId = null }) {
      return findAuthorProfile(sql, { userId, locale, viewerId });
    },
    /**
     * The one permission question the platform asks: may this account curate?
     * A profile that does not exist answers `member` — absence of a record is
     * absence of privilege, never a reason to fail open.
     */
    async getUserRole({ userId }) {
      requiredText("userId", userId, 300);
      const rows = await sql.unsafe("SELECT role FROM user_profiles WHERE user_id = $1 LIMIT 1", [userId]);
      return normalizeStoredRole(rows[0]?.role);
    },
    async setUserRole({ actorId, userId, role }) {
      requiredText("actorId", actorId, 300);
      requiredText("userId", userId, 300);
      const validatedRole = validateUserRole(role);
      // ADR 0016, decision 3: nobody edits their own role. A single-editor
      // instance whose editor demotes themselves has no way back in.
      if (actorId === userId) throw new ProfileInputError("You cannot change your own role.");
      return sql.begin(async (tx) => {
        const transactionId = createMigrationTransactionId();
        const existing = await tx.unsafe("SELECT user_id FROM user_profiles WHERE user_id = $1 LIMIT 1", [userId]);
        if (!existing[0]) throw new ProfileNotFoundError();
        await tx.unsafe("UPDATE user_profiles SET role = $2, updated_at = now() WHERE user_id = $1", [userId, validatedRole]);
        const rows = await tx.unsafe("SELECT * FROM user_profiles WHERE user_id = $1", [userId]);
        await captureChanges(tx, transactionId, [
          { entityType: "user_profiles", entityId: userId, operation: "upsert", payload: rows[0] },
        ]);
        return normalizeStoredRole(rows[0]?.role);
      });
    },
    /**
     * The public author directory and its search (ADR 0024).
     *
     * The SQLite provider carries the reasoning in full; this is the same query
     * in PostgreSQL: published-in-this-locale only, relevance first when there
     * is a term, reach first when there is not.
     */
    async searchAuthors({ query = "", locale = "zh-CN", limit = 20, offset = 0 }) {
      validateArticleLocale(locale);
      if (typeof query !== "string" || query.length > AUTHOR_QUERY_MAX_LENGTH) {
        throw new ProfileInputError(`query must be a string no longer than ${AUTHOR_QUERY_MAX_LENGTH} characters.`);
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new ProfileInputError("limit must be an integer between 1 and 100.");
      }
      if (!Number.isInteger(offset) || offset < 0 || offset > AUTHOR_OFFSET_MAX) {
        throw new ProfileInputError(`offset must be an integer between 0 and ${AUTHOR_OFFSET_MAX}.`);
      }
      const term = query.trim().toLocaleLowerCase(locale);
      const params: unknown[] = [locale, locale, locale];
      let text = `SELECT p.user_id, translated.display_name, translated.bio, translated.locale,
              (SELECT count(*)::int FROM user_follows f WHERE f.followed_id = p.user_id) AS follower_count,
              (SELECT count(*)::int FROM article_translations t JOIN articles a ON a.id = t.article_id
                WHERE a.author_id = p.user_id AND a.status = 'published' AND t.locale = $1) AS work_count
         FROM user_profiles AS p
         JOIN LATERAL (
           SELECT t.display_name, t.bio, t.locale
           FROM user_profile_translations AS t
           WHERE t.user_id = p.user_id
           ORDER BY (t.locale = $2) DESC, (t.locale = 'zh-TW') DESC, t.locale
           LIMIT 1
         ) AS translated ON true
         WHERE EXISTS (
           SELECT 1 FROM articles a JOIN article_translations t ON t.article_id = a.id
           WHERE a.author_id = p.user_id AND a.status = 'published' AND t.locale = $3
         )`;
      if (term) {
        text += " AND (position($4 in lower(translated.display_name)) > 0 OR position($4 in lower(p.user_id)) > 0)";
        params.push(term);
      }
      // Relevance, then reach: an exact name first, then one that starts with
      // the term, then the author more readers already follow.
      const order = term
        ? "ORDER BY (lower(translated.display_name) = $5) DESC, (lower(translated.display_name) LIKE $6) DESC, follower_count DESC, lower(translated.display_name), p.user_id"
        : "ORDER BY follower_count DESC, lower(translated.display_name), p.user_id";
      if (term) params.push(term, `${term}%`);
      text += ` ${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(limit, offset);
      const rows = await sql.unsafe(text, params);
      return rows.map((row) => ({
        userId: row.user_id,
        displayName: row.display_name,
        bio: row.bio ?? "",
        locale: row.locale,
        followerCount: Number(row.follower_count ?? 0),
        workCount: Number(row.work_count ?? 0),
      }));
    },
    async searchUsers({ query, locale = "zh-CN", viewerId = null, limit = 20 }) {
      validateArticleLocale(locale);
      if (typeof query !== "string" || query.trim().length === 0 || query.length > 100) {
        throw new ProfileInputError("query must be non-empty and no longer than 100 characters.");
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ProfileInputError("limit must be an integer between 1 and 100.");
      if (viewerId !== null) requiredText("viewerId", viewerId, 300);
      const term = query.trim().toLocaleLowerCase(locale);
      const rows = await sql.unsafe(
        `SELECT p.user_id, p.role, p.avatar_url, p.website_url, p.created_at,
                GREATEST(p.updated_at, translated.updated_at) AS updated_at,
                translated.display_name, translated.bio, translated.locale,
                (SELECT count(*)::int FROM user_follows f WHERE f.followed_id = p.user_id) AS follower_count,
                (SELECT count(*)::int FROM user_follows f WHERE f.follower_id = p.user_id) AS following_count,
                CASE WHEN $3::text IS NULL THEN false ELSE EXISTS(
                  SELECT 1 FROM user_follows f WHERE f.follower_id = $3 AND f.followed_id = p.user_id
                ) END AS is_following_viewer
         FROM user_profiles AS p
         JOIN LATERAL (
           SELECT t.display_name, t.bio, t.locale, t.updated_at
           FROM user_profile_translations AS t
           WHERE t.user_id = p.user_id
           ORDER BY (t.locale = $2) DESC, (t.locale = 'zh-TW') DESC, t.locale
           LIMIT 1
         ) AS translated ON true
         WHERE position($1 in lower(translated.display_name)) > 0
            OR position($1 in lower(p.user_id)) > 0
         ORDER BY lower(translated.display_name), p.user_id
         LIMIT $4`,
        [term, locale, viewerId, limit],
      );
      return rows.map(mapAuthorProfile);
    },
    async listFollowing({ userId, locale = "zh-CN", viewerId = null, limit = 50 }) {
      return listRelatedProfiles(sql, { relationship: "following", userId, locale, viewerId, limit });
    },
    async listFollowers({ userId, locale = "zh-CN", viewerId = null, limit = 50 }) {
      return listRelatedProfiles(sql, { relationship: "followers", userId, locale, viewerId, limit });
    },
    async followUser({ actorId, targetUserId }) {
      requiredText("actorId", actorId, 300);
      requiredText("targetUserId", targetUserId, 300);
      if (actorId === targetUserId) throw new ProfileInputError("You cannot follow your own account.");
      return sql.begin(async (tx) => {
        const transactionId = createMigrationTransactionId();
        const changes = [];
        const target = await tx.unsafe("SELECT user_id FROM user_profiles WHERE user_id = $1", [targetUserId]);
        if (target.length === 0) throw new ProfileNotFoundError();
        const inserted = await tx.unsafe(
          "INSERT INTO user_follows (follower_id, followed_id) VALUES ($1, $2) ON CONFLICT (follower_id, followed_id) DO NOTHING RETURNING follower_id",
          [actorId, targetUserId],
        );
        if (inserted.length === 1) {
          const followRows = await tx.unsafe("SELECT * FROM user_follows WHERE follower_id = $1 AND followed_id = $2", [actorId, targetUserId]);
          changes.push({ entityType: "user_follows", entityId: migrationEntityKey(actorId, targetUserId), operation: "upsert", payload: followRows[0] });
          const payload = { type: "user.followed", followerId: actorId };
          const eventKey = `user.followed:${actorId}:${randomUUID()}`;
          await tx.unsafe(
            "INSERT INTO notifications (id, user_id, event_key, payload, payload_hash) VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT (user_id, event_key) DO NOTHING",
            [randomUUID(), targetUserId, eventKey, payload, requestHash(payload)],
          );
          const notificationRows = await tx.unsafe("SELECT * FROM notifications WHERE user_id = $1 AND event_key = $2", [targetUserId, eventKey]);
          if (notificationRows[0]) changes.push({ entityType: "notifications", entityId: notificationRows[0].id, operation: "upsert", payload: notificationRows[0] });
        }
        await captureChanges(tx, transactionId, changes);
        return inserted.length === 1;
      });
    },
    async unfollowUser({ actorId, targetUserId }) {
      requiredText("actorId", actorId, 300);
      requiredText("targetUserId", targetUserId, 300);
      if (actorId === targetUserId) throw new ProfileInputError("You cannot unfollow your own account.");
      return sql.begin(async (tx) => {
        const transactionId = createMigrationTransactionId();
        const rows = await tx.unsafe(
          "DELETE FROM user_follows WHERE follower_id = $1 AND followed_id = $2 RETURNING follower_id",
          [actorId, targetUserId],
        );
        if (rows.length === 1) await captureChanges(tx, transactionId, [
          { entityType: "user_follows", entityId: migrationEntityKey(actorId, targetUserId), operation: "delete", payload: null },
        ]);
        return rows.length === 1;
      });
    },
    async upsertAuthorProfile({ userId, displayName, bio = "", avatarUrl = undefined, websiteUrl = undefined, locale = "zh-CN" }) {
      requiredText("userId", userId, 300);
      requiredText("displayName", displayName, 120);
      if (typeof bio !== "string" || bio.length > 5000) {
        throw new ProfileInputError("bio must be a string no longer than 5000 characters.");
      }
      validateArticleLocale(locale);
      const validatedAvatarUrl = validateProfileUrl("avatarUrl", avatarUrl, true);
      const validatedWebsiteUrl = validateProfileUrl("websiteUrl", websiteUrl, false);
      return sql.begin(async (tx) => {
        const transactionId = createMigrationTransactionId();
        await tx.unsafe(
          "INSERT INTO user_profiles (user_id, avatar_url, website_url) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET avatar_url = CASE WHEN $4 THEN $2 ELSE user_profiles.avatar_url END, website_url = CASE WHEN $5 THEN $3 ELSE user_profiles.website_url END, updated_at = now()",
          [userId, validatedAvatarUrl ?? null, validatedWebsiteUrl ?? null, avatarUrl !== undefined, websiteUrl !== undefined],
        );
        await tx.unsafe(
          "INSERT INTO user_profile_translations (user_id, locale, display_name, bio) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, locale) DO UPDATE SET display_name = EXCLUDED.display_name, bio = EXCLUDED.bio, updated_at = now()",
          [userId, locale, displayName, bio],
        );
        const rows = await tx.unsafe(
          "SELECT p.user_id, p.role, p.avatar_url, p.website_url, p.created_at, GREATEST(p.updated_at, t.updated_at) AS updated_at, t.display_name, t.bio, t.locale FROM user_profiles AS p JOIN user_profile_translations AS t ON t.user_id = p.user_id WHERE p.user_id = $1 AND t.locale = $2 LIMIT 1",
          [userId, locale],
        );
        if (!rows[0]) throw new Error("Profile row was not available after upsert.");
        const [profileRows, translationRows] = await Promise.all([
          tx.unsafe("SELECT * FROM user_profiles WHERE user_id = $1", [userId]),
          tx.unsafe("SELECT * FROM user_profile_translations WHERE user_id = $1 AND locale = $2", [userId, locale]),
        ]);
        await captureChanges(tx, transactionId, [
          { entityType: "user_profiles", entityId: userId, operation: "upsert", payload: profileRows[0] },
          { entityType: "user_profile_translations", entityId: migrationEntityKey(userId, locale), operation: "upsert", payload: translationRows[0] },
        ]);
        return mapAuthorProfile(rows[0]);
      });
    },
  });
}
