import { createHash, randomUUID } from "node:crypto";
import { createMigrationTransactionId } from "./provider-migration-journal.ts";
import { createPostgresProviderMigrationCapture, migrationEntityKey } from "./postgres-provider-migration-capture.ts";
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
  TaxonomyNotFoundError
} from "../domain/errors.ts";
import { normalizeHashtag, validateTaxonomyKind } from "../domain/taxonomy.ts";
import { validateArticleLocale, validateArticleSlug, normalizeArticleInput, normalizeTaxonomyIds } from "../domain/article.ts";
import { validateStoredCommentContent } from "../domain/comment-content.ts";
import { isUuid, requiredText } from "../domain/validation.ts";
import { normalizeParticipantIds } from "../domain/conversation.ts";
import { validateProfileUrl } from "../domain/profile.ts";
import { assertOutboxLease } from "./outbox-lease.ts";
import { createPostgresIdentityStore } from "./postgres-identity-store.ts";

export function createPostgresClient({
  connectionString = process.env.DATABASE_URL,
  max = 10,
  idle_timeout = 20,
  connect_timeout = 10,
} = {}) {
  if (typeof connectionString !== "string" || connectionString.length === 0) {
    throw new Error("DATABASE_URL is required to create the PostgreSQL client.");
  }
  let parsed;
  try { parsed = new URL(connectionString); } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL.");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("DATABASE_URL must use postgres:// or postgresql://.");
  }
  return import("postgres").then(({ default: postgres }) => postgres(connectionString, {
    max, idle_timeout, connect_timeout, connection: { application_name: "bot-thk-api" },
  }));
}

function requestHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function parseJsonValue(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}
function mapMessage(row, duplicate = false) {
  const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString();
  return { id: row.id, conversationId: row.conversation_id, senderId: row.sender_id, body: row.body, createdAt, duplicate };
}
function isoDate(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
function mapConversation(row) {
  return {
    id: row.id,
    createdBy: row.created_by ?? null,
    participantIds: row.participant_ids ?? [],
    createdAt: isoDate(row.created_at),
    lastActivityAt: isoDate(row.last_activity_at ?? row.created_at),
    unreadCount: Number(row.unread_count ?? 0),
    lastMessage: row.latest_message_id ? mapMessage({
      id: row.latest_message_id,
      conversation_id: row.latest_message_conversation_id,
      sender_id: row.latest_message_sender_id,
      body: row.latest_message_body,
      created_at: row.latest_message_created_at,
    }) : null,
  };
}
function mapArticleComment(row) {
  const iso = (value) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  return {
    id: row.id,
    articleId: row.article_id,
    authorId: row.author_id,
    parentCommentId: row.parent_comment_id,
    content: row.content,
    contentBlocks: row.content_blocks == null ? null : parseJsonValue(row.content_blocks),
    contentBlocksVersion: Number(row.content_blocks_version ?? 0),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    locale: row.locale,
    replies: [],
  };
}

function mapTaxonomy(row) {
  return {
    id: row.id,
    kind: row.kind,
    slug: row.slug,
    name: row.name,
    description: row.description ?? "",
    locale: row.locale,
    createdBy: row.created_by,
    articleCount: Number(row.article_count ?? 0),
  };
}
function mapArticle(row) {
  const iso = (value) => value == null ? null : (value instanceof Date ? value.toISOString() : new Date(value).toISOString());
  return {
    id: row.id,
    authorId: row.author_id,
    slug: row.slug,
    workType: row.work_type ?? "other",
    status: row.status,
    locale: row.locale,
    title: row.title,
    summary: row.summary,
    contentBlocks: parseJsonValue(row.content_blocks),
    contentBlocksVersion: Number(row.content_blocks_version ?? 0),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    publishedAt: iso(row.published_at),
  };
}
async function listTaxonomiesFrom(executor, { kind, locale = "zh-CN", query = "", limit = 100, offset = 0 }) {
  validateTaxonomyKind(kind);
  validateArticleLocale(locale);
  if (typeof query !== "string" || query.length > 200) throw new ArticleInputError("query must be a string no longer than 200 characters.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ArticleInputError("limit must be an integer between 1 and 100.");
  if (!Number.isInteger(offset) || offset < 0 || offset > 1000000) throw new ArticleInputError("offset must be an integer between 0 and 1000000.");
  const normalizedQuery = query.trim() ? query.trim().toLocaleLowerCase(locale) : null;
  const rows = await executor.unsafe(
    `SELECT tax.id, tax.kind, tax.slug, tax.created_by,
            COALESCE(requested.name, fallback.name) AS name,
            COALESCE(requested.description, fallback.description, '') AS description,
            $2::text AS locale,
            (SELECT count(DISTINCT a.id)::int
             FROM article_taxonomies AS link
             JOIN articles AS a ON a.id = link.article_id AND a.status = 'published'
             JOIN article_translations AS at ON at.article_id = a.id AND at.locale = $2
             WHERE link.taxonomy_id = tax.id) AS article_count
     FROM taxonomies AS tax
     LEFT JOIN taxonomy_translations AS requested ON requested.taxonomy_id = tax.id AND requested.locale = $2
     LEFT JOIN taxonomy_translations AS fallback ON fallback.taxonomy_id = tax.id AND fallback.locale = 'zh-TW'
     WHERE tax.kind = $1 AND COALESCE(requested.name, fallback.name) IS NOT NULL
       AND ($3::text IS NULL OR position($3 in lower(COALESCE(requested.name, fallback.name))) > 0)
     ORDER BY lower(COALESCE(requested.name, fallback.name)), tax.id
     LIMIT $4 OFFSET $5`,
    [kind, locale, normalizedQuery, limit, offset],
  );
  return rows.map(mapTaxonomy);
}
async function replaceArticleTaxonomyKind(tx, articleId, kind, ids) {
  if (ids === undefined) return;
  validateTaxonomyKind(kind);
  if (ids.length > 0) {
    const placeholders = ids.map((_, index) => "$" + (index + 2)).join(", ");
    const rows = await tx.unsafe(
      `SELECT id FROM taxonomies WHERE kind = $1 AND id IN (${placeholders})`,
      [kind, ...ids],
    );
    if (rows.length !== ids.length) throw new ArticleInputError(`All selected ${kind} IDs must reference existing ${kind} taxonomies.`);
  }
  await tx.unsafe(
    "DELETE FROM article_taxonomies WHERE article_id = $1 AND taxonomy_id IN (SELECT id FROM taxonomies WHERE kind = $2)",
    [articleId, kind],
  );
  for (const taxonomyId of ids) {
    await tx.unsafe(
      "INSERT INTO article_taxonomies (article_id, taxonomy_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [articleId, taxonomyId],
    );
  }
}
function mapAuthorProfile(row) {
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
    isFollowing: Boolean(row.is_following_viewer ?? false),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
async function findAuthorProfile(executor, { userId, locale = "zh-CN", viewerId = null }) {
  requiredText("userId", userId, 300);
  validateArticleLocale(locale);
  if (viewerId !== null) requiredText("viewerId", viewerId, 300);
  const rows = await executor.unsafe(
    `SELECT p.user_id, p.avatar_url, p.website_url, p.created_at,
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
    `SELECT p.user_id, p.avatar_url, p.website_url, p.created_at,
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

export function createPostgresStore(sql) {
  if (!sql || typeof sql.unsafe !== "function" || typeof sql.begin !== "function") {
    throw new TypeError("A postgres.js SQL client is required.");
  }
  const migrationCapture = createPostgresProviderMigrationCapture(sql);
  async function captureChanges(tx, transactionId, changes) {
    await migrationCapture.captureInTransaction(tx, transactionId, changes);
  }
  const migrationCapture = createPostgresProviderMigrationCapture(sql);
  async function captureChanges(tx, transactionId, changes) {
    await migrationCapture.captureInTransaction(tx, transactionId, changes);
  }
  async function findMessage(tx, senderId, idempotencyKey) {
    const rows = await tx.unsafe(
      "SELECT id, conversation_id, sender_id, body, request_hash, created_at FROM messages WHERE sender_id = $1 AND idempotency_key = $2",
      [senderId, idempotencyKey],
    );
    return rows[0] ?? null;
  }
  function assertSameRequest(existing, hash) {
    if (existing.request_hash !== hash) throw new IdempotencyConflictError();
    return mapMessage(existing, true);
  }
  async function readArticleLikeInfo(executor, { slug, locale = "zh-CN", actorId = null }) {
    validateArticleSlug(slug);
    validateArticleLocale(locale);
    if (actorId !== null) requiredText("actorId", actorId, 300);
    const rows = await executor.unsafe(
      `SELECT a.id AS article_id, a.slug,
              count(l.user_id)::int AS like_count,
              COALESCE(bool_or(l.user_id = $3), false) AS liked_by_viewer
       FROM articles AS a
       JOIN article_translations AS t ON t.article_id = a.id
       LEFT JOIN article_likes AS l ON l.article_id = a.id
       WHERE a.slug = $1 AND a.status = 'published' AND t.locale = $2
       GROUP BY a.id, a.slug`,
      [slug, locale, actorId],
    );
    const row = rows[0];
    return row ? {
      articleId: row.article_id,
      slug: row.slug,
      likeCount: row.like_count,
      likedByViewer: row.liked_by_viewer,
    } : null;
  }

  return Object.freeze({
    ...createPostgresIdentityStore(sql),
    async health() {
      await sql.unsafe("SELECT 1 AS ok");
      return true;
    },
    transaction(work) {
      if (typeof work !== "function") throw new TypeError("Transaction callback is required.");
      return sql.begin(work);
    },
    async getArticleLikeInfo({ slug, locale = "zh-CN", actorId = null }) {
      return readArticleLikeInfo(sql, { slug, locale, actorId });
    },
    async toggleArticleLike({ slug, locale = "zh-CN", actorId }) {
      validateArticleSlug(slug);
      validateArticleLocale(locale);
      requiredText("actorId", actorId, 300);
      return sql.begin(async (tx) => {
        const transactionId = createMigrationTransactionId();
        const changes = [];
        const articles = await tx.unsafe(
          "SELECT a.id, a.author_id FROM articles AS a JOIN article_translations AS t ON t.article_id = a.id WHERE a.slug = $1 AND a.status = 'published' AND t.locale = $2 FOR UPDATE OF a",
          [slug, locale],
        );
        if (articles.length === 0) throw new ArticleNotFoundError("The published article was not found in this locale.");
        const article = articles[0];
        const articleId = article.id;
        const existing = await tx.unsafe(
          "SELECT 1 FROM article_likes WHERE article_id = $1 AND user_id = $2",
          [articleId, actorId],
        );
        if (existing.length > 0) {
          await tx.unsafe("DELETE FROM article_likes WHERE article_id = $1 AND user_id = $2", [articleId, actorId]);
          changes.push({ entityType: "article_likes", entityId: migrationEntityKey(articleId, actorId), operation: "delete", payload: null });
        } else {
          const inserted = await tx.unsafe(
            "INSERT INTO article_likes (article_id, user_id) VALUES ($1, $2) ON CONFLICT (article_id, user_id) DO NOTHING RETURNING article_id",
            [articleId, actorId],
          );
          if (inserted.length === 1) {
            const likeRows = await tx.unsafe("SELECT * FROM article_likes WHERE article_id = $1 AND user_id = $2", [articleId, actorId]);
            changes.push({ entityType: "article_likes", entityId: migrationEntityKey(articleId, actorId), operation: "upsert", payload: likeRows[0] });
            if (article.author_id !== actorId) {
            const payload = { type: "article.liked", articleId, slug, actorId, locale };
            await tx.unsafe(
              "INSERT INTO notifications (id, user_id, event_key, payload, payload_hash) VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT (user_id, event_key) DO NOTHING",
              [randomUUID(), article.author_id, `article.liked:${articleId}:${actorId}:${randomUUID()}`, payload, requestHash(payload)],
            );
          }
        }
        await captureChanges(tx, transactionId, changes);
        return readArticleLikeInfo(tx, { slug, locale, actorId });
      });
    },
    async setArticleLike({ slug, locale = "zh-CN", actorId, liked }) {
      validateArticleSlug(slug);
      validateArticleLocale(locale);
      requiredText("actorId", actorId, 300);
      if (typeof liked !== "boolean") throw new ArticleInputError("liked must be a boolean.");
      return sql.begin(async (tx) => {
        const transactionId = createMigrationTransactionId();
        const changes = [];
        const articles = await tx.unsafe(
          "SELECT a.id, a.author_id FROM articles AS a JOIN article_translations AS t ON t.article_id = a.id WHERE a.slug = $1 AND a.status = 'published' AND t.locale = $2 FOR UPDATE OF a",
          [slug, locale],
        );
        if (articles.length === 0) throw new ArticleNotFoundError("The published article was not found in this locale.");
        const article = articles[0];
        const existing = await tx.unsafe(
          "SELECT 1 FROM article_likes WHERE article_id = $1 AND user_id = $2",
          [article.id, actorId],
        );
        if (liked && existing.length === 0) {
          const inserted = await tx.unsafe(
            "INSERT INTO article_likes (article_id, user_id) VALUES ($1, $2) ON CONFLICT (article_id, user_id) DO NOTHING RETURNING article_id",
            [article.id, actorId],
          );
          if (inserted.length === 1) {
            const likeRows = await tx.unsafe("SELECT * FROM article_likes WHERE article_id = $1 AND user_id = $2", [article.id, actorId]);
            changes.push({ entityType: "article_likes", entityId: migrationEntityKey(article.id, actorId), operation: "upsert", payload: likeRows[0] });
            if (article.author_id !== actorId) {
            const payload = { type: "article.liked", articleId: article.id, slug, actorId, locale };
            await tx.unsafe(
              "INSERT INTO notifications (id, user_id, event_key, payload, payload_hash) VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT (user_id, event_key) DO NOTHING",
              [randomUUID(), article.author_id, `article.liked:${article.id}:${actorId}:${randomUUID()}`, payload, requestHash(payload)],
            );
          }
        } else if (!liked && existing.length > 0) {
          await tx.unsafe("DELETE FROM article_likes WHERE article_id = $1 AND user_id = $2", [article.id, actorId]);
          changes.push({ entityType: "article_likes", entityId: migrationEntityKey(article.id, actorId), operation: "delete", payload: null });
        }
        await captureChanges(tx, transactionId, changes);
        return readArticleLikeInfo(tx, { slug, locale, actorId });
      });
    },
    async listArticleComments({ slug, locale = "zh-CN", limit = 50 }) {
      validateArticleSlug(slug);
      validateArticleLocale(locale);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new ArticleInputError("limit must be an integer between 1 and 100.");
      }
      const rows = await sql.unsafe(
        `WITH RECURSIVE target_article AS (
          SELECT a.id
          FROM articles AS a
          JOIN article_translations AS t ON t.article_id = a.id
          WHERE a.slug = $1 AND a.status = 'published' AND t.locale = $2
        ),
        root_comments AS (
          SELECT c.id, c.article_id, c.author_id, c.parent_comment_id, c.content,
                 c.content_blocks, c.content_blocks_version, c.created_at, c.updated_at, 0::int AS depth
          FROM article_comments AS c
          JOIN target_article AS a ON a.id = c.article_id
          WHERE c.parent_comment_id IS NULL
          ORDER BY c.created_at ASC, c.id ASC
          LIMIT $3
        ),
        comment_tree AS (
          SELECT * FROM root_comments
          UNION ALL
          SELECT child.id, child.article_id, child.author_id, child.parent_comment_id,
                 child.content, child.content_blocks, child.content_blocks_version,
                 child.created_at, child.updated_at, parent.depth + 1
          FROM article_comments AS child
          JOIN comment_tree AS parent ON child.parent_comment_id = parent.id
          WHERE parent.depth < 10
        )
        SELECT id, article_id, author_id, parent_comment_id, content,
               content_blocks, content_blocks_version, created_at, updated_at, depth
        FROM comment_tree
        ORDER BY created_at ASC, id ASC`,
        [slug, locale, limit],
      );
      const nodes = new Map();
      for (const row of rows) nodes.set(row.id, mapArticleComment({ ...row, locale }));
      const roots = [];
      for (const node of nodes.values()) {
        if (node.parentCommentId && nodes.has(node.parentCommentId)) {
          nodes.get(node.parentCommentId).replies.push(node);
        } else {
          roots.push(node);
        }
      }
      return roots;
    },
    async createArticleComment({ slug, locale = "zh-CN", actorId, content, contentBlocks = null, contentBlocksVersion = 0, parentCommentId = null }) {
      validateArticleSlug(slug);
      validateArticleLocale(locale);
      requiredText("actorId", actorId, 300);
      const normalizedContent = validateStoredCommentContent({ content, contentBlocks, contentBlocksVersion });
      if (parentCommentId !== null && !isUuid(parentCommentId)) {
        throw new ArticleInputError("parentCommentId must be a valid comment ID.");
      }
      return sql.begin(async (tx) => {
        const transactionId = createMigrationTransactionId();
        const changes = [];
        const articles = await tx.unsafe(
          "SELECT a.id, a.author_id FROM articles AS a JOIN article_translations AS t ON t.article_id = a.id WHERE a.slug = $1 AND a.status = 'published' AND t.locale = $2 FOR SHARE OF a",
          [slug, locale],
        );
        if (articles.length === 0) throw new ArticleNotFoundError("The published article was not found in this locale.");
        const article = articles[0];
        let parentAuthorId = null;
        if (parentCommentId !== null) {
          const parentRows = await tx.unsafe(
            "SELECT author_id FROM article_comments WHERE id = $1 AND article_id = $2",
            [parentCommentId, article.id],
          );
          if (parentRows.length === 0) throw new ArticleInputError("parentCommentId must reference a comment on this article.");
          parentAuthorId = parentRows[0].author_id;
        }
        const rows = await tx.unsafe(
          "INSERT INTO article_comments (id, article_id, author_id, parent_comment_id, content, content_blocks, content_blocks_version) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING id, article_id, author_id, parent_comment_id, content, content_blocks, content_blocks_version, created_at, updated_at",
          [randomUUID(), article.id, actorId, parentCommentId, normalizedContent.content,
            normalizedContent.contentBlocks === null ? null : normalizedContent.contentBlocks,
            normalizedContent.contentBlocksVersion],
        );
        const comment = rows[0];
        changes.push({ entityType: "article_comments", entityId: comment.id, operation: "upsert", payload: comment });
        const recipients = new Map();
        if (article.author_id !== actorId) recipients.set(article.author_id, "article.commented");
        if (parentAuthorId && parentAuthorId !== actorId) recipients.set(parentAuthorId, "article.comment_replied");
        for (const [userId, type] of recipients) {
          const payload = {
            type, articleId: article.id, slug, commentId: comment.id,
            commenterId: actorId, parentCommentId,
          };
          const notificationId = randomUUID();
          await tx.unsafe(
            "INSERT INTO notifications (id, user_id, event_key, payload, payload_hash) VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT (user_id, event_key) DO NOTHING",
            [notificationId, userId, type + ":" + comment.id, payload, requestHash(payload)],
          );
          const notificationRows = await tx.unsafe("SELECT * FROM notifications WHERE id = $1", [notificationId]);
          if (notificationRows[0]) changes.push({ entityType: "notifications", entityId: notificationId, operation: "upsert", payload: notificationRows[0] });
        }
        await captureChanges(tx, transactionId, changes);
        return mapArticleComment({ ...comment, locale });
      });
    },
    async deleteArticleComment({ commentId, actorId }) {
      if (!isUuid(commentId)) throw new ArticleInputError("commentId must be a valid comment ID.");
      requiredText("actorId", actorId, 300);
      return sql.begin(async (tx) => {
        const transactionId = createMigrationTransactionId();
        const rows = await tx.unsafe(
          "SELECT author_id FROM article_comments WHERE id = $1 FOR UPDATE",
          [commentId],
        );
        if (rows.length === 0) return false;
        if (rows[0].author_id !== actorId) throw new ArticleAuthorizationError("You can delete only your own comment.");
        const descendants = await tx.unsafe(
          "WITH RECURSIVE descendants(id) AS (SELECT id FROM article_comments WHERE id = $1 UNION ALL SELECT child.id FROM article_comments child JOIN descendants parent ON child.parent_comment_id = parent.id) SELECT id FROM descendants",
          [commentId],
        );
        await tx.unsafe("DELETE FROM article_comments WHERE id = $1", [commentId]);
        await captureChanges(tx, transactionId, descendants.map((row) => ({ entityType: "article_comments", entityId: row.id, operation: "delete", payload: null })));
        return true;
      });
    },
    async listTaxonomies({ kind, locale = "zh-CN", query = "", limit = 100, offset = 0 }) {
      return listTaxonomiesFrom(sql, { kind, locale, query, limit, offset });
    },
    async getTaxonomyBySlug({ kind, slug, locale = "zh-CN" }) {
      validateTaxonomyKind(kind);
      validateArticleSlug(slug);
      validateArticleLocale(locale);
      const rows = await sql.unsafe(
        `SELECT tax.id, tax.kind, tax.slug, tax.created_by,
                COALESCE(requested.name, fallback.name) AS name,
                COALESCE(requested.description, fallback.description, '') AS description,
                $3::text AS locale,
                (SELECT count(DISTINCT a.id)::int
                 FROM article_taxonomies AS link
                 JOIN articles AS a ON a.id = link.article_id AND a.status = 'published'
                 JOIN article_translations AS at ON at.article_id = a.id AND at.locale = $3
                 WHERE link.taxonomy_id = tax.id) AS article_count
         FROM taxonomies AS tax
         LEFT JOIN taxonomy_translations AS requested ON requested.taxonomy_id = tax.id AND requested.locale = $3
         LEFT JOIN taxonomy_translations AS fallback ON fallback.taxonomy_id = tax.id AND fallback.locale = 'zh-TW'
         WHERE tax.kind = $1 AND tax.slug = $2
           AND COALESCE(requested.name, fallback.name) IS NOT NULL
         LIMIT 1`,
        [kind, slug, locale],
      );
      return rows[0] ? mapTaxonomy(rows[0]) : null;
    },
    async listTaxonomyArticles({ kind, slug, locale = "zh-CN", limit = 20, offset = 0 }) {
      validateTaxonomyKind(kind);
      validateArticleSlug(slug);
      validateArticleLocale(locale);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ArticleInputError("limit must be an integer between 1 and 100.");
      if (!Number.isInteger(offset) || offset < 0 || offset > 1000000) throw new ArticleInputError("offset must be an integer between 0 and 1000000.");
      const rows = await sql.unsafe(
        `SELECT a.id, a.author_id, a.slug, a.work_type, a.status, a.created_at, a.updated_at, a.published_at,
                at.locale, at.title, at.summary, at.content_blocks, at.content_blocks_version
         FROM taxonomies AS tax
         JOIN taxonomy_translations AS tt ON tt.taxonomy_id = tax.id AND tt.locale = $3
         JOIN article_taxonomies AS link ON link.taxonomy_id = tax.id
         JOIN articles AS a ON a.id = link.article_id AND a.status = 'published'
         JOIN article_translations AS at ON at.article_id = a.id AND at.locale = $3
         WHERE tax.kind = $1 AND tax.slug = $2
         ORDER BY a.published_at DESC, a.id DESC
         LIMIT $4 OFFSET $5`,
        [kind, slug, locale, limit, offset],
      );
      return rows.map(mapArticle);
    },
    async listArticleTaxonomies({ articleId, kind, locale = "zh-CN" }) {
      if (!isUuid(articleId)) throw new ArticleInputError("articleId must be a valid article ID.");
      validateTaxonomyKind(kind);
      validateArticleLocale(locale);
      const rows = await sql.unsafe(
        `SELECT tax.id, tax.kind, tax.slug, tax.created_by,
                COALESCE(requested.name, fallback.name) AS name,
                COALESCE(requested.description, fallback.description, '') AS description,
                $3::text AS locale,
                (SELECT count(DISTINCT a2.id)::int
                 FROM article_taxonomies AS links2
                 JOIN articles AS a2 ON a2.id = links2.article_id AND a2.status = 'published'
                 JOIN article_translations AS at2 ON at2.article_id = a2.id AND at2.locale = $3
                 WHERE links2.taxonomy_id = tax.id) AS article_count
         FROM article_taxonomies AS link
         JOIN taxonomies AS tax ON tax.id = link.taxonomy_id AND tax.kind = $2
         LEFT JOIN taxonomy_translations AS requested ON requested.taxonomy_id = tax.id AND requested.locale = $3
         LEFT JOIN taxonomy_translations AS fallback ON fallback.taxonomy_id = tax.id AND fallback.locale = 'zh-TW'
         WHERE link.article_id = $1 AND COALESCE(requested.name, fallback.name) IS NOT NULL
         ORDER BY lower(COALESCE(requested.name, fallback.name)), tax.id`,
        [articleId, kind, locale],
      );
      return rows.map(mapTaxonomy);
    },
    async createTag({ actorId, name, locale = "zh-CN" }) {
      requiredText("actorId", actorId, 300);
      validateArticleLocale(locale);
      const normalized = normalizeHashtag(name);
      return sql.begin(async (tx) => {
        await tx.unsafe(
          "INSERT INTO taxonomies (id, kind, slug, created_by) VALUES ($1, 'tag', $2, $3) ON CONFLICT (kind, slug) DO NOTHING",
          [randomUUID(), normalized.slug, actorId],
        );
        const rows = await tx.unsafe(
          "SELECT id, kind, slug, created_by FROM taxonomies WHERE kind = 'tag' AND slug = $1 FOR UPDATE",
          [normalized.slug],
        );
        if (!rows[0]) throw new TaxonomyConflictError();
        const taxonomy = rows[0];
        await tx.unsafe(
          "INSERT INTO taxonomy_translations (taxonomy_id, locale, name, description) VALUES ($1, $2, $3, '') ON CONFLICT (taxonomy_id, locale) DO NOTHING",
          [taxonomy.id, locale, normalized.displayName],
        );
        const found = await tx.unsafe(
          `SELECT tax.id, tax.kind, tax.slug, tax.created_by, tr.name, tr.description, tr.locale,
                  (SELECT count(DISTINCT a.id)::int
                   FROM article_taxonomies AS link
                   JOIN articles AS a ON a.id = link.article_id AND a.status = 'published'
                   JOIN article_translations AS at ON at.article_id = a.id AND at.locale = $2
                   WHERE link.taxonomy_id = tax.id) AS article_count
           FROM taxonomies AS tax
           JOIN taxonomy_translations AS tr ON tr.taxonomy_id = tax.id AND tr.locale = $2
           WHERE tax.id = $1`,
          [taxonomy.id, locale],
        );
        if (!found[0]) throw new TaxonomyConflictError("Tag exists but has no display label for the requested locale.");
        return mapTaxonomy(found[0]);
      });
    },
    async createTaxonomy({ actorId, kind, slug, name, description = "", locale = "zh-CN" }) {
      requiredText("actorId", actorId, 300);
      validateTaxonomyKind(kind);
      const normalizedSlug = validateArticleSlug(slug);
      requiredText("name", name, 120);
      if (typeof description !== "string" || description.length > 2000) throw new ArticleInputError("description must be a string no longer than 2000 characters.");
      validateArticleLocale(locale);
      try {
        return await sql.begin(async (tx) => {
          let taxonomyRows = await tx.unsafe(
            "INSERT INTO taxonomies (id, kind, slug, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT (kind, slug) DO NOTHING RETURNING id, kind, slug, created_by",
            [randomUUID(), kind, normalizedSlug, actorId],
          );
          let taxonomy = taxonomyRows[0];
          if (!taxonomy) {
            taxonomyRows = await tx.unsafe("SELECT id, kind, slug, created_by FROM taxonomies WHERE kind = $1 AND slug = $2 FOR UPDATE", [kind, normalizedSlug]);
            taxonomy = taxonomyRows[0];
            if (!taxonomy) throw new TaxonomyConflictError();
            if (taxonomy.created_by !== actorId) throw new ArticleAuthorizationError("Only the taxonomy creator can add another translation.");
          }
          await tx.unsafe(
            "INSERT INTO taxonomy_translations (taxonomy_id, locale, name, description) VALUES ($1, $2, $3, $4) ON CONFLICT (taxonomy_id, locale) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, updated_at = now()",
            [taxonomy.id, locale, name, description],
          );
          const found = await tx.unsafe(
            "SELECT tax.id, tax.kind, tax.slug, tax.created_by, tr.name, tr.description, tr.locale, 0::int AS article_count FROM taxonomies AS tax JOIN taxonomy_translations AS tr ON tr.taxonomy_id = tax.id AND tr.locale = $2 WHERE tax.id = $1",
            [taxonomy.id, locale],
          );
          return mapTaxonomy(found[0]);
        });
      } catch (error) {
        if (error?.code === "23505") throw new TaxonomyConflictError();
        throw error;
      }
    },
    async deleteTaxonomy({ taxonomyId, actorId }) {
      if (!isUuid(taxonomyId)) throw new ArticleInputError("taxonomyId must be a valid UUID.");
      requiredText("actorId", actorId, 300);
      return sql.begin(async (tx) => {
        const rows = await tx.unsafe("SELECT created_by FROM taxonomies WHERE id = $1 FOR UPDATE", [taxonomyId]);
        if (rows.length === 0) return false;
        if (rows[0].created_by !== actorId) throw new ArticleAuthorizationError("Only the taxonomy creator can delete it.");
        await tx.unsafe("DELETE FROM taxonomies WHERE id = $1", [taxonomyId]);
        return true;
      });
    },
    async getAuthorProfile({ userId, locale = "zh-CN", viewerId = null }) {
      return findAuthorProfile(sql, { userId, locale, viewerId });
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
        `SELECT p.user_id, p.avatar_url, p.website_url, p.created_at,
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
        const target = await tx.unsafe("SELECT user_id FROM user_profiles WHERE user_id = $1", [targetUserId]);
        if (target.length === 0) throw new ProfileNotFoundError();
        const inserted = await tx.unsafe(
          "INSERT INTO user_follows (follower_id, followed_id) VALUES ($1, $2) ON CONFLICT (follower_id, followed_id) DO NOTHING RETURNING follower_id",
          [actorId, targetUserId],
        );
        if (inserted.length === 1) {
          const payload = { type: "user.followed", followerId: actorId };
          const eventKey = `user.followed:${actorId}:${randomUUID()}`;
          await tx.unsafe(
            "INSERT INTO notifications (id, user_id, event_key, payload, payload_hash) VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT (user_id, event_key) DO NOTHING",
            [randomUUID(), targetUserId, eventKey, payload, requestHash(payload)],
          );
        }
        return inserted.length === 1;
      });
    },
    async unfollowUser({ actorId, targetUserId }) {
      requiredText("actorId", actorId, 300);
      requiredText("targetUserId", targetUserId, 300);
      if (actorId === targetUserId) throw new ProfileInputError("You cannot unfollow your own account.");
      const rows = await sql.unsafe(
        "DELETE FROM user_follows WHERE follower_id = $1 AND followed_id = $2 RETURNING follower_id",
        [actorId, targetUserId],
      );
      return rows.length === 1;
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
        await tx.unsafe(
          "INSERT INTO user_profiles (user_id, avatar_url, website_url) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET avatar_url = CASE WHEN $4 THEN $2 ELSE user_profiles.avatar_url END, website_url = CASE WHEN $5 THEN $3 ELSE user_profiles.website_url END, updated_at = now()",
          [userId, validatedAvatarUrl ?? null, validatedWebsiteUrl ?? null, avatarUrl !== undefined, websiteUrl !== undefined],
        );
        await tx.unsafe(
          "INSERT INTO user_profile_translations (user_id, locale, display_name, bio) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, locale) DO UPDATE SET display_name = EXCLUDED.display_name, bio = EXCLUDED.bio, updated_at = now()",
          [userId, locale, displayName, bio],
        );
        const rows = await tx.unsafe(
          "SELECT p.user_id, p.avatar_url, p.website_url, p.created_at, GREATEST(p.updated_at, t.updated_at) AS updated_at, t.display_name, t.bio, t.locale FROM user_profiles AS p JOIN user_profile_translations AS t ON t.user_id = p.user_id WHERE p.user_id = $1 AND t.locale = $2 LIMIT 1",
          [userId, locale],
        );
        if (!rows[0]) throw new Error("Profile row was not available after upsert.");
        return mapAuthorProfile(rows[0]);
      });
    },
    async listLikedArticles({ actorId, locale = "zh-CN", limit = 50 }: { actorId: string; locale?: string; limit?: number } = { actorId: "" }) {
      requiredText("actorId", actorId, 300);
      validateArticleLocale(locale);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new ArticleInputError("limit must be an integer between 1 and 100.");
      }
      const rows = await sql.unsafe(
        `SELECT a.id, a.author_id, a.slug, a.work_type, a.status, a.created_at, a.updated_at, a.published_at,
                t.locale, t.title, t.summary, t.content_blocks, t.content_blocks_version
         FROM article_likes AS likes
         JOIN articles AS a ON a.id = likes.article_id AND a.status = 'published'
         JOIN article_translations AS t ON t.article_id = a.id AND t.locale = $2
         WHERE likes.user_id = $1
         ORDER BY likes.created_at DESC, a.id DESC
         LIMIT $3`,
        [actorId, locale, limit],
      );
      return rows.map(mapArticle);
    },
    async listRelatedArticles({ slug, locale = "zh-CN", limit = 6 }: { slug: string; locale?: string; limit?: number } = { slug: "" }) {
      validateArticleSlug(slug);
      validateArticleLocale(locale);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
        throw new ArticleInputError("limit must be an integer between 1 and 50.");
      }
      const rows = await sql.unsafe(
        `WITH target AS (
          SELECT a.id, a.author_id
          FROM articles AS a
          JOIN article_translations AS t ON t.article_id = a.id AND t.locale = $2
          WHERE a.slug = $1 AND a.status = 'published'
          LIMIT 1
        ),
        candidates AS (
          SELECT a.id, a.author_id, a.slug, a.work_type, a.status, a.created_at, a.updated_at, a.published_at,
                 t.locale, t.title, t.summary, t.content_blocks, t.content_blocks_version,
                 count(DISTINCT candidate_link.taxonomy_id)::int AS shared_taxonomy_count,
                 (a.author_id = target.author_id) AS same_author
          FROM target
          JOIN articles AS a ON a.status = 'published' AND a.id <> target.id
          JOIN article_translations AS t ON t.article_id = a.id AND t.locale = $2
          LEFT JOIN article_taxonomies AS target_link ON target_link.article_id = target.id
          LEFT JOIN article_taxonomies AS candidate_link
            ON candidate_link.article_id = a.id AND candidate_link.taxonomy_id = target_link.taxonomy_id
          GROUP BY a.id, a.author_id, a.slug, a.work_type, a.status, a.created_at, a.updated_at, a.published_at,
                   t.locale, t.title, t.summary, t.content_blocks, t.content_blocks_version, target.author_id
        )
        SELECT id, author_id, slug, status, created_at, updated_at, published_at, locale, title, summary, content_blocks, content_blocks_version
        FROM candidates
        ORDER BY shared_taxonomy_count DESC, same_author DESC, published_at DESC, id DESC
        LIMIT $3`,
        [slug, locale, limit],
      );
      return rows.map(mapArticle);
    },
    async listPublishedArticles({ locale = "zh-CN", query = "", authorId = null, limit = 20, offset = 0 } = {}) {
      validateArticleLocale(locale);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ArticleInputError("limit must be an integer between 1 and 100.");
      if (!Number.isInteger(offset) || offset < 0 || offset > 100000) {
        throw new ArticleInputError("offset must be an integer between 0 and 100000.");
      }
      if (typeof query !== "string" || query.length > 200) throw new ArticleInputError("query must be a string no longer than 200 characters.");
      if (authorId !== null) requiredText("authorId", authorId, 300);
      const search = query.trim() ? query.trim() : null;
      // Escape LIKE metacharacters to preserve literal substring semantics.
      // The pg_trgm GIN indexes make non-empty title/summary searches indexable.
      const searchPattern = search === null
        ? null
        : "%" + search.replace(/[\\%_]/g, "\\$&") + "%";
      const rows = await sql.unsafe(
        `SELECT a.id, a.author_id, a.slug, a.work_type, a.status, a.created_at, a.updated_at, a.published_at,
                t.locale, t.title, t.summary, t.content_blocks, t.content_blocks_version
         FROM articles AS a
         JOIN article_translations AS t ON t.article_id = a.id
         WHERE a.status = 'published' AND t.locale = $1
           AND ($2::text IS NULL OR t.title ILIKE $2 ESCAPE E'\\\\' OR t.summary ILIKE $2 ESCAPE E'\\\\')
           AND ($3::text IS NULL OR a.author_id = $3)
         ORDER BY a.published_at DESC, a.id DESC
         LIMIT $4 OFFSET $5`,
        [locale, searchPattern, authorId, limit, offset],
      );
      return rows.map(mapArticle);
    },
    async getPublishedArticle({ slug, locale = "zh-CN" }) {
      const normalizedSlug = validateArticleSlug(slug);
      validateArticleLocale(locale);
      const rows = await sql.unsafe(
        `SELECT a.id, a.author_id, a.slug, a.work_type, a.status, a.created_at, a.updated_at, a.published_at,
                t.locale, t.title, t.summary, t.content_blocks, t.content_blocks_version
         FROM articles AS a
         JOIN article_translations AS t ON t.article_id = a.id
         WHERE a.slug = $1 AND a.status = 'published' AND t.locale = $2
         LIMIT 1`,
        [normalizedSlug, locale],
      );
      return rows[0] ? mapArticle(rows[0]) : null;
    },
    async listMyArticles({ actorId, locale = "zh-CN", limit = 50 }: { actorId: string; locale?: string; limit?: number } = { actorId: "" }) {
      requiredText("actorId", actorId, 300);
      validateArticleLocale(locale);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ArticleInputError("limit must be an integer between 1 and 100.");
      const rows = await sql.unsafe(
        `SELECT a.id, a.author_id, a.slug, a.work_type, a.status, a.created_at, a.updated_at, a.published_at,
                t.locale, t.title, t.summary, t.content_blocks, t.content_blocks_version
         FROM articles AS a
         JOIN article_translations AS t ON t.article_id = a.id
         WHERE a.author_id = $1 AND t.locale = $2
         ORDER BY a.updated_at DESC, a.id DESC
         LIMIT $3`,
        [actorId, locale, limit],
      );
      return rows.map(mapArticle);
    },
    async createArticle({ authorId, slug, title, summary = "", locale = "zh-CN", contentBlocks, contentBlocksVersion = 0, publish = false, workType = "other", categoryIds = [], tagIds = [] }) {
      requiredText("authorId", authorId, 300);
      const input = normalizeArticleInput({ slug, title, summary, locale, contentBlocks, contentBlocksVersion, publish, workType });
      const selectedCategories = normalizeTaxonomyIds("categoryIds", categoryIds, 20);
      const selectedTags = normalizeTaxonomyIds("tagIds", tagIds, 50);
      try {
        return await sql.begin(async (tx) => {
          const rows = await tx.unsafe(
            "INSERT INTO articles (id, author_id, slug, work_type, status, published_at) VALUES ($1, $2, $3, $4, $5, CASE WHEN $6 THEN now() ELSE NULL END) RETURNING id, author_id, slug, work_type, status, created_at, updated_at, published_at",
            [randomUUID(), authorId, input.slug, input.workType ?? "other", input.publish ? "published" : "draft", input.publish],
          );
          const article = rows[0];
          const translations = await tx.unsafe(
            "INSERT INTO article_translations (article_id, locale, title, summary, content_blocks, content_blocks_version) VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING locale, title, summary, content_blocks, content_blocks_version",
            [article.id, input.locale, input.title, input.summary, input.contentBlocks, input.contentBlocksVersion],
          );
          await replaceArticleTaxonomyKind(tx, article.id, "category", selectedCategories);
          await replaceArticleTaxonomyKind(tx, article.id, "tag", selectedTags);
          return mapArticle({ ...article, ...translations[0] });
        });
      } catch (error) {
        if (error?.code === "23505") throw new ArticleSlugConflictError();
        throw error;
      }
    },
    async updateArticle({ articleId, actorId, slug, title, summary = "", locale = "zh-CN", contentBlocks, contentBlocksVersion = 0, publish = false, workType = undefined, categoryIds = undefined, tagIds = undefined }) {

      if (!isUuid(articleId)) throw new ArticleInputError("articleId must be a valid article ID.");
      requiredText("actorId", actorId, 300);
      const input = normalizeArticleInput({ slug, title, summary, locale, contentBlocks, contentBlocksVersion, publish, workType });
      const selectedCategories = normalizeTaxonomyIds("categoryIds", categoryIds, 20);
      const selectedTags = normalizeTaxonomyIds("tagIds", tagIds, 50);
      try {
        return await sql.begin(async (tx) => {
          const ownership = await tx.unsafe("SELECT author_id FROM articles WHERE id = $1 FOR UPDATE", [articleId]);
          if (!ownership[0]) throw new ArticleNotFoundError();
          if (ownership[0].author_id !== actorId) throw new ArticleAuthorizationError();
          const rows = await tx.unsafe(
            "UPDATE articles SET slug = $2, work_type = COALESCE($6, work_type), status = $3, published_at = CASE WHEN $4 THEN COALESCE(published_at, now()) ELSE NULL END, updated_at = now() WHERE id = $1 AND author_id = $5 RETURNING id, author_id, slug, work_type, status, created_at, updated_at, published_at",
            [articleId, input.slug, input.publish ? "published" : "draft", input.publish, actorId, input.workType ?? null],
          );
          if (!rows[0]) throw new ArticleNotFoundError();
          const translations = await tx.unsafe(
            "INSERT INTO article_translations (article_id, locale, title, summary, content_blocks, content_blocks_version) VALUES ($1, $2, $3, $4, $5::jsonb, $6) ON CONFLICT (article_id, locale) DO UPDATE SET title = EXCLUDED.title, summary = EXCLUDED.summary, content_blocks = EXCLUDED.content_blocks, content_blocks_version = EXCLUDED.content_blocks_version, updated_at = now() RETURNING locale, title, summary, content_blocks, content_blocks_version",
            [articleId, input.locale, input.title, input.summary, input.contentBlocks, input.contentBlocksVersion],
          );
          await replaceArticleTaxonomyKind(tx, articleId, "category", selectedCategories);
          await replaceArticleTaxonomyKind(tx, articleId, "tag", selectedTags);
          return mapArticle({ ...rows[0], ...translations[0] });
        });
      } catch (error) {
        if (error?.code === "23505") throw new ArticleSlugConflictError();
        throw error;
      }
    },
    async createConversation({ actorId, participantIds }) {
      requiredText("actorId", actorId, 300);
      const suppliedIds = normalizeParticipantIds("participantIds", participantIds, 20);
      const others = suppliedIds.filter((id) => id !== actorId);
      if (others.length === 0) throw new ConversationInputError("A conversation requires at least one other participant.");
      const allIds = [actorId, ...others];
      const conversationId = randomUUID();
      return sql.begin(async (tx) => {
        const created = await tx.unsafe(
          "INSERT INTO conversations (id, created_by) VALUES ($1, $2) RETURNING id, created_by, created_at",
          [conversationId, actorId],
        );
        for (const userId of allIds) {
          await tx.unsafe(
            "INSERT INTO conversation_participants (conversation_id, user_id, last_read_at) VALUES ($1, $2, now())",
            [conversationId, userId],
          );
        }
        const row = created[0];
        return {
          id: row.id,
          createdBy: row.created_by,
          participantIds: allIds,
          createdAt: isoDate(row.created_at),
          lastActivityAt: isoDate(row.created_at),
          unreadCount: 0,
          lastMessage: null,
        };
      });
    },
    async updateConversationParticipants({ conversationId, actorId, addUserIds = [], removeUserIds = [] }) {
      requiredText("conversationId", conversationId, 300);
      requiredText("actorId", actorId, 300);
      const adds = normalizeParticipantIds("addUserIds", addUserIds, 20);
      const removes = normalizeParticipantIds("removeUserIds", removeUserIds, 20);
      if (removes.includes(actorId)) throw new ConversationInputError("The current user cannot remove themself; delete the conversation instead.");
      if (adds.some((id) => removes.includes(id))) throw new ConversationInputError("A user cannot be added and removed in the same operation.");
      return sql.begin(async (tx) => {
        const conversations = await tx.unsafe("SELECT created_by FROM conversations WHERE id = $1 FOR UPDATE", [conversationId]);
        if (!conversations[0]) throw new ConversationNotFoundError();
        const membership = await tx.unsafe(
          "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL",
          [conversationId, actorId],
        );
        if (membership.length === 0) throw new ConversationAccessError();
        if (conversations[0].created_by !== actorId) {
          throw new ConversationAccessError("Only the conversation creator can manage participants.");
        }
        if (removes.includes(conversations[0].created_by)) {
          throw new ConversationInputError("The conversation creator cannot be removed from its own conversation.");
        }
        for (const userId of adds) {
          await tx.unsafe(
            "INSERT INTO conversation_participants (conversation_id, user_id, last_read_at) VALUES ($1, $2, now()) ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_at = NULL, joined_at = CASE WHEN conversation_participants.left_at IS NOT NULL THEN now() ELSE conversation_participants.joined_at END, last_read_at = CASE WHEN conversation_participants.left_at IS NOT NULL THEN now() ELSE conversation_participants.last_read_at END",
            [conversationId, userId],
          );
        }
        for (const userId of removes) {
          await tx.unsafe(
            "UPDATE conversation_participants SET left_at = now() WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL",
            [conversationId, userId],
          );
        }
        return true;
      });
    },
    async deleteConversation({ conversationId, actorId }) {
      requiredText("conversationId", conversationId, 300);
      requiredText("actorId", actorId, 300);
      return sql.begin(async (tx) => {
        const rows = await tx.unsafe("SELECT created_by FROM conversations WHERE id = $1 FOR UPDATE", [conversationId]);
        if (!rows[0]) return false;
        if (rows[0].created_by !== actorId) {
          throw new ConversationAccessError("Only the conversation creator can delete this conversation.");
        }
        const membership = await tx.unsafe(
          "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL",
          [conversationId, actorId],
        );
        if (membership.length === 0) throw new ConversationAccessError();
        await tx.unsafe(
          "DELETE FROM outbox_events WHERE aggregate_id IN (SELECT id::text FROM messages WHERE conversation_id = $1)",
          [conversationId],
        );
        await tx.unsafe(
          "DELETE FROM notifications WHERE payload->>'conversationId' = $1 AND payload->>'type' = 'message.created'",
          [conversationId],
        );
        await tx.unsafe("DELETE FROM conversations WHERE id = $1", [conversationId]);
        return true;
      });
    },
    async markConversationAsRead({ conversationId, actorId }) {
      requiredText("conversationId", conversationId, 300);
      requiredText("actorId", actorId, 300);
      const rows = await sql.unsafe(
        "UPDATE conversation_participants SET last_read_at = now() WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL RETURNING user_id",
        [conversationId, actorId],
      );
      if (rows.length === 0) throw new ConversationAccessError();
      return true;
    },
    async listConversationMessages({ conversationId, actorId, limit = 100, before = null }) {
      for (const [name, value] of Object.entries({ conversationId, actorId })) {
        if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
          throw new TypeError(`${name} must be a non-empty, trimmed string.`);
        }
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new TypeError("limit must be an integer between 1 and 100.");
      }
      if (before !== null && !isUuid(before)) {
        throw new InvalidMessageCursorError("The message cursor must be a valid message ID.");
      }
      const membership = await sql.unsafe(
        "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL",
        [conversationId, actorId],
      );
      if (membership.length === 0) throw new ConversationAccessError();
      let rows;
      if (before === null) {
        rows = await sql.unsafe(
          "SELECT id, conversation_id, sender_id, body, created_at FROM (SELECT id, conversation_id, sender_id, body, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2) AS recent_messages ORDER BY created_at ASC, id ASC",
          [conversationId, limit],
        );
      } else {
        const cursors = await sql.unsafe(
          "SELECT id, created_at FROM messages WHERE id = $1 AND conversation_id = $2",
          [before, conversationId],
        );
        if (cursors.length === 0) throw new InvalidMessageCursorError();
        rows = await sql.unsafe(
          "SELECT id, conversation_id, sender_id, body, created_at FROM (SELECT id, conversation_id, sender_id, body, created_at FROM messages WHERE conversation_id = $1 AND (created_at, id) < ($3, $4) ORDER BY created_at DESC, id DESC LIMIT $2) AS older_messages ORDER BY created_at ASC, id ASC",
          [conversationId, limit, cursors[0].created_at, cursors[0].id],
        );
      }
      return rows.map((row) => mapMessage(row));
    },
    async getConversation({ conversationId, actorId }) {
      requiredText("conversationId", conversationId, 300);
      requiredText("actorId", actorId, 300);
      const rows = await sql.unsafe(
        `SELECT c.id, c.created_by, c.created_at,
                COALESCE(latest.created_at, c.created_at) AS last_activity_at,
                participants.user_ids AS participant_ids,
                latest.id AS latest_message_id,
                latest.conversation_id AS latest_message_conversation_id,
                latest.sender_id AS latest_message_sender_id,
                latest.body AS latest_message_body,
                latest.created_at AS latest_message_created_at,
                (SELECT count(*)::int FROM messages AS unread
                 WHERE unread.conversation_id = c.id
                   AND unread.sender_id <> $1
                   AND (membership.last_read_at IS NULL OR unread.created_at > membership.last_read_at)) AS unread_count
         FROM conversation_participants AS membership
         JOIN conversations AS c ON c.id = membership.conversation_id
         LEFT JOIN LATERAL (
           SELECT m.id, m.conversation_id, m.sender_id, m.body, m.created_at
           FROM messages AS m
           WHERE m.conversation_id = c.id
           ORDER BY m.created_at DESC, m.id DESC
           LIMIT 1
         ) AS latest ON true
         LEFT JOIN LATERAL (
           SELECT array_agg(cp.user_id ORDER BY cp.user_id) AS user_ids
           FROM conversation_participants AS cp
           WHERE cp.conversation_id = c.id AND cp.left_at IS NULL
         ) AS participants ON true
         WHERE membership.user_id = $1 AND membership.conversation_id = $2 AND membership.left_at IS NULL
         LIMIT 1`,
        [actorId, conversationId],
      );
      return rows[0] ? mapConversation(rows[0]) : null;
    },
    async listConversations({ actorId, limit = 50 }) {
      if (typeof actorId !== "string" || actorId.trim().length === 0 || actorId !== actorId.trim()) {
        throw new TypeError("actorId must be a non-empty, trimmed string.");
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new TypeError("limit must be an integer between 1 and 100.");
      }
      const rows = await sql.unsafe(
        `SELECT c.id, c.created_by, c.created_at,
                COALESCE(latest.created_at, c.created_at) AS last_activity_at,
                participants.user_ids AS participant_ids,
                latest.id AS latest_message_id,
                latest.conversation_id AS latest_message_conversation_id,
                latest.sender_id AS latest_message_sender_id,
                latest.body AS latest_message_body,
                latest.created_at AS latest_message_created_at,
                (SELECT count(*)::int FROM messages AS unread
                 WHERE unread.conversation_id = c.id
                   AND unread.sender_id <> $1
                   AND (membership.last_read_at IS NULL OR unread.created_at > membership.last_read_at)) AS unread_count
         FROM conversation_participants AS membership
         JOIN conversations AS c ON c.id = membership.conversation_id
         LEFT JOIN LATERAL (
           SELECT m.id, m.conversation_id, m.sender_id, m.body, m.created_at
           FROM messages AS m
           WHERE m.conversation_id = c.id
           ORDER BY m.created_at DESC, m.id DESC
           LIMIT 1
         ) AS latest ON true
         LEFT JOIN LATERAL (
           SELECT array_agg(cp.user_id ORDER BY cp.user_id) AS user_ids
           FROM conversation_participants AS cp
           WHERE cp.conversation_id = c.id AND cp.left_at IS NULL
         ) AS participants ON true
         WHERE membership.user_id = $1 AND membership.left_at IS NULL
         ORDER BY COALESCE(latest.created_at, c.created_at) DESC, c.id DESC
         LIMIT $2`,
        [actorId, limit],
      );
      return rows.map(mapConversation);
    },
    async persistMessage({ conversationId, senderId, body, idempotencyKey }) {
      for (const [name, value] of Object.entries({ conversationId, senderId, body, idempotencyKey })) {
        if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
          throw new TypeError(`${name} must be a non-empty, trimmed string.`);
        }
      }
      const hash = requestHash({ conversationId, senderId, body });
      return sql.begin(async (tx) => {
        // Serialize the membership check and outbox insert with participant
        // changes, deletion and notification delivery, all of which lock this
        // conversation first. Otherwise a removed sender can still write or
        // deletion can sweep the outbox before an in-flight message commits.
        const conversation = await tx.unsafe("SELECT id FROM conversations WHERE id = $1 FOR UPDATE", [conversationId]);
        if (!conversation[0]) throw new ConversationAccessError();
        const participants = await tx.unsafe(
          "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL",
          [conversationId, senderId],
        );
        if (participants.length === 0) throw new ConversationAccessError();
        const existing = await findMessage(tx, senderId, idempotencyKey);
        if (existing) return assertSameRequest(existing, hash);

        const inserted = await tx.unsafe(
          "INSERT INTO messages (id, conversation_id, sender_id, body, idempotency_key, request_hash) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (sender_id, idempotency_key) DO NOTHING RETURNING id, conversation_id, sender_id, body, request_hash, created_at",
          [randomUUID(), conversationId, senderId, body, idempotencyKey, hash],
        );
        if (inserted.length === 0) {
          const raced = await findMessage(tx, senderId, idempotencyKey);
          if (!raced) throw new Error("Idempotency conflict row disappeared during transaction.");
          return assertSameRequest(raced, hash);
        }
        const message = inserted[0];
        await tx.unsafe(
          "INSERT INTO outbox_events (id, event_key, event_type, aggregate_id, payload) VALUES ($1, $2, $3, $4, $5::jsonb)",
          [randomUUID(), `message:${message.id}`, "message.created", message.id,
            { messageId: message.id, conversationId: message.conversation_id, senderId: message.sender_id }],
        );
        return mapMessage(message, false);
      });
    },
    async claimOutboxEvents({ limit = 25, leaseSeconds = 60 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new TypeError("limit must be an integer between 1 and 100.");
      }
      if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3600) {
        throw new TypeError("leaseSeconds must be an integer between 1 and 3600.");
      }
      return sql.begin(async (tx) => tx.unsafe(
        `WITH picked AS (
          SELECT id FROM outbox_events
          WHERE delivered_at IS NULL AND available_at <= now()
          ORDER BY created_at, id
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE outbox_events AS event
        SET attempts = event.attempts + 1,
            available_at = clock_timestamp() + ($2 * interval '1 second'),
            lease_token = gen_random_uuid()
        FROM picked
        WHERE event.id = picked.id
        RETURNING event.id, event.event_key, event.event_type, event.aggregate_id,
                  event.payload, event.attempts, event.available_at, event.lease_token`,
        [limit, leaseSeconds],
      ));
    },
    async markOutboxDelivered({ eventId, leaseToken }) {
      assertOutboxLease(eventId, leaseToken);
      // Lock first and evaluate the wall clock after acquiring the lock. A
      // statement delayed by another transaction must not use a stale time.
      const rows = await sql.unsafe(
        `WITH locked AS MATERIALIZED (
           SELECT id, lease_token, available_at, delivered_at
           FROM outbox_events WHERE id = $1 FOR UPDATE
         )
         UPDATE outbox_events AS event
         SET delivered_at = clock_timestamp(), lease_token = NULL
         FROM locked
         WHERE event.id = locked.id AND locked.delivered_at IS NULL
           AND locked.lease_token = $2 AND locked.available_at > clock_timestamp()
         RETURNING event.id`,
        [eventId, leaseToken],
      );
      return rows.length === 1;
    },
    async rescheduleOutboxEvent({ eventId, leaseToken, delaySeconds = 30 }) {
      assertOutboxLease(eventId, leaseToken);
      if (!Number.isInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > 86400) {
        throw new TypeError("delaySeconds must be an integer between 1 and 86400.");
      }
      const rows = await sql.unsafe(
        `WITH locked AS MATERIALIZED (
           SELECT id, lease_token, available_at, delivered_at
           FROM outbox_events WHERE id = $1 FOR UPDATE
         )
         UPDATE outbox_events AS event
         SET available_at = clock_timestamp() + ($3 * interval '1 second'), lease_token = NULL
         FROM locked
         WHERE event.id = locked.id AND locked.delivered_at IS NULL
           AND locked.lease_token = $2 AND locked.available_at > clock_timestamp()
         RETURNING event.id`,
        [eventId, leaseToken, delaySeconds],
      );
      return rows.length === 1;
    },
    async listConversationParticipantIds({ conversationId }) {
      if (typeof conversationId !== "string" || conversationId.trim().length === 0 || conversationId !== conversationId.trim()) {
        throw new TypeError("conversationId must be a non-empty, trimmed string.");
      }
      const rows = await sql.unsafe(
        "SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND left_at IS NULL ORDER BY user_id",
        [conversationId],
      );
      return rows.map((row) => row.user_id);
    },
    async deliverMessageNotifications({ eventKey, messageId, conversationId, senderId }) {
      for (const [name, value] of Object.entries({ eventKey, conversationId, senderId })) requiredText(name, value, 300);
      if (!isUuid(messageId)) throw new TypeError("messageId must be a valid UUID.");
      const payload = { type: "message.created", messageId, conversationId, senderId };
      const hash = requestHash(payload);
      return sql.begin(async (tx) => {
        // All membership edits and deletes lock this same row first. A stale
        // event whose conversation has been deleted is a harmless no-op.
        const conversation = await tx.unsafe("SELECT id FROM conversations WHERE id = $1 FOR UPDATE", [conversationId]);
        if (!conversation[0]) return false;
        const messages = await tx.unsafe(
          "SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $2 AND sender_id = $3",
          [messageId, conversationId, senderId],
        );
        if (!messages[0]) throw new Error("Message notification event does not match a persisted message.");
        const participants = await tx.unsafe(
          "SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND left_at IS NULL AND user_id <> $2 ORDER BY user_id",
          [conversationId, senderId],
        );
        for (const { user_id: userId } of participants) {
          const inserted = await tx.unsafe(
            "INSERT INTO notifications (id, user_id, event_key, payload, payload_hash) VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT (user_id, event_key) DO NOTHING RETURNING id",
            [randomUUID(), userId, eventKey, payload, hash],
          );
          if (inserted.length === 0) {
            const existing = await tx.unsafe(
              "SELECT payload_hash FROM notifications WHERE user_id = $1 AND event_key = $2",
              [userId, eventKey],
            );
            if (!existing[0]) throw new Error("Notification idempotency row disappeared during transaction.");
            if (existing[0].payload_hash !== hash) throw new IdempotencyConflictError("The notification event key was already used with a different payload.");
          }
        }
        return true;
      });
    },
    async listNotifications({ actorId, limit = 50 }) {
      if (typeof actorId !== "string" || actorId.trim().length === 0 || actorId !== actorId.trim()) {
        throw new TypeError("actorId must be a non-empty, trimmed string.");
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new TypeError("limit must be an integer between 1 and 100.");
      }
      const rows = await sql.unsafe(
        "SELECT id, user_id, event_key, payload, created_at, read_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2",
        [actorId, limit],
      );
      return rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        eventKey: row.event_key,
        payload: parseJsonValue(row.payload),
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
        readAt: row.read_at == null ? null : (row.read_at instanceof Date ? row.read_at.toISOString() : new Date(row.read_at).toISOString()),
      }));
    },
    async getUnreadNotificationCount({ actorId }) {
      if (typeof actorId !== "string" || actorId.trim().length === 0 || actorId !== actorId.trim()) {
        throw new TypeError("actorId must be a non-empty, trimmed string.");
      }
      const rows = await sql.unsafe(
        "SELECT count(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL",
        [actorId],
      );
      return rows[0].count;
    },
    async markAllNotificationsRead({ actorId }) {
      if (typeof actorId !== "string" || actorId.trim().length === 0 || actorId !== actorId.trim()) {
        throw new TypeError("actorId must be a non-empty, trimmed string.");
      }
      const rows = await sql.unsafe(
        "UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL RETURNING id",
        [actorId],
      );
      return rows.length;
    },
    async markNotificationRead({ notificationId, actorId }) {
      if (typeof actorId !== "string" || actorId.trim().length === 0 || actorId !== actorId.trim()) {
        throw new TypeError("actorId must be a non-empty, trimmed string.");
      }
      if (!isUuid(notificationId)) {
        throw new InvalidMessageCursorError("notificationId must be a valid notification ID.");
      }
      const rows = await sql.unsafe(
        "UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2 RETURNING id, user_id, event_key, payload, created_at, read_at",
        [notificationId, actorId],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        userId: row.user_id,
        eventKey: row.event_key,
        payload: parseJsonValue(row.payload),
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
        readAt: row.read_at instanceof Date ? row.read_at.toISOString() : new Date(row.read_at).toISOString(),
      };
    },
    async createNotification({ userId, eventKey, payload }) {
      for (const [name, value] of Object.entries({ userId, eventKey })) {
        if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
          throw new TypeError(`${name} must be a non-empty, trimmed string.`);
        }
      }
      if (payload === undefined) throw new TypeError("payload is required.");
      const hash = requestHash(payload);
      return sql.begin(async (tx) => {
        const inserted = await tx.unsafe(
          "INSERT INTO notifications (id, user_id, event_key, payload, payload_hash) VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT (user_id, event_key) DO NOTHING RETURNING id, user_id, event_key, payload, created_at, payload_hash",
          [randomUUID(), userId, eventKey, payload, hash],
        );
        let row = inserted[0];
        let duplicate = false;
        if (!row) {
          const existing = await tx.unsafe(
            "SELECT id, user_id, event_key, payload, created_at, payload_hash FROM notifications WHERE user_id = $1 AND event_key = $2",
            [userId, eventKey],
          );
          row = existing[0];
          if (!row) throw new Error("Notification idempotency row disappeared during transaction.");
          if (row.payload_hash !== hash) throw new IdempotencyConflictError("The notification event key was already used with a different payload.");
          duplicate = true;
        }
        return { id: row.id, userId: row.user_id, eventKey: row.event_key, payload: parseJsonValue(row.payload), createdAt: row.created_at, duplicate };
      });
    },
    async isSessionRevoked(sessionId) {
      const rows = await sql.unsafe("SELECT 1 FROM revoked_sessions WHERE session_id = $1 AND expires_at > now()", [sessionId]);
      return rows.length > 0;
    },
  });
}
