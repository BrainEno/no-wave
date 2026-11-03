/**
 * PostgreSQL persistence slice: Article likes and threaded comments.
 *
 * Composed by postgres.ts. Row mapping and shared SQL helpers live in
 * postgres-shared.ts so every slice reads rows the same way.
 */
import { randomUUID } from "node:crypto";
import { validateArticleLocale, validateArticleSlug } from "../domain/article.ts";
import { validateStoredCommentContent } from "../domain/comment-content.ts";
import { ArticleAuthorizationError, ArticleInputError, ArticleNotFoundError, IdempotencyConflictError } from "../domain/errors.ts";
import { isUuid, requiredText } from "../domain/validation.ts";
import { migrationEntityKey } from "./postgres-provider-migration-capture.ts";
import { mapArticleComment, readArticleLikeInfo, requestHash } from "./postgres-shared.ts";
import { createMigrationTransactionId } from "./provider-migration-journal.ts";
import type { PostgresStoreContext } from "./postgres-shared.ts";
import type { EngagementPersistencePort } from "../application/persistence-ports.ts";

export function createPostgresEngagementStore(ctx: PostgresStoreContext) {
  const { sql, captureChanges } = ctx;
  return Object.freeze({
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
            const notificationId = randomUUID();
            const eventKey = `article.liked:${articleId}:${actorId}:${randomUUID()}`;
            await tx.unsafe(
              "INSERT INTO notifications (id, user_id, event_key, payload, payload_hash) VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT (user_id, event_key) DO NOTHING",
              [notificationId, article.author_id, eventKey, payload, requestHash(payload)],
            );
            const notificationRows = await tx.unsafe("SELECT * FROM notifications WHERE id = $1", [notificationId]);
            if (notificationRows[0]) changes.push({ entityType: "notifications", entityId: notificationId, operation: "upsert", payload: notificationRows[0] });
            }
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
            const notificationId = randomUUID();
            const eventKey = `article.liked:${article.id}:${actorId}:${randomUUID()}`;
            await tx.unsafe(
              "INSERT INTO notifications (id, user_id, event_key, payload, payload_hash) VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT (user_id, event_key) DO NOTHING",
              [notificationId, article.author_id, eventKey, payload, requestHash(payload)],
            );
            const notificationRows = await tx.unsafe("SELECT * FROM notifications WHERE id = $1", [notificationId]);
            if (notificationRows[0]) changes.push({ entityType: "notifications", entityId: notificationId, operation: "upsert", payload: notificationRows[0] });
            }
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

    async createArticleComment({ slug, locale = "zh-CN", actorId, content, contentBlocks = null, contentBlocksVersion = 0, parentCommentId = null, idempotencyKey = null }) {
      validateArticleSlug(slug);
      validateArticleLocale(locale);
      requiredText("actorId", actorId, 300);
      const normalizedContent = validateStoredCommentContent({ content, contentBlocks, contentBlocksVersion });
      if (parentCommentId !== null && !isUuid(parentCommentId)) {
        throw new ArticleInputError("parentCommentId must be a valid comment ID.");
      }
      if (idempotencyKey !== null && (typeof idempotencyKey !== "string" || idempotencyKey.length === 0 ||
          idempotencyKey.length > 300 || idempotencyKey.trim() !== idempotencyKey)) {
        throw new ArticleInputError("Idempotency-Key must be a non-empty trimmed string no longer than 300 characters.");
      }
      const idempotencyKeyHash = idempotencyKey === null ? null : requestHash({
        method: "POST", route: "/api/v1/articles/" + slug + "/comments", actorId, key: idempotencyKey,
      });
      const fingerprint = requestHash({
        slug, locale, actorId, content: normalizedContent.content,
        contentBlocks: normalizedContent.contentBlocks,
        contentBlocksVersion: normalizedContent.contentBlocksVersion, parentCommentId,
      });
      return sql.begin(async (tx) => {
        if (idempotencyKeyHash !== null) {
          const existing = await tx.unsafe(
            "SELECT * FROM article_comments WHERE author_id = $1 AND idempotency_key_hash = $2 FOR UPDATE",
            [actorId, idempotencyKeyHash],
          );
          if (existing[0]) {
            if (existing[0].request_hash !== fingerprint) throw new IdempotencyConflictError();
            return mapArticleComment({ ...existing[0], locale });
          }
        }
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
          "INSERT INTO article_comments (id, article_id, author_id, parent_comment_id, content, content_blocks, content_blocks_version, idempotency_key_hash, request_hash) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9) ON CONFLICT (author_id, idempotency_key_hash) WHERE idempotency_key_hash IS NOT NULL DO NOTHING RETURNING *",
          [randomUUID(), article.id, actorId, parentCommentId, normalizedContent.content,
            normalizedContent.contentBlocks === null ? null : normalizedContent.contentBlocks,
            normalizedContent.contentBlocksVersion, idempotencyKeyHash, idempotencyKeyHash === null ? null : fingerprint],
        );
        let comment = rows[0];
        if (!comment && idempotencyKeyHash !== null) {
          // A concurrent request may have committed after our first read. The
          // unique index is the arbiter; read its winner under a fresh statement snapshot.
          const raced = await tx.unsafe(
            "SELECT * FROM article_comments WHERE author_id = $1 AND idempotency_key_hash = $2 FOR UPDATE",
            [actorId, idempotencyKeyHash],
          );
          if (!raced[0]) throw new Error("Idempotency record disappeared during comment creation.");
          if (raced[0].request_hash !== fingerprint) throw new IdempotencyConflictError();
          return mapArticleComment({ ...raced[0], locale });
        }
        if (!comment) throw new Error("Comment insert did not return a row.");
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

    /**
     * Everyone who has commented on a work, once each (see the SQLite slice for
     * why deleting one needs this list). Distinct, oldest comment first, and
     * bounded because it is read inside the deleting request.
     */
    async listArticleCommentAuthorIds({ articleId, limit = 200 }) {
      if (!isUuid(articleId)) throw new ArticleInputError("articleId must be a valid article ID.");
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new ArticleInputError("limit must be an integer between 1 and 1000.");
      const rows = await sql.unsafe(
        `SELECT author_id, min(created_at) AS first_at
         FROM article_comments
         WHERE article_id = $1
         GROUP BY author_id
         ORDER BY first_at ASC, author_id ASC
         LIMIT $2`,
        [articleId, limit],
      );
      return rows.map((row) => String(row.author_id));
    },

  }) satisfies EngagementPersistencePort;
}
