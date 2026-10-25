import { randomUUID } from "node:crypto";
import {
  ArticleInputError,
  ArticleSlugConflictError,
  ArticleAuthorizationError,
  ArticleNotFoundError,
} from "../domain/errors.mjs";
import {
  validateArticleLocale,
  validateArticleSlug,
  normalizeArticleInput,
  normalizeTaxonomyIds,
} from "../domain/article.mjs";
import { requiredText } from "../domain/validation.mjs";

/**
 * SQLite implementation of the article/content persistence slice.
 * This is deliberately not a full persistence adapter: runtime registration
 * must wait until every persistence port has behavioral parity.
 */
export function createSqliteArticleStore(db) {
  if (!db || typeof db.prepare !== "function" || typeof db.exec !== "function") {
    throw new TypeError("A node:sqlite DatabaseSync connection is required.");
  }

  const articleSelect = `
    SELECT a.id, a.author_id, a.slug, a.work_type, a.status, t.locale,
           t.title, t.summary, t.content_blocks, a.created_at, a.updated_at, a.published_at
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
  }) : null;
  const statement = (sql) => db.prepare(sql);
  const publishedArticleBySlug = statement(
    articleSelect + " WHERE a.slug = ? AND a.status = 'published' AND t.locale = ? LIMIT 1",
  );

  function transaction(work) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
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

  function normalizeIds() {
    // Kept local to make the optional category/tag semantics explicit.
  }

  return Object.freeze({
    listPublishedArticles({ locale = "zh-CN", query = "", limit = 20, offset = 0 } = {}) {
      validateArticleLocale(locale);
      if (typeof query !== "string" || query.length > 200) throw new ArticleInputError("query must be a string no longer than 200 characters.");
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ArticleInputError("limit must be an integer between 1 and 100.");
      if (!Number.isInteger(offset) || offset < 0 || offset > 100000) throw new ArticleInputError("offset must be an integer between 0 and 100000.");
      const needle = query.trim().toLocaleLowerCase(locale);
      const rows = statement(articleSelect + `
        WHERE a.status = 'published' AND t.locale = ?
          AND (? = '' OR instr(lower(t.title), lower(?)) > 0 OR instr(lower(t.summary), lower(?)) > 0)
        ORDER BY a.published_at DESC, a.id DESC
        LIMIT ? OFFSET ?
      `).all(locale, needle, needle, needle, limit, offset);
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
      return statement(articleSelect + " WHERE a.author_id = ? AND t.locale = ? ORDER BY a.updated_at DESC, a.id LIMIT ?")
        .all(actorId, locale, limit).map(mapArticle);
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
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new ArticleInputError("limit must be an integer between 1 and 20.");
      const current = statement("SELECT id FROM articles WHERE slug = ? AND status = 'published'").get(slug);
      if (!current) return [];
      return statement(articleSelect + `
        WHERE a.status = 'published' AND a.id <> ? AND t.locale = ?
        ORDER BY a.published_at DESC, a.id DESC LIMIT ?
      `).all(current.id, locale, limit).map(mapArticle);
    },

    createArticle({ authorId, slug, title, summary = "", locale = "zh-CN", contentBlocks, publish = false, workType = "other", categoryIds = [], tagIds = [] }) {
      requiredText("authorId", authorId, 300);
      const input = normalizeArticleInput({ slug, title, summary, locale, contentBlocks, publish, workType });
      const categories = normalizeTaxonomyIds("categoryIds", categoryIds, 100) ?? [];
      const tags = normalizeTaxonomyIds("tagIds", tagIds, 100) ?? [];
      const id = randomUUID();
      try {
        return transaction(() => {
          const now = new Date().toISOString();
          db.prepare("INSERT INTO articles (id, author_id, slug, status, work_type, created_at, updated_at, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
            .run(id, authorId, input.slug, input.publish ? "published" : "draft", input.workType ?? "other", now, now, input.publish ? now : null);
          db.prepare("INSERT INTO article_translations (article_id, locale, title, summary, content_blocks, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .run(id, input.locale, input.title, input.summary, JSON.stringify(input.contentBlocks), now, now);
          replaceTaxonomies(id, "category", categories);
          replaceTaxonomies(id, "tag", tags);
          return mapArticle(statement(articleSelect + " WHERE a.id = ? AND t.locale = ?").get(id, input.locale));
        });
      } catch (error) {
        if (/UNIQUE constraint failed: articles\.slug/i.test(error.message)) throw new ArticleSlugConflictError();
        throw error;
      }
    },

    updateArticle({ articleId, actorId, slug, title, summary = "", locale = "zh-CN", contentBlocks, publish = false, workType, categoryIds, tagIds }) {
      requiredText("articleId", articleId, 300);
      requiredText("actorId", actorId, 300);
      const input = normalizeArticleInput({ slug, title, summary, locale, contentBlocks, publish, workType });
      const categories = normalizeTaxonomyIds("categoryIds", categoryIds, 100);
      const tags = normalizeTaxonomyIds("tagIds", tagIds, 100);
      try {
        return transaction(() => {
          const existing = statement("SELECT id, author_id, created_at FROM articles WHERE id = ?").get(articleId);
          if (!existing) throw new ArticleNotFoundError("The article was not found.");
          if (existing.author_id !== actorId) throw new ArticleAuthorizationError("Only the article author can update it.");
          const now = new Date().toISOString();
          db.prepare("UPDATE articles SET slug = ?, status = ?, work_type = COALESCE(?, work_type), updated_at = ?, published_at = CASE WHEN ? = 1 THEN COALESCE(published_at, ?) ELSE NULL END WHERE id = ?")
            .run(input.slug, input.publish ? "published" : "draft", input.workType ?? null, now, input.publish ? 1 : 0, now, articleId);
          db.prepare(`INSERT INTO article_translations (article_id, locale, title, summary, content_blocks, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(article_id, locale) DO UPDATE SET title = excluded.title, summary = excluded.summary,
              content_blocks = excluded.content_blocks, updated_at = excluded.updated_at`)
            .run(articleId, input.locale, input.title, input.summary, JSON.stringify(input.contentBlocks), now, now);
          replaceTaxonomies(articleId, "category", categories);
          replaceTaxonomies(articleId, "tag", tags);
          return mapArticle(statement(articleSelect + " WHERE a.id = ? AND t.locale = ?").get(articleId, input.locale));
        });
      } catch (error) {
        if (/UNIQUE constraint failed: articles\.slug/i.test(error.message)) throw new ArticleSlugConflictError();
        throw error;
      }
    },
  });
}
