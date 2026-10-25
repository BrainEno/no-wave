import { createHash, randomUUID } from "node:crypto";
import { ArticleAuthorizationError, ArticleInputError, ArticleNotFoundError } from "../domain/errors.mjs";
import { validateArticleLocale, validateArticleSlug } from "../domain/article.mjs";
import { isUuid, requiredText } from "../domain/validation.mjs";

export function createSqliteEngagementStore(db) {
  if (!db || typeof db.prepare !== "function" || typeof db.exec !== "function") {
    throw new TypeError("A node:sqlite DatabaseSync connection is required.");
  }
  const run = (sql, ...params) => db.prepare(sql).run(...params);
  const get = (sql, ...params) => db.prepare(sql).get(...params);
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const transaction = (work) => {
    db.exec("BEGIN IMMEDIATE");
    try { const value = work(); db.exec("COMMIT"); return value; }
    catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
  };
  const requestHash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const validateActor = (actorId) => requiredText("actorId", actorId, 300);
  function publishedArticle(slug, locale) {
    validateArticleSlug(slug);
    validateArticleLocale(locale);
    const row = get("SELECT a.id, a.author_id, a.slug FROM articles a JOIN article_translations t ON t.article_id = a.id WHERE a.slug = ? AND a.status = 'published' AND t.locale = ? LIMIT 1", slug, locale);
    if (!row) throw new ArticleNotFoundError("The published article was not found in this locale.");
    return row;
  }
  function likeInfo({ slug, locale = "zh-CN", actorId = null }) {
    validateArticleSlug(slug);
    validateArticleLocale(locale);
    if (actorId !== null) validateActor(actorId);
    const row = get("SELECT a.id AS article_id, a.slug, count(l.user_id) AS like_count, CASE WHEN ? IS NULL THEN 0 ELSE EXISTS(SELECT 1 FROM article_likes own_like WHERE own_like.article_id = a.id AND own_like.user_id = ?) END AS liked_by_viewer FROM articles a JOIN article_translations t ON t.article_id = a.id LEFT JOIN article_likes l ON l.article_id = a.id WHERE a.slug = ? AND a.status = 'published' AND t.locale = ? GROUP BY a.id, a.slug", actorId, actorId, slug, locale);
    return row ? { articleId: row.article_id, slug: row.slug, likeCount: Number(row.like_count), likedByViewer: Boolean(row.liked_by_viewer) } : null;
  }
  function mapComment(row) {
    const iso = (value) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
    return { id: row.id, articleId: row.article_id, authorId: row.author_id, parentCommentId: row.parent_comment_id ?? null, content: row.content, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), locale: row.locale, replies: [] };
  }
  function notify(userId, eventKey, payload) {
    run("INSERT INTO notifications (id, user_id, event_key, payload, payload_hash) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id, event_key) DO NOTHING", randomUUID(), userId, eventKey, JSON.stringify(payload), requestHash(payload));
  }
  function insertLikeNotification(article, slug, locale, actorId) {
    if (article.author_id === actorId) return;
    const payload = { type: "article.liked", articleId: article.id, slug, actorId, locale };
    notify(article.author_id, "article.liked:" + article.id + ":" + actorId + ":" + randomUUID(), payload);
  }

  return Object.freeze({
    getArticleLikeInfo(args) { return likeInfo(args); },
    toggleArticleLike({ slug, locale = "zh-CN", actorId }) {
      validateActor(actorId);
      return transaction(() => {
        const article = publishedArticle(slug, locale);
        const existing = get("SELECT 1 AS present FROM article_likes WHERE article_id = ? AND user_id = ?", article.id, actorId);
        if (existing) run("DELETE FROM article_likes WHERE article_id = ? AND user_id = ?", article.id, actorId);
        else {
          const inserted = run("INSERT INTO article_likes (article_id, user_id) VALUES (?, ?) ON CONFLICT (article_id, user_id) DO NOTHING", article.id, actorId);
          if (inserted.changes === 1) insertLikeNotification(article, slug, locale, actorId);
        }
        return likeInfo({ slug, locale, actorId });
      });
    },
    setArticleLike({ slug, locale = "zh-CN", actorId, liked }) {
      validateArticleSlug(slug); validateArticleLocale(locale); validateActor(actorId);
      if (typeof liked !== "boolean") throw new ArticleInputError("liked must be a boolean.");
      return transaction(() => {
        const article = publishedArticle(slug, locale);
        const existing = get("SELECT 1 AS present FROM article_likes WHERE article_id = ? AND user_id = ?", article.id, actorId);
        if (liked && !existing) {
          const inserted = run("INSERT INTO article_likes (article_id, user_id) VALUES (?, ?) ON CONFLICT (article_id, user_id) DO NOTHING", article.id, actorId);
          if (inserted.changes === 1) insertLikeNotification(article, slug, locale, actorId);
        } else if (!liked && existing) run("DELETE FROM article_likes WHERE article_id = ? AND user_id = ?", article.id, actorId);
        return likeInfo({ slug, locale, actorId });
      });
    },
    listArticleComments({ slug, locale = "zh-CN", limit = 50 }) {
      validateArticleSlug(slug); validateArticleLocale(locale);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ArticleInputError("limit must be an integer between 1 and 100.");
      const rows = all("WITH RECURSIVE target_article AS (SELECT a.id FROM articles a JOIN article_translations t ON t.article_id = a.id WHERE a.slug = ? AND a.status = 'published' AND t.locale = ?), root_comments AS (SELECT c.id, c.article_id, c.author_id, c.parent_comment_id, c.content, c.created_at, c.updated_at, 0 AS depth FROM article_comments c JOIN target_article a ON a.id = c.article_id WHERE c.parent_comment_id IS NULL ORDER BY c.created_at ASC, c.id ASC LIMIT ?), comment_tree AS (SELECT * FROM root_comments UNION ALL SELECT child.id, child.article_id, child.author_id, child.parent_comment_id, child.content, child.created_at, child.updated_at, parent.depth + 1 FROM article_comments child JOIN comment_tree parent ON child.parent_comment_id = parent.id WHERE parent.depth < 10) SELECT id, article_id, author_id, parent_comment_id, content, created_at, updated_at, depth FROM comment_tree ORDER BY created_at ASC, id ASC", slug, locale, limit);
      const nodes = new Map();
      for (const row of rows) nodes.set(row.id, mapComment({ ...row, locale }));
      const roots = [];
      for (const node of nodes.values()) {
        if (node.parentCommentId && nodes.has(node.parentCommentId)) nodes.get(node.parentCommentId).replies.push(node);
        else roots.push(node);
      }
      return roots;
    },
    createArticleComment({ slug, locale = "zh-CN", actorId, content, parentCommentId = null }) {
      validateActor(actorId); validateArticleSlug(slug); validateArticleLocale(locale);
      if (typeof content !== "string" || content.trim().length === 0 || content.length > 5000) throw new ArticleInputError("content must be non-empty and no longer than 5000 characters.");
      if (parentCommentId !== null && !isUuid(parentCommentId)) throw new ArticleInputError("parentCommentId must be a valid comment ID.");
      return transaction(() => {
        const article = publishedArticle(slug, locale);
        let parentAuthorId = null;
        if (parentCommentId !== null) {
          const parent = get("SELECT author_id FROM article_comments WHERE id = ? AND article_id = ?", parentCommentId, article.id);
          if (!parent) throw new ArticleInputError("parentCommentId must reference a comment on this article.");
          parentAuthorId = parent.author_id;
        }
        const id = randomUUID();
        run("INSERT INTO article_comments (id, article_id, author_id, parent_comment_id, content) VALUES (?, ?, ?, ?, ?)", id, article.id, actorId, parentCommentId, content.trim());
        const row = get("SELECT id, article_id, author_id, parent_comment_id, content, created_at, updated_at FROM article_comments WHERE id = ?", id);
        const recipients = new Map();
        if (article.author_id !== actorId) recipients.set(article.author_id, "article.commented");
        if (parentAuthorId && parentAuthorId !== actorId) recipients.set(parentAuthorId, "article.comment_replied");
        for (const [userId, type] of recipients) {
          const payload = { type, articleId: article.id, slug, commentId: id, commenterId: actorId, parentCommentId };
          notify(userId, type + ":" + id, payload);
        }
        return mapComment({ ...row, locale });
      });
    },
    deleteArticleComment({ commentId, actorId }) {
      if (!isUuid(commentId)) throw new ArticleInputError("commentId must be a valid comment ID.");
      validateActor(actorId);
      return transaction(() => {
        const row = get("SELECT author_id FROM article_comments WHERE id = ?", commentId);
        if (!row) return false;
        if (row.author_id !== actorId) throw new ArticleAuthorizationError("You can delete only your own comment.");
        run("DELETE FROM article_comments WHERE id = ?", commentId);
        return true;
      });
    },
  });
}
