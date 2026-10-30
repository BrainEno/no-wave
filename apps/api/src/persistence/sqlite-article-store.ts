import { randomUUID } from "node:crypto";
import { createMigrationTransactionId } from "./provider-migration-journal.ts";
import { createSqliteProviderMigrationCapture, migrationEntityKey } from "./sqlite-provider-migration-capture.ts";
import {
  ArticleInputError,
  ArticleSlugConflictError,
  ArticleAuthorizationError,
  ArticleNotFoundError,
} from "../domain/errors.ts";
import {
  validateArticleLocale,
  validateArticleSlug,
  normalizeArticleInput,
  normalizeTaxonomyIds,
} from "../domain/article.ts";
import { isUuid, requiredText } from "../domain/validation.ts";

/**
 * SQLite implementation of the article/content persistence slice.
 * This is a domain slice composed into the SQLite provider by sqlite-store.ts.
 */
export function createSqliteArticleStore(db) {
  if (!db || typeof db.prepare !== "function" || typeof db.exec !== "function") {
    throw new TypeError("A node:sqlite DatabaseSync connection is required.");
  }

  const migrationCapture = createSqliteProviderMigrationCapture(db);

  const articleSelect = `
    SELECT a.id, a.author_id, a.slug, a.work_type, a.status, t.locale,
           t.title, t.summary, t.content_blocks, t.content_blocks_version, a.created_at, a.updated_at, a.published_at
    FROM articles a
    JOIN article_translations t ON t.article_id = a.id
  `;
  const mapArticle = (row) => row ? ({
    id: row.id,
    authorId: row.author_id,
    slug: row.slug,
    workType: row.work_type ?? "other",
    status: row.status,
    locale: row.locale,
    title: row.title,
    summary: row.summary,
    contentBlocks: JSON.parse(row.content_blocks),
    contentBlocksVersion: row.content_blocks_version ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
  }) : null;
  // The desk's recycle bin reads the same article shape plus the tombstone
  // timestamp, so it gets its own select rather than a flag on the shared one.
  const deletedArticleSelect = `
    SELECT a.id, a.author_id, a.slug, a.work_type, a.status, t.locale,
           t.title, t.summary, t.content_blocks, t.content_blocks_version, a.created_at, a.updated_at, a.published_at, a.deleted_at
    FROM articles a
    JOIN article_translations t ON t.article_id = a.id
  `;
  const mapDeletedArticle = (row) => row ? ({ ...mapArticle(row), deletedAt: row.deleted_at }) : null;
  const statement = (sql) => db.prepare(sql);
  const publishedArticleBySlug = statement(
    articleSelect + " WHERE a.slug = ? AND a.status = 'published' AND t.locale = ? LIMIT 1",
  );

  function transaction(work) {
    const transactionId = createMigrationTransactionId();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work(transactionId);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* preserve original failure */ }
      throw error;
    }
  }

  function replaceTaxonomies(articleId, kind, ids) {
    if (ids === undefined) return;
    if (ids.length) {
      const placeholders = ids.map(() => "?").join(", ");
      const found = statement(
        `SELECT id FROM taxonomies WHERE kind = ? AND id IN (${placeholders})`,
      ).all(kind, ...ids);
      if (found.length !== ids.length) {
        throw new ArticleInputError(`All selected ${kind} IDs must reference existing ${kind} taxonomies.`);
      }
    }
    statement(`DELETE FROM article_taxonomies WHERE article_id = ? AND taxonomy_id IN (SELECT id FROM taxonomies WHERE kind = ?)`)
      .run(articleId, kind);
    const insert = statement("INSERT INTO article_taxonomies (article_id, taxonomy_id) VALUES (?, ?) ON CONFLICT DO NOTHING");
    for (const id of ids) insert.run(articleId, id);
  }


  /**
   * Capture only the `articles` row into the provider-migration journal.
   *
   * Deletion changes no translation and no taxonomy link, so this is the whole
   * change set — and capturing the row is what keeps a replica that is replaying
   * this journal from keeping a work the author just deleted.
   */
  function captureArticleRow(transactionId, articleId) {
    const article = statement("SELECT * FROM articles WHERE id = ?").get(articleId);
    if (!article) return;
    migrationCapture.captureInTransaction(db, transactionId, [
      { entityType: "articles", entityId: articleId, operation: "upsert", payload: article },
    ]);
  }

  function captureArticleState(transactionId, articleId, locale, previousLinks = []) {
    const article = statement("SELECT * FROM articles WHERE id = ?").get(articleId);
    const translation = statement("SELECT * FROM article_translations WHERE article_id = ? AND locale = ?").get(articleId, locale);
    const links = statement("SELECT article_id, taxonomy_id FROM article_taxonomies WHERE article_id = ?").all(articleId);
    const currentIds = new Set(links.map((link) => link.taxonomy_id));
    const changes = [];
    if (article) changes.push({ entityType: "articles", entityId: articleId, operation: "upsert", payload: article });
    if (translation) changes.push({ entityType: "article_translations", entityId: migrationEntityKey(articleId, locale), operation: "upsert", payload: translation });
    for (const link of links) changes.push({ entityType: "article_taxonomies", entityId: migrationEntityKey(articleId, link.taxonomy_id), operation: "upsert", payload: link });
    for (const link of previousLinks) if (!currentIds.has(link.taxonomy_id)) changes.push({ entityType: "article_taxonomies", entityId: migrationEntityKey(articleId, link.taxonomy_id), operation: "delete", payload: null });
    migrationCapture.captureInTransaction(db, transactionId, changes);
  }

  return Object.freeze({
    listPublishedArticles({ locale = "zh-CN", query = "", authorId = null, limit = 20, offset = 0 } = {}) {
      validateArticleLocale(locale);
      if (typeof query !== "string" || query.length > 200) throw new ArticleInputError("query must be a string no longer than 200 characters.");
      if (authorId !== null) requiredText("authorId", authorId, 300);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ArticleInputError("limit must be an integer between 1 and 100.");
      if (!Number.isInteger(offset) || offset < 0 || offset > 100000) throw new ArticleInputError("offset must be an integer between 0 and 100000.");
      const needle = query.trim().toLocaleLowerCase(locale);
      const rows = statement(articleSelect + `
        WHERE a.status = 'published' AND t.locale = ?
          AND (? = '' OR instr(lower(t.title), lower(?)) > 0 OR instr(lower(t.summary), lower(?)) > 0)
          AND (? IS NULL OR a.author_id = ?)
        ORDER BY a.published_at DESC, a.id DESC
        LIMIT ? OFFSET ?
      `).all(locale, needle, needle, needle, authorId, authorId, limit, offset);
      return rows.map(mapArticle);
    },

    getPublishedArticle({ slug, locale = "zh-CN" }) {
      validateArticleSlug(slug);
      validateArticleLocale(locale);
      return mapArticle(publishedArticleBySlug.get(slug, locale));
    },

    listMyArticles({ actorId, locale = "zh-CN", limit = 50 }) {
      requiredText("actorId", actorId, 300);
      validateArticleLocale(locale);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ArticleInputError("limit must be an integer between 1 and 100.");
      // A deleted work is a tombstone the author cannot act on any more, so the
      // desk must not list it — deletion would otherwise be invisible.
      return statement(articleSelect + " WHERE a.author_id = ? AND t.locale = ? AND a.deleted_at IS NULL ORDER BY a.updated_at DESC, a.id LIMIT ?")
        .all(actorId, locale, limit).map(mapArticle);
    },

    /**
     * The author's own tombstones, newest deletion first.
     *
     * This is the list that makes a soft delete honest: without it, a deleted
     * work is invisible and unrecoverable, which is the one thing an author
     * cannot tell apart from a bug. `purgesAt` is deliberately *not* computed
     * here — the retention window is policy the service layer owns, so a store
     * test never has to fake an environment to read a timestamp.
     */
    listMyDeletedArticles({ actorId, locale = "zh-CN", limit = 50 }) {
      requiredText("actorId", actorId, 300);
      validateArticleLocale(locale);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ArticleInputError("limit must be an integer between 1 and 100.");
      return statement(deletedArticleSelect + " WHERE a.author_id = ? AND t.locale = ? AND a.deleted_at IS NOT NULL ORDER BY a.deleted_at DESC, a.id DESC LIMIT ?")
        .all(actorId, locale, limit).map(mapDeletedArticle);
    },

    listLikedArticles({ actorId, locale = "zh-CN", limit = 50 }) {
      requiredText("actorId", actorId, 300);
      validateArticleLocale(locale);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ArticleInputError("limit must be an integer between 1 and 100.");
      return statement(articleSelect + `
        JOIN article_likes l ON l.article_id = a.id
        WHERE l.user_id = ? AND a.status = 'published' AND t.locale = ?
        ORDER BY l.created_at DESC, a.id DESC LIMIT ?
      `).all(actorId, locale, limit).map(mapArticle);
    },

    listRelatedArticles({ slug, locale = "zh-CN", limit = 6 }) {
      validateArticleSlug(slug);
      validateArticleLocale(locale);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new ArticleInputError("limit must be an integer between 1 and 50.");
      const current = statement("SELECT a.id, a.author_id FROM articles a JOIN article_translations t ON t.article_id = a.id AND t.locale = ? WHERE a.slug = ? AND a.status = 'published' LIMIT 1").get(locale, slug);
      if (!current) return [];
      return statement(articleSelect + `
        LEFT JOIN article_taxonomies target_link ON target_link.article_id = ?
        LEFT JOIN article_taxonomies candidate_link ON candidate_link.article_id = a.id AND candidate_link.taxonomy_id = target_link.taxonomy_id
        WHERE a.status = 'published' AND a.id <> ? AND t.locale = ?
        GROUP BY a.id, a.author_id, a.slug, a.work_type, a.status, t.locale, t.title, t.summary, t.content_blocks, t.content_blocks_version, a.created_at, a.updated_at, a.published_at
        ORDER BY count(DISTINCT candidate_link.taxonomy_id) DESC, (a.author_id = ?) DESC, a.published_at DESC, a.id DESC LIMIT ?
      `).all(current.id, current.id, locale, current.author_id, limit).map(mapArticle);
    },

    createArticle({ authorId, slug, title, summary = "", locale = "zh-CN", contentBlocks, contentBlocksVersion = 0, publish = false, workType = "other", categoryIds = [], tagIds = [] }) {
      requiredText("authorId", authorId, 300);
      const input = normalizeArticleInput({ slug, title, summary, locale, contentBlocks, contentBlocksVersion, publish, workType });
      const categories = normalizeTaxonomyIds("categoryIds", categoryIds, 20) ?? [];
      const tags = normalizeTaxonomyIds("tagIds", tagIds, 50) ?? [];
      const id = randomUUID();
      try {
        return transaction((transactionId) => {
          const now = new Date().toISOString();
          db.prepare("INSERT INTO articles (id, author_id, slug, status, work_type, created_at, updated_at, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
            .run(id, authorId, input.slug, input.publish ? "published" : "draft", input.workType ?? "other", now, now, input.publish ? now : null);
          db.prepare("INSERT INTO article_translations (article_id, locale, title, summary, content_blocks, content_blocks_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
            .run(id, input.locale, input.title, input.summary, JSON.stringify(input.contentBlocks), input.contentBlocksVersion, now, now);
          replaceTaxonomies(id, "category", categories);
          replaceTaxonomies(id, "tag", tags);
          captureArticleState(transactionId, id, input.locale);
          return mapArticle(statement(articleSelect + " WHERE a.id = ? AND t.locale = ?").get(id, input.locale));
        });
      } catch (error) {
        if (/UNIQUE constraint failed: articles\.slug/i.test(error.message)) throw new ArticleSlugConflictError();
        throw error;
      }
    },

    updateArticle({ articleId, actorId, slug, title, summary = "", locale = "zh-CN", contentBlocks, contentBlocksVersion = 0, publish = false, workType, categoryIds, tagIds }) {
      if (!isUuid(articleId)) throw new ArticleInputError("articleId must be a valid article ID.");
      requiredText("actorId", actorId, 300);
      const input = normalizeArticleInput({ slug, title, summary, locale, contentBlocks, contentBlocksVersion, publish, workType });
      const categories = normalizeTaxonomyIds("categoryIds", categoryIds, 100);
      const tags = normalizeTaxonomyIds("tagIds", tagIds, 100);
      try {
        return transaction((transactionId) => {
          const existing = statement("SELECT id, author_id, created_at, deleted_at FROM articles WHERE id = ?").get(articleId);
          if (!existing || existing.deleted_at) throw new ArticleNotFoundError("The article was not found.");
          if (existing.author_id !== actorId) throw new ArticleAuthorizationError("Only the article author can update it.");
          const previousLinks = statement("SELECT taxonomy_id FROM article_taxonomies WHERE article_id = ?").all(articleId);
          const now = new Date().toISOString();
          db.prepare("UPDATE articles SET slug = ?, status = ?, work_type = COALESCE(?, work_type), updated_at = ?, published_at = CASE WHEN ? = 1 THEN COALESCE(published_at, ?) ELSE NULL END WHERE id = ?")
            .run(input.slug, input.publish ? "published" : "draft", input.workType ?? null, now, input.publish ? 1 : 0, now, articleId);
          db.prepare(`INSERT INTO article_translations (article_id, locale, title, summary, content_blocks, content_blocks_version, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(article_id, locale) DO UPDATE SET title = excluded.title, summary = excluded.summary,
              content_blocks = excluded.content_blocks, content_blocks_version = excluded.content_blocks_version, updated_at = excluded.updated_at`)
            .run(articleId, input.locale, input.title, input.summary, JSON.stringify(input.contentBlocks), input.contentBlocksVersion, now, now);
          replaceTaxonomies(articleId, "category", categories);
          replaceTaxonomies(articleId, "tag", tags);
          captureArticleState(transactionId, articleId, input.locale, previousLinks);
          return mapArticle(statement(articleSelect + " WHERE a.id = ? AND t.locale = ?").get(articleId, input.locale));
        });
      } catch (error) {
        if (/UNIQUE constraint failed: articles\.slug/i.test(error.message)) throw new ArticleSlugConflictError();
        throw error;
      }
    },

    /**
     * Delete one of the author's own works.
     *
     * The row stays: comments, likes, taxonomy links and the provider-migration
     * journal all refer to it, and a tombstone is recoverable by hand in a way a
     * cascading delete is not. Concretely — the status goes back to 'draft', so
     * every `status = 'published'` read (public page, search, feeds, related,
     * liked lists) already hides the work, and `deleted_at` hides it from the
     * author's own desk.
     *
     * The slug is released, because it is the one thing an author would notice:
     * without this, rewriting the same title after deleting it would collide with
     * the tombstone forever and fail with a 409 the author cannot resolve.
     */
    deleteArticle({ articleId, actorId }) {
      if (!isUuid(articleId)) throw new ArticleInputError("articleId must be a valid article ID.");
      requiredText("actorId", actorId, 300);
      return transaction((transactionId) => {
        const existing = statement("SELECT id, author_id, slug, deleted_at FROM articles WHERE id = ?").get(articleId);
        // A tombstone is not in the author's desk, so a second delete is a 404
        // rather than a silent second tombstone over the first.
        if (!existing || existing.deleted_at) throw new ArticleNotFoundError("The article was not found.");
        if (existing.author_id !== actorId) throw new ArticleAuthorizationError("Only the article author can delete it.");
        const now = new Date().toISOString();
        const releasedSlug = `${existing.slug}-deleted-${articleId.slice(0, 8)}`;
        db.prepare("UPDATE articles SET status = 'draft', deleted_at = ?, slug = ?, updated_at = ? WHERE id = ?")
          .run(now, releasedSlug, now, articleId);
        captureArticleRow(transactionId, articleId);
        return { id: articleId, deletedAt: now };
      });
    },

    /**
     * Bring one of the author's own tombstones back.
     *
     * A restored work returns as a **draft**, never as published: deleting it
     * withdrew it from the public site, and restoring must not quietly put a
     * public address back that the author may have decided against. Republishing
     * is one deliberate press of a button.
     *
     * The address the tombstone released is reclaimed when it is still free, so
     * the author does not carry `-deleted-…` around; when something else has
     * taken it since, the tombstone's own slug stays and the restore still
     * succeeds — a restore must never fail over a slug the author cannot see.
     */
    restoreArticle({ articleId, actorId, locale = "zh-CN" }) {
      if (!isUuid(articleId)) throw new ArticleInputError("articleId must be a valid article ID.");
      requiredText("actorId", actorId, 300);
      validateArticleLocale(locale);
      return transaction((transactionId) => {
        const existing = statement("SELECT author_id, slug, deleted_at FROM articles WHERE id = ?").get(articleId);
        // Not a tombstone: an unknown id, a live work and a second restore are
        // all the same answer, so this cannot be used to probe what exists.
        if (!existing || !existing.deleted_at) throw new ArticleNotFoundError("The article was not found.");
        if (existing.author_id !== actorId) throw new ArticleAuthorizationError("Only the article author can restore it.");
        const translation = statement("SELECT locale FROM article_translations WHERE article_id = ? AND locale = ?").get(articleId, locale);
        if (!translation) throw new ArticleNotFoundError(`The article has no ${locale} translation.`);
        const now = new Date().toISOString();
        const suffix = `-deleted-${articleId.slice(0, 8)}`;
        const preferred = existing.slug.endsWith(suffix) ? existing.slug.slice(0, -suffix.length) : existing.slug;
        const taken = preferred === existing.slug
          ? undefined
          : statement("SELECT 1 AS found FROM articles WHERE slug = ? AND id <> ?").get(preferred, articleId);
        db.prepare("UPDATE articles SET deleted_at = NULL, status = 'draft', slug = ?, updated_at = ? WHERE id = ?")
          .run(taken ? existing.slug : preferred, now, articleId);
        captureArticleRow(transactionId, articleId);
        return mapArticle(statement(articleSelect + " WHERE a.id = ? AND t.locale = ?").get(articleId, locale));
      });
    },

    /**
     * Hard-delete tombstones that have outlived the retention window.
     *
     * This is the only irreversible step in the slice, so it is deliberately
     * unreachable from the desk: the author has no "delete forever" button, and
     * the window is what gives "you can undo this" an expiry date. Rows go, and
     * the foreign keys take the translations, likes, comments and taxonomy links
     * with them — which is why those children are captured one by one *before*
     * the delete, the way `deleteConversation` does it: a replica replaying this
     * journal must not keep orphaned comments behind.
     *
     * Bounded and awaitable, like `pruneExpiredIdentityState`: the sweep never
     * outlives the request that triggered it.
     */
    purgeExpiredArticles({ retentionDays = 30, now = new Date(), limit = 100 } = {}) {
      if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
        throw new ArticleInputError("retentionDays must be an integer between 1 and 3650.");
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new ArticleInputError("limit must be an integer between 1 and 500.");
      const at = now instanceof Date ? now : new Date(now);
      if (Number.isNaN(at.getTime())) throw new ArticleInputError("now must be a valid date.");
      const cutoff = new Date(at.getTime() - retentionDays * 86_400_000).toISOString();
      return transaction((transactionId) => {
        const expired = statement("SELECT id FROM articles WHERE deleted_at IS NOT NULL AND deleted_at < ? ORDER BY deleted_at, id LIMIT ?")
          .all(cutoff, limit).map((row) => row.id);
        const changes = [];
        for (const id of expired) {
          changes.push({ entityType: "articles", entityId: id, operation: "delete", payload: null });
          for (const row of statement("SELECT locale FROM article_translations WHERE article_id = ?").all(id)) {
            changes.push({ entityType: "article_translations", entityId: migrationEntityKey(id, row.locale), operation: "delete", payload: null });
          }
          for (const row of statement("SELECT user_id FROM article_likes WHERE article_id = ?").all(id)) {
            changes.push({ entityType: "article_likes", entityId: migrationEntityKey(id, row.user_id), operation: "delete", payload: null });
          }
          for (const row of statement("SELECT id FROM article_comments WHERE article_id = ?").all(id)) {
            changes.push({ entityType: "article_comments", entityId: row.id, operation: "delete", payload: null });
          }
          for (const row of statement("SELECT taxonomy_id FROM article_taxonomies WHERE article_id = ?").all(id)) {
            changes.push({ entityType: "article_taxonomies", entityId: migrationEntityKey(id, row.taxonomy_id), operation: "delete", payload: null });
          }
        }
        const remove = statement("DELETE FROM articles WHERE id = ?");
        for (const id of expired) remove.run(id);
        if (changes.length) migrationCapture.captureInTransaction(db, transactionId, changes);
        return { purged: expired.length };
      });
    },
  });
}
