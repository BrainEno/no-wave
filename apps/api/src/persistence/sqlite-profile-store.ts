import { createHash, randomUUID } from "node:crypto";
import { createMigrationTransactionId } from "./provider-migration-journal.ts";
import { createSqliteProviderMigrationCapture, migrationEntityKey } from "./sqlite-provider-migration-capture.ts";
import {
  ProfileInputError,
  ProfileNotFoundError,
} from "../domain/errors.ts";
import { validateArticleLocale } from "../domain/article.ts";
import { requiredText } from "../domain/validation.ts";
import { validateProfileUrl } from "../domain/profile.ts";

/**
 * SQLite implementation of the author-profile and follow persistence slice.
 * This is intentionally not a complete persistence adapter and is not wired
 * into runtime until every persistence port has behavioral parity.
 */
export function createSqliteProfileStore(db) {
  if (!db || typeof db.prepare !== "function" || typeof db.exec !== "function") {
    throw new TypeError("A node:sqlite DatabaseSync connection is required.");
  }
  const run = (sql, ...params) => db.prepare(sql).run(...params);
  const get = (sql, ...params) => db.prepare(sql).get(...params);
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const migrationCapture = createSqliteProviderMigrationCapture(db);
  const transaction = (fn) => {
    const transactionId = createMigrationTransactionId();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn(transactionId);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  };
  const requestHash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const profileSelect = `
    SELECT p.user_id, p.avatar_url, p.website_url, p.created_at,
      MAX(p.updated_at, translated.updated_at) AS updated_at,
      translated.display_name, translated.bio, translated.locale,
      (SELECT count(*) FROM user_follows f WHERE f.followed_id = p.user_id) AS follower_count,
      (SELECT count(*) FROM user_follows f WHERE f.follower_id = p.user_id) AS following_count,
      CASE WHEN ? IS NULL THEN 0 ELSE EXISTS(
        SELECT 1 FROM user_follows f WHERE f.follower_id = ? AND f.followed_id = p.user_id
      ) END AS is_following_viewer
    FROM user_profiles p
    JOIN user_profile_translations translated ON translated.user_id = p.user_id
      AND translated.locale = (
        SELECT t.locale FROM user_profile_translations t
        WHERE t.user_id = p.user_id
        ORDER BY CASE WHEN t.locale = ? THEN 0 WHEN t.locale = 'zh-TW' THEN 1 ELSE 2 END, t.locale
        LIMIT 1
      )`;
  function mapProfile(row) {
    const iso = (value) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
    return {
      userId: row.user_id,
      displayName: row.display_name,
      bio: row.bio,
      avatarUrl: row.avatar_url,
      websiteUrl: row.website_url,
      locale: row.locale,
      followerCount: Number(row.follower_count ?? 0),
      followingCount: Number(row.following_count ?? 0),
      isFollowing: Boolean(row.is_following_viewer),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }
  function profileById(userId, locale, viewerId) {
    return get(
      `${profileSelect} WHERE p.user_id = ? LIMIT 1`,
      viewerId, viewerId, locale, userId,
    );
  }
  function validateViewer(viewerId) {
    if (viewerId !== null) requiredText("viewerId", viewerId, 300);
  }
  function listRelatedProfiles({ relationship, userId, locale = "zh-CN", viewerId = null, limit = 50 }) {
    requiredText("userId", userId, 300);
    validateArticleLocale(locale);
    validateViewer(viewerId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ProfileInputError("limit must be an integer between 1 and 100.");
    }
    const join = relationship === "following"
      ? "relation.follower_id = ? AND relation.followed_id = p.user_id"
      : "relation.followed_id = ? AND relation.follower_id = p.user_id";
    const rows = all(
      `${profileSelect}
       JOIN user_follows relation ON ${join}
       ORDER BY relation.created_at DESC, p.user_id
       LIMIT ?`,
      viewerId, viewerId, locale, userId, limit,
    );
    return rows.map(mapProfile);
  }

  return Object.freeze({
    getAuthorProfile({ userId, locale = "zh-CN", viewerId = null }) {
      requiredText("userId", userId, 300);
      validateArticleLocale(locale);
      validateViewer(viewerId);
      const row = profileById(userId, locale, viewerId);
      return row ? mapProfile(row) : null;
    },
    searchUsers({ query, locale = "zh-CN", viewerId = null, limit = 20 }) {
      validateArticleLocale(locale);
      if (typeof query !== "string" || query.trim().length === 0 || query.length > 100) {
        throw new ProfileInputError("query must be non-empty and no longer than 100 characters.");
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new ProfileInputError("limit must be an integer between 1 and 100.");
      }
      validateViewer(viewerId);
      const term = query.trim().toLocaleLowerCase(locale);
      const rows = all(
        `${profileSelect}
         WHERE instr(lower(translated.display_name), ?) > 0 OR instr(lower(p.user_id), ?) > 0
         ORDER BY lower(translated.display_name), p.user_id
         LIMIT ?`,
        viewerId, viewerId, locale, term, term, limit,
      );
      return rows.map(mapProfile);
    },
    listFollowing({ userId, locale = "zh-CN", viewerId = null, limit = 50 }) {
      return listRelatedProfiles({ relationship: "following", userId, locale, viewerId, limit });
    },
    listFollowers({ userId, locale = "zh-CN", viewerId = null, limit = 50 }) {
      return listRelatedProfiles({ relationship: "followers", userId, locale, viewerId, limit });
    },
    followUser({ actorId, targetUserId }) {
      requiredText("actorId", actorId, 300);
      requiredText("targetUserId", targetUserId, 300);
      if (actorId === targetUserId) throw new ProfileInputError("You cannot follow your own account.");
      return transaction((transactionId) => {
        if (!get("SELECT user_id FROM user_profiles WHERE user_id = ?", targetUserId)) {
          throw new ProfileNotFoundError();
        }
        const inserted = run(
          "INSERT INTO user_follows (follower_id, followed_id) VALUES (?, ?) ON CONFLICT (follower_id, followed_id) DO NOTHING",
          actorId, targetUserId,
        );
        if (inserted.changes === 1) {
          const payload = { type: "user.followed", followerId: actorId };
          const eventKey = "user.followed:" + actorId + ":" + randomUUID();
          run(
            "INSERT INTO notifications (id, user_id, event_key, payload, payload_hash) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id, event_key) DO NOTHING",
            randomUUID(), targetUserId, eventKey, JSON.stringify(payload), requestHash(payload),
          );
          const notification = get("SELECT * FROM notifications WHERE user_id = ? AND event_key = ?", targetUserId, eventKey);
          migrationCapture.captureInTransaction(db, transactionId, [
            { entityType: "user_follows", entityId: migrationEntityKey(actorId, targetUserId), operation: "upsert", payload: get("SELECT * FROM user_follows WHERE follower_id = ? AND followed_id = ?", actorId, targetUserId) },
            { entityType: "notifications", entityId: notification.id, operation: "upsert", payload: notification },
          ]);
        }
        return inserted.changes === 1;
      });
    },
    unfollowUser({ actorId, targetUserId }) {
      requiredText("actorId", actorId, 300);
      requiredText("targetUserId", targetUserId, 300);
      if (actorId === targetUserId) throw new ProfileInputError("You cannot unfollow your own account.");
      return transaction((transactionId) => {
        const result = run("DELETE FROM user_follows WHERE follower_id = ? AND followed_id = ?", actorId, targetUserId);
        if (result.changes === 1) migrationCapture.captureInTransaction(db, transactionId, [
          { entityType: "user_follows", entityId: migrationEntityKey(actorId, targetUserId), operation: "delete", payload: null },
        ]);
        return result.changes === 1;
      });
    },
    upsertAuthorProfile({
      userId, displayName, bio = "", avatarUrl = undefined, websiteUrl = undefined, locale = "zh-CN",
    }) {
      requiredText("userId", userId, 300);
      requiredText("displayName", displayName, 120);
      if (typeof bio !== "string" || bio.length > 5000) {
        throw new ProfileInputError("bio must be a string no longer than 5000 characters.");
      }
      validateArticleLocale(locale);
      const validatedAvatarUrl = validateProfileUrl("avatarUrl", avatarUrl, true);
      const validatedWebsiteUrl = validateProfileUrl("websiteUrl", websiteUrl, false);
      return transaction(() => {
        run(
          `INSERT INTO user_profiles (user_id, avatar_url, website_url) VALUES (?, ?, ?)
           ON CONFLICT (user_id) DO UPDATE SET
             avatar_url = CASE WHEN ? THEN excluded.avatar_url ELSE user_profiles.avatar_url END,
             website_url = CASE WHEN ? THEN excluded.website_url ELSE user_profiles.website_url END,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
          userId, validatedAvatarUrl ?? null, validatedWebsiteUrl ?? null,
          avatarUrl !== undefined, websiteUrl !== undefined,
        );
        run(
          `INSERT INTO user_profile_translations (user_id, locale, display_name, bio) VALUES (?, ?, ?, ?)
           ON CONFLICT (user_id, locale) DO UPDATE SET
             display_name = excluded.display_name, bio = excluded.bio,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
          userId, locale, displayName, bio,
        );
        const row = get(
          `SELECT p.user_id, p.avatar_url, p.website_url, p.created_at,
            MAX(p.updated_at, t.updated_at) AS updated_at,
            t.display_name, t.bio, t.locale,
            (SELECT count(*) FROM user_follows f WHERE f.followed_id = p.user_id) AS follower_count,
            (SELECT count(*) FROM user_follows f WHERE f.follower_id = p.user_id) AS following_count,
            0 AS is_following_viewer
           FROM user_profiles p JOIN user_profile_translations t ON t.user_id = p.user_id
           WHERE p.user_id = ? AND t.locale = ? LIMIT 1`,
          userId, locale,
        );
        if (!row) throw new Error("Profile row was not available after upsert.");
        migrationCapture.captureInTransaction(db, transactionId, [
          { entityType: "user_profiles", entityId: userId, operation: "upsert", payload: get("SELECT * FROM user_profiles WHERE user_id = ?", userId) },
          { entityType: "user_profile_translations", entityId: migrationEntityKey(userId, locale), operation: "upsert", payload: get("SELECT * FROM user_profile_translations WHERE user_id = ? AND locale = ?", userId, locale) },
        ]);
        return mapProfile(row);
      });
    },
  });
}
