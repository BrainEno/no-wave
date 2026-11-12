import { randomUUID } from "node:crypto";
import { createMigrationTransactionId } from "./provider-migration-journal.ts";
import { createSqliteProviderMigrationCapture, migrationEntityKey, type CapturedChange } from "./sqlite-provider-migration-capture.ts";
import {
  ArticleInputError, ArticleAuthorizationError, TaxonomyConflictError,
} from "../domain/errors.ts";
import { normalizeHashtag, validateTaxonomyKind } from "../domain/taxonomy.ts";
import { validateArticleLocale, validateArticleSlug } from "../domain/article.ts";
import { isUuid, requiredText } from "../domain/validation.ts";
import type { TypedPersistenceAdapterContract } from "../application/persistence-ports.ts";
import type { SqliteRow, SqliteRunner } from "./sqlite.ts";

export function createSqliteTaxonomyStore(db: SqliteRunner) {
  if (!db || typeof db.prepare !== "function" || typeof db.exec !== "function") {
    throw new TypeError("A node:sqlite DatabaseSync connection is required.");
  }
  const run = (sql: string, ...params: unknown[]) => db.prepare(sql).run(...params);
  const get = (sql: string, ...params: unknown[]) => db.prepare(sql).get(...params);
  const all = (sql: string, ...params: unknown[]) => db.prepare(sql).all(...params);

  /** The row a capture just wrote; a missing one is a bug, not a valid payload. */
  function one(sql: string, ...args: unknown[]): SqliteRow {
    const row = get(sql, ...args);
    if (!row) throw new Error("Expected a row for the migration capture: " + sql);
    return row;
  }

  const migrationCapture = createSqliteProviderMigrationCapture(db);
  const transaction = <T,>(fn: (transactionId: string) => T): T => {
    const transactionId = createMigrationTransactionId();
    db.exec("BEGIN IMMEDIATE");
    try { const result = fn(transactionId); db.exec("COMMIT"); return result; }
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
  const mapTaxonomyRow = (r: SqliteRow) => ({
    id: r.id, kind: r.kind, slug: r.slug, name: r.name,
    description: r.description ?? "", locale: r.locale,
    createdBy: r.created_by, articleCount: Number(r.article_count ?? 0),
  });
  const mapTaxonomy = (r: SqliteRow | undefined) => r ? mapTaxonomyRow(r) : null;
  const taxonomyForLocale = (where: string, params: unknown[], locale: string) => {
    const row = get(taxonomySelect + " WHERE " + where, locale, locale, locale, ...params);
    return mapTaxonomy(row);
  };
  /**
   * A writer's read-back: the taxonomy row and the translation that names it
   * were written earlier in this same transaction, so an empty answer is an
   * invariant violation rather than a not-found one.
   */
  const taxonomyForLocaleAfterWrite = (where: string, params: unknown[], locale: string) => {
    const taxonomy = taxonomyForLocale(where, params, locale);
    if (!taxonomy) throw new Error("The taxonomy was not readable after it was written.");
    return taxonomy;
  };
  function validateList({ locale = "zh-CN", query = "", limit = 100, offset = 0 }) {
    validateArticleLocale(locale);
    if (typeof query !== "string" || query.length > 200) throw new ArticleInputError("query must be a string no longer than 200 characters.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ArticleInputError("limit must be an integer between 1 and 100.");
    if (!Number.isInteger(offset) || offset < 0 || offset > 1000000) throw new ArticleInputError("offset must be an integer between 0 and 1000000.");
    return { locale, query: query.trim().toLocaleLowerCase(locale), offset };
  }
  return Object.freeze({
    listTaxonomies({ kind, locale = "zh-CN", query = "", limit = 100, offset = 0 }) {
      validateTaxonomyKind(kind);
      const input = validateList({ locale, query, limit, offset });
      const rows = all(taxonomySelect + `
        WHERE tax.kind = ? AND COALESCE(requested.name, fallback.name) IS NOT NULL
          AND (? = '' OR instr(lower(COALESCE(requested.name, fallback.name)), ?) > 0)
        ORDER BY lower(COALESCE(requested.name, fallback.name)), tax.id LIMIT ? OFFSET ?
      `, input.locale, input.locale, input.locale, kind, input.query, input.query, limit, input.offset);
      return rows.map(mapTaxonomyRow);
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
        SELECT a.id, a.author_id, a.slug, a.work_type, a.status, a.created_at, a.updated_at, a.published_at, a.view_count, a.import_revision,
          at.locale, at.title, at.summary, at.content_blocks, at.content_blocks_version
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
        contentBlocks:JSON.parse(r.content_blocks),
        contentBlocksVersion: Number(r.content_blocks_version ?? 0),
        createdAt:r.created_at, updatedAt:r.updated_at, publishedAt:r.published_at,
        viewCount: Number(r.view_count ?? 0),
        importRevision: Number(r.import_revision ?? 0),
      }));
    },
    listArticleTaxonomies({ articleId, kind, locale = "zh-CN" }) {
      if (!isUuid(articleId)) throw new ArticleInputError("articleId must be a valid article ID.");
      validateTaxonomyKind(kind); validateArticleLocale(locale);
      return all(taxonomySelect + `
        JOIN article_taxonomies link ON link.taxonomy_id = tax.id
        WHERE link.article_id = ? AND tax.kind = ? AND COALESCE(requested.name, fallback.name) IS NOT NULL
        ORDER BY lower(COALESCE(requested.name, fallback.name)), tax.id
      `, locale, locale, locale, articleId, kind).map(mapTaxonomyRow);
    },
    /**
     * A page's taxonomies in one statement (#162).
     *
     * The single-article query already computes `article_count` against the
     * whole published catalogue, so the batch is the same join with a widened
     * `IN (...)`: the count is computed once per taxonomy row, then the rows are
     * grouped by article in memory. Ordering is identical to the per-article
     * call — name, then id — so attaching these lists produces byte-identical
     * JSON to the old N+1 path.
     */
    listArticlesTaxonomies({ articleIds, kind, locale = "zh-CN" }) {
      validateTaxonomyKind(kind);
      validateArticleLocale(locale);
      if (!Array.isArray(articleIds)) throw new ArticleInputError("articleIds must be an array.");
      const distinct = [...new Set(articleIds)];
      for (const articleId of distinct) {
        if (!isUuid(articleId)) throw new ArticleInputError("articleIds must be valid article IDs.");
      }
      if (distinct.length === 0) return {};
      const placeholders = distinct.map(() => "?").join(", ");
      // `article_id` has to be in the projection — that grouping key is the whole
      // point of the batch — so this spells the select out instead of reusing
      // `taxonomySelect`. Every other column, the coalesce order and the
      // `article_count` subquery are identical to the per-article query, so the
      // attached lists are byte-for-byte what the N+1 path produced.
      const rows = all(`
        SELECT link.article_id, tax.id, tax.kind, tax.slug, tax.created_by,
          COALESCE(requested.name, fallback.name) AS name,
          COALESCE(requested.description, fallback.description, '') AS description,
          ? AS locale,
          (SELECT count(DISTINCT a.id) FROM article_taxonomies link2
           JOIN articles a ON a.id = link2.article_id AND a.status = 'published'
           JOIN article_translations at ON at.article_id = a.id AND at.locale = ?
           WHERE link2.taxonomy_id = tax.id) AS article_count
        FROM article_taxonomies link
        JOIN taxonomies tax ON tax.id = link.taxonomy_id AND tax.kind = ?
        LEFT JOIN taxonomy_translations requested ON requested.taxonomy_id = tax.id AND requested.locale = ?
        LEFT JOIN taxonomy_translations fallback ON fallback.taxonomy_id = tax.id AND fallback.locale = 'zh-TW'
        WHERE link.article_id IN (${placeholders}) AND COALESCE(requested.name, fallback.name) IS NOT NULL
        ORDER BY link.article_id, lower(COALESCE(requested.name, fallback.name)), tax.id
      `, locale, locale, kind, locale, ...distinct);
      const byArticle: Record<string, ReturnType<typeof mapTaxonomyRow>[]> = {};
      for (const articleId of distinct) byArticle[articleId] = [];
      for (const row of rows) byArticle[row.article_id].push(mapTaxonomyRow(row));
      return byArticle;
    },
    createTag({ actorId, name, locale = "zh-CN" }) {
      requiredText("actorId", actorId, 300); validateArticleLocale(locale);
      const normalized = normalizeHashtag(name);
      return transaction((transactionId) => {
        run("INSERT INTO taxonomies (id, kind, slug, created_by) VALUES (?, 'tag', ?, ?) ON CONFLICT(kind, slug) DO NOTHING", randomUUID(), normalized.slug, actorId);
        const tax = get("SELECT id, created_by FROM taxonomies WHERE kind = 'tag' AND slug = ?", normalized.slug);
        if (!tax) throw new TaxonomyConflictError();
        run("INSERT INTO taxonomy_translations (taxonomy_id, locale, name, description) VALUES (?, ?, ?, '') ON CONFLICT(taxonomy_id, locale) DO NOTHING", tax.id, locale, normalized.displayName);
        migrationCapture.captureInTransaction(db, transactionId, [
          { entityType: "taxonomies", entityId: tax.id, operation: "upsert", payload: one("SELECT * FROM taxonomies WHERE id = ?", tax.id) },
          { entityType: "taxonomy_translations", entityId: migrationEntityKey(tax.id, locale), operation: "upsert", payload: one("SELECT * FROM taxonomy_translations WHERE taxonomy_id = ? AND locale = ?", tax.id, locale) },
        ]);
        return taxonomyForLocaleAfterWrite("tax.id = ? AND requested.locale = ? LIMIT 1", [tax.id, locale], locale);
      });
    },
    /**
     * `actorIsEditor` is answered by the application layer, which is the only
     * layer that can see `EDITOR_USER_IDS`; persistence treats it as a fact.
     * It defaults to false, so a caller that forgets to ask gets no privilege.
     */
    createTaxonomy({ actorId, actorIsEditor = false, kind, slug, name, description = "", locale = "zh-CN" }) {
      requiredText("actorId", actorId, 300); validateTaxonomyKind(kind);
      // ADR 0016, decision 1: a category is an editorial structure — it only means
      // something if somebody read the work before filing it under that heading.
      // A hashtag is the author's own words about their own work, and stays open.
      if (kind === "category" && actorIsEditor !== true) {
        throw new ArticleAuthorizationError("Only an editor can create a category.");
      }
      const normalizedSlug = validateArticleSlug(slug);
      requiredText("name", name, 120);
      if (typeof description !== "string" || description.length > 2000) throw new ArticleInputError("description must be a string no longer than 2000 characters.");
      validateArticleLocale(locale);
      return transaction((transactionId) => {
        run("INSERT INTO taxonomies (id, kind, slug, created_by) VALUES (?, ?, ?, ?) ON CONFLICT(kind, slug) DO NOTHING", randomUUID(), kind, normalizedSlug, actorId);
        const tax = get("SELECT id, created_by FROM taxonomies WHERE kind = ? AND slug = ?", kind, normalizedSlug);
        if (!tax) throw new TaxonomyConflictError();
        // A category is maintained by the editors as a group, not by whoever
        // created it; a tag stays the creator's own words.
        if (tax.created_by !== actorId && !(kind === "category" && actorIsEditor === true)) {
          throw new ArticleAuthorizationError(
            kind === "category"
              ? "Only an editor can add a translation to a category."
              : "Only the taxonomy creator can add another translation.",
          );
        }
        run("INSERT INTO taxonomy_translations (taxonomy_id, locale, name, description) VALUES (?, ?, ?, ?) ON CONFLICT(taxonomy_id, locale) DO UPDATE SET name = excluded.name, description = excluded.description, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", tax.id, locale, name, description);
        migrationCapture.captureInTransaction(db, transactionId, [
          { entityType: "taxonomies", entityId: tax.id, operation: "upsert", payload: one("SELECT * FROM taxonomies WHERE id = ?", tax.id) },
          { entityType: "taxonomy_translations", entityId: migrationEntityKey(tax.id, locale), operation: "upsert", payload: one("SELECT * FROM taxonomy_translations WHERE taxonomy_id = ? AND locale = ?", tax.id, locale) },
        ]);
        return taxonomyForLocaleAfterWrite("tax.id = ? LIMIT 1", [tax.id], locale);
      });
    },
    deleteTaxonomy({ taxonomyId, actorId, actorIsEditor = false }) {
      if (!isUuid(taxonomyId)) throw new ArticleInputError("taxonomyId must be a valid UUID.");
      requiredText("actorId", actorId, 300);
      return transaction((transactionId) => {
        const tax = get("SELECT kind, created_by FROM taxonomies WHERE id = ?", taxonomyId);
        if (!tax) return false;
        if (tax.kind === "category" ? actorIsEditor !== true : tax.created_by !== actorId) {
          throw new ArticleAuthorizationError(
            tax.kind === "category"
              ? "Only an editor can delete a category."
              : "Only the taxonomy creator can delete it.",
          );
        }
        const translations = all("SELECT taxonomy_id, locale FROM taxonomy_translations WHERE taxonomy_id = ?", taxonomyId);
        const links = all("SELECT article_id, taxonomy_id FROM article_taxonomies WHERE taxonomy_id = ?", taxonomyId);
        run("DELETE FROM taxonomies WHERE id = ?", taxonomyId);
        migrationCapture.captureInTransaction(db, transactionId, [
          { entityType: "taxonomies", entityId: taxonomyId, operation: "delete", payload: null },
          ...translations.map((row): CapturedChange => ({ entityType: "taxonomy_translations", entityId: migrationEntityKey(taxonomyId, row.locale), operation: "delete", payload: null })),
          ...links.map((row): CapturedChange => ({ entityType: "article_taxonomies", entityId: migrationEntityKey(row.article_id, taxonomyId), operation: "delete", payload: null })),
        ]);
        return true;
      });
    },
  }) satisfies Pick<TypedPersistenceAdapterContract, "listTaxonomies" | "getTaxonomyBySlug" | "listTaxonomyArticles" | "listArticleTaxonomies" | "listArticlesTaxonomies" | "createTag" | "createTaxonomy" | "deleteTaxonomy">;
}
