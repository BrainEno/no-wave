import { randomUUID } from "node:crypto";
import {
  ArticleInputError, ArticleAuthorizationError, TaxonomyConflictError,
} from "../domain/errors.mjs";
import { normalizeHashtag, validateTaxonomyKind } from "../domain/taxonomy.mjs";
import { validateArticleLocale, validateArticleSlug } from "../domain/article.mjs";
import { isUuid, requiredText } from "../domain/validation.mjs";

export function createSqliteTaxonomyStore(db) {
  if (!db || typeof db.prepare !== "function" || typeof db.exec !== "function") {
    throw new TypeError("A node:sqlite DatabaseSync connection is required.");
  }
  const run = (sql, ...params) => db.prepare(sql).run(...params);
  const get = (sql, ...params) => db.prepare(sql).get(...params);
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const transaction = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); db.exec("COMMIT"); return result; }
    catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
  };
  const taxonomySelect = `
    SELECT tax.id, tax.kind, tax.slug, tax.created_by,
      COALESCE(requested.name, fallback.name) AS name,
      COALESCE(requested.description, fallback.description, '') AS description,
      ? AS locale,
      (SELECT count(DISTINCT a.id) FROM article_taxonomies link
       JOIN articles a ON a.id = link.article_id AND a.status = 'published'
       JOIN article_translations at ON at.article_id = a.id AND at.locale = ?
       WHERE link.taxonomy_id = tax.id) AS article_count
    FROM taxonomies tax
    LEFT JOIN taxonomy_translations requested ON requested.taxonomy_id = tax.id AND requested.locale = ?
    LEFT JOIN taxonomy_translations fallback ON fallback.taxonomy_id = tax.id AND fallback.locale = 'zh-TW'
  `;
  const mapTaxonomy = (r) => r ? ({
    id: r.id, kind: r.kind, slug: r.slug, name: r.name,
    description: r.description ?? "", locale: r.locale,
    createdBy: r.created_by, articleCount: Number(r.article_count ?? 0),
  }) : null;
  const taxonomyForLocale = (where, params, locale) => {
    const row = get(taxonomySelect + " WHERE " + where, locale, locale, locale, ...params);
    return mapTaxonomy(row);
  };
  function validateList({ locale = "zh-CN", query = "", limit = 100 }) {
    validateArticleLocale(locale);
    if (typeof query !== "string" || query.length > 200) throw new ArticleInputError("query must be a string no longer than 200 characters.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ArticleInputError("limit must be an integer between 1 and 100.");
    return { locale, query: query.trim().toLocaleLowerCase(locale) };
  }
  return Object.freeze({
    listTaxonomies({ kind, locale = "zh-CN", query = "", limit = 100 }) {
      validateTaxonomyKind(kind);
      const input = validateList({ locale, query, limit });
      const rows = all(taxonomySelect + `
        WHERE tax.kind = ? AND COALESCE(requested.name, fallback.name) IS NOT NULL
          AND (? = '' OR instr(lower(COALESCE(requested.name, fallback.name)), ?) > 0)
        ORDER BY lower(COALESCE(requested.name, fallback.name)), tax.id LIMIT ?
      `, input.locale, input.locale, input.locale, kind, input.query, input.query, limit);
      return rows.map(mapTaxonomy);
    },
    getTaxonomyBySlug({ kind, slug, locale = "zh-CN" }) {
      validateTaxonomyKind(kind); validateArticleSlug(slug); validateArticleLocale(locale);
      return taxonomyForLocale("tax.kind = ? AND tax.slug = ? AND COALESCE(requested.name, fallback.name) IS NOT NULL LIMIT 1", [kind, slug], locale);
    },
    listTaxonomyArticles({ kind, slug, locale = "zh-CN", limit = 20, offset = 0 }) {
      validateTaxonomyKind(kind); validateArticleSlug(slug); validateArticleLocale(locale);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ArticleInputError("limit must be an integer between 1 and 100.");
      if (!Number.isInteger(offset) || offset < 0 || offset > 1000000) throw new ArticleInputError("offset must be an integer between 0 and 1000000.");
      return all(`
        SELECT a.id, a.author_id, a.slug, a.work_type, a.status, a.created_at, a.updated_at, a.published_at,
          at.locale, at.title, at.summary, at.content_blocks
        FROM taxonomies tax
        JOIN taxonomy_translations tt ON tt.taxonomy_id = tax.id AND tt.locale = ?
        JOIN article_taxonomies link ON link.taxonomy_id = tax.id
        JOIN articles a ON a.id = link.article_id AND a.status = 'published'
        JOIN article_translations at ON at.article_id = a.id AND at.locale = ?
        WHERE tax.kind = ? AND tax.slug = ?
        ORDER BY a.published_at DESC, a.id DESC LIMIT ? OFFSET ?
      `, locale, locale, kind, slug, limit, offset).map((r) => ({
        id:r.id, authorId:r.author_id, slug:r.slug, workType:r.work_type ?? "other",
        status:r.status, locale:r.locale, title:r.title, summary:r.summary,
        contentBlocks:JSON.parse(r.content_blocks), createdAt:r.created_at,
        updatedAt:r.updated_at, publishedAt:r.published_at,
      }));
    },
    listArticleTaxonomies({ articleId, kind, locale = "zh-CN" }) {
      if (!isUuid(articleId)) throw new ArticleInputError("articleId must be a valid article ID.");
      validateTaxonomyKind(kind); validateArticleLocale(locale);
      return all(taxonomySelect + `
        JOIN article_taxonomies link ON link.taxonomy_id = tax.id
        WHERE link.article_id = ? AND tax.kind = ? AND COALESCE(requested.name, fallback.name) IS NOT NULL
        ORDER BY lower(COALESCE(requested.name, fallback.name)), tax.id
      `, locale, locale, locale, articleId, kind).map(mapTaxonomy);
    },
    createTag({ actorId, name, locale = "zh-CN" }) {
      requiredText("actorId", actorId, 300); validateArticleLocale(locale);
      const normalized = normalizeHashtag(name);
      return transaction(() => {
        run("INSERT INTO taxonomies (id, kind, slug, created_by) VALUES (?, 'tag', ?, ?) ON CONFLICT(kind, slug) DO NOTHING", randomUUID(), normalized.slug, actorId);
        const tax = get("SELECT id, created_by FROM taxonomies WHERE kind = 'tag' AND slug = ?", normalized.slug);
        if (!tax) throw new TaxonomyConflictError();
        run("INSERT INTO taxonomy_translations (taxonomy_id, locale, name, description) VALUES (?, ?, ?, '') ON CONFLICT(taxonomy_id, locale) DO NOTHING", tax.id, locale, normalized.displayName);
        return taxonomyForLocale("tax.id = ? AND requested.locale = ? LIMIT 1", [tax.id, locale], locale);
      });
    },
    createTaxonomy({ actorId, kind, slug, name, description = "", locale = "zh-CN" }) {
      requiredText("actorId", actorId, 300); validateTaxonomyKind(kind);
      const normalizedSlug = validateArticleSlug(slug);
      requiredText("name", name, 120);
      if (typeof description !== "string" || description.length > 2000) throw new ArticleInputError("description must be a string no longer than 2000 characters.");
      validateArticleLocale(locale);
      return transaction(() => {
        run("INSERT INTO taxonomies (id, kind, slug, created_by) VALUES (?, ?, ?, ?) ON CONFLICT(kind, slug) DO NOTHING", randomUUID(), kind, normalizedSlug, actorId);
        const tax = get("SELECT id, created_by FROM taxonomies WHERE kind = ? AND slug = ?", kind, normalizedSlug);
        if (!tax) throw new TaxonomyConflictError();
        if (tax.created_by !== actorId) throw new ArticleAuthorizationError("Only the taxonomy creator can add another translation.");
        run("INSERT INTO taxonomy_translations (taxonomy_id, locale, name, description) VALUES (?, ?, ?, ?) ON CONFLICT(taxonomy_id, locale) DO UPDATE SET name = excluded.name, description = excluded.description, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", tax.id, locale, name, description);
        return taxonomyForLocale("tax.id = ? LIMIT 1", [tax.id], locale);
      });
    },
    deleteTaxonomy({ taxonomyId, actorId }) {
      if (!isUuid(taxonomyId)) throw new ArticleInputError("taxonomyId must be a valid UUID.");
      requiredText("actorId", actorId, 300);
      return transaction(() => {
        const tax = get("SELECT created_by FROM taxonomies WHERE id = ?", taxonomyId);
        if (!tax) return false;
        if (tax.created_by !== actorId) throw new ArticleAuthorizationError("Only the taxonomy creator can delete it.");
        run("DELETE FROM taxonomies WHERE id = ?", taxonomyId);
        return true;
      });
    },
  });
}
