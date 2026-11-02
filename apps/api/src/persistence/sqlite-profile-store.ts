import { createHash, randomUUID } from "node:crypto";
import { createMigrationTransactionId } from "./provider-migration-journal.ts";
import { createSqliteProviderMigrationCapture, migrationEntityKey } from "./sqlite-provider-migration-capture.ts";
import {
  ProfileInputError,
  ProfileNotFoundError,
} from "../domain/errors.ts";
import { validateArticleLocale } from "../domain/article.ts";
import { requiredText } from "../domain/validation.ts";
import { AUTHOR_OFFSET_MAX, AUTHOR_QUERY_MAX_LENGTH, normalizeStoredRole, validateProfileUrl, validateUserRole } from "../domain/profile.ts";

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
    SELECT p.user_id, p.role, p.avatar_url, p.website_url, p.created_at,
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
      role: normalizeStoredRole(row.role),
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

  /**
   * The public author directory: one row per author, in the shape a reader sees.
   *
   * No `role`, no `isFollowing`, no email — a directory is the same answer for
   * everybody, and a response that depends on the reader cannot be cached or
   * reasoned about. The follow state belongs to the author's own page, which
   * already carries it.
   */
  const authorSearchSelect = `
    SELECT p.user_id, translated.display_name, translated.bio, translated.locale,
      (SELECT count(*) FROM user_follows f WHERE f.followed_id = p.user_id) AS follower_count,
      (SELECT count(*) FROM article_translations t JOIN articles a ON a.id = t.article_id
        WHERE a.author_id = p.user_id AND a.status = 'published' AND t.locale = ?) AS work_count
    FROM user_profiles p
    JOIN user_profile_translations translated ON translated.user_id = p.user_id
      AND translated.locale = (
        SELECT t.locale FROM user_profile_translations t
        WHERE t.user_id = p.user_id
        ORDER BY CASE WHEN t.locale = ? THEN 0 WHEN t.locale = 'zh-TW' THEN 1 ELSE 2 END, t.locale
        LIMIT 1
      )
    WHERE EXISTS (
      SELECT 1 FROM articles a JOIN article_translations t ON t.article_id = a.id
      WHERE a.author_id = p.user_id AND a.status = 'published' AND t.locale = ?
    )`;
  const mapAuthorSearch = (row) => ({
    userId: row.user_id,
    displayName: row.display_name,
    bio: row.bio ?? "",
    locale: row.locale,
    followerCount: Number(row.follower_count ?? 0),
    workCount: Number(row.work_count ?? 0),
  });
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
    /**
     * The one permission question the platform asks: may this account curate?
     * A profile that does not exist answers `member` — absence of a record is
     * absence of privilege, never a reason to fail open.
     */
    getUserRole({ userId }) {
      requiredText("userId", userId, 300);
      const row = get("SELECT role FROM user_profiles WHERE user_id = ?", userId);
      return normalizeStoredRole(row?.role);
    },
    setUserRole({ actorId, userId, role }) {
      requiredText("actorId", actorId, 300);
      requiredText("userId", userId, 300);
      const validatedRole = validateUserRole(role);
      // ADR 0016, decision 3: nobody edits their own role. A single-editor
      // instance whose editor demotes themselves has no way back in.
      if (actorId === userId) throw new ProfileInputError("You cannot change your own role.");
      return transaction((transactionId) => {
        if (!get("SELECT user_id FROM user_profiles WHERE user_id = ?", userId)) throw new ProfileNotFoundError();
        run(
          "UPDATE user_profiles SET role = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = ?",
          validatedRole, userId,
        );
        const row = get("SELECT * FROM user_profiles WHERE user_id = ?", userId);
        migrationCapture.captureInTransaction(db, transactionId, [
          { entityType: "user_profiles", entityId: userId, operation: "upsert", payload: row },
        ]);
        return normalizeStoredRole(row.role);
      });
    },
    /**
     * The public author directory and its search (ADR 0024).
     *
     * Two answers, one method: `query` empty is the directory — everybody who
     * has published in this locale, most-followed first — and a non-empty one
     * filters by display name (and by user id, which is the username the public
     * author page is addressed by).
     *
     * Only authors with a published work in the requested locale are listed. A
     * public directory is not a member list: it is a list of people a reader can
     * go and read, and the accounts that have not published are none of the
     * site's business — including to whoever would rather enumerate them.
     */
    searchAuthors({ query = "", locale = "zh-CN", limit = 20, offset = 0 }) {
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
      // Relevance, then reach: an exact name is the answer, a name that starts
      // with the term is probably the answer, and after that the author more
      // readers already follow is the better guess. With no term at all the
      // directory is pure reach — the point of it is discovery.
      const params: (string | number)[] = [locale, locale, locale];
      let sql = authorSearchSelect;
      if (term) {
        sql += " AND (instr(lower(translated.display_name), ?) > 0 OR instr(lower(p.user_id), ?) > 0)";
        params.push(term, term);
      }
      const order = term
        ? "ORDER BY (lower(translated.display_name) = ?) DESC, (instr(lower(translated.display_name), ?) = 1) DESC, follower_count DESC, lower(translated.display_name), p.user_id"
        : "ORDER BY follower_count DESC, lower(translated.display_name), p.user_id";
      if (term) params.push(term, term);
      sql += ` ${order} LIMIT ? OFFSET ?`;
      params.push(limit, offset);
      return all(sql, ...params).map(mapAuthorSearch);
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
      return transaction((transactionId) => {
        run(
          `INSERT INTO user_profiles (user_id, avatar_url, website_url) VALUES (?, ?, ?)
           ON CONFLICT (user_id) DO UPDATE SET
             avatar_url = CASE WHEN ? THEN excluded.avatar_url ELSE user_profiles.avatar_url END,
             website_url = CASE WHEN ? THEN excluded.website_url ELSE user_profiles.website_url END,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
          userId, validatedAvatarUrl ?? null, validatedWebsiteUrl ?? null,
          // node:sqlite expects SQL input values; use integer flags rather than JS booleans.
          avatarUrl !== undefined ? 1 : 0,
          websiteUrl !== undefined ? 1 : 0,
        );
        run(
          `INSERT INTO user_profile_translations (user_id, locale, display_name, bio) VALUES (?, ?, ?, ?)
           ON CONFLICT (user_id, locale) DO UPDATE SET
             display_name = excluded.display_name, bio = excluded.bio,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
          userId, locale, displayName, bio,
        );
        const row = get(
          `SELECT p.user_id, p.role, p.avatar_url, p.website_url, p.created_at,
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
