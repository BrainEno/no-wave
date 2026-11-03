import { randomUUID } from "node:crypto";
import { createMigrationTransactionId } from "./provider-migration-journal.ts";
import { migrationEntityKey } from "./postgres-provider-migration-capture.ts";
import {
  IdempotencyConflictError,
  ArticleInputError,
  ArticleAuthorizationError,
  TaxonomyConflictError,
  TaxonomyNotFoundError
} from "../domain/errors.ts";
import { normalizeHashtag, validateTaxonomyKind } from "../domain/taxonomy.ts";
import { validateArticleLocale, validateArticleSlug } from "../domain/article.ts";
import { isUuid, requiredText } from "../domain/validation.ts";
import { mapArticle, mapTaxonomy } from "./postgres-row-mappers.ts";
import type {
  Article,
  GetTaxonomyBySlugInput,
  ListArticleTaxonomiesInput,
  ListArticlesTaxonomiesInput,
  ListTaxonomiesInput,
  ListTaxonomyArticlesInput,
  Taxonomy,
} from "../application/persistence-port-types.ts";
import type { TypedPersistenceAdapterContract } from "../application/persistence-adapter.ts";

/**
 * Reconcile one taxonomy kind's links for a work, inside the caller's
 * transaction.
 *
 * Exported because article create/update own the transaction but taxonomy
 * ownership of the SQL: the article slice imports this rather than repeating
 * a delete-then-insert it would have to keep in step with this one.
 */

/**
 * Reconcile one taxonomy kind's links for a work, inside the caller's
 * transaction.
 *
 * Exported because article create/update own the transaction but taxonomy owns
 * this SQL: the article slice imports it rather than keeping a second
 * delete-then-insert in step with this one.
 */
export async function replaceArticleTaxonomyKind(tx, articleId, kind, ids) {
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

/**
 * PostgreSQL taxonomy slice: tags, categories, and a work's links to them — the counterpart of
 * `sqlite-taxonomy-store.ts`.
 */
export function createPostgresTaxonomyStore({ sql, captureChanges }): Pick<TypedPersistenceAdapterContract, "listTaxonomies" | "getTaxonomyBySlug" | "listTaxonomyArticles" | "listArticleTaxonomies" | "listArticlesTaxonomies" | "createTag" | "createTaxonomy" | "deleteTaxonomy"> {
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

  return Object.freeze({
    async listTaxonomies(input: Partial<ListTaxonomiesInput> = {}): Promise<Taxonomy[]> {
      const { kind, locale, query, limit, offset } = input;
      return listTaxonomiesFrom(sql, { kind, locale, query, limit, offset });
    },
    async getTaxonomyBySlug({ kind, slug, locale = "zh-CN" }: GetTaxonomyBySlugInput): Promise<Taxonomy | null> {
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
    async listTaxonomyArticles({ kind, slug, locale = "zh-CN", limit = 20, offset = 0 }: ListTaxonomyArticlesInput): Promise<Article[]> {
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
    async listArticleTaxonomies({ articleId, kind, locale = "zh-CN" }: ListArticleTaxonomiesInput): Promise<Taxonomy[]> {
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
    /**
     * A page's categories and tags in two queries instead of two per work
     * (issue #162).
     *
     * The same projection as `listArticleTaxonomies`, over `= ANY($1)`: one pass
     * per kind answers the whole page, and the grouping happens in memory.
     */
    async listArticlesTaxonomies({ articleIds, locale = "zh-CN" }: ListArticlesTaxonomiesInput): Promise<Map<string, { categories: Taxonomy[]; tags: Taxonomy[] }>> {
      validateArticleLocale(locale);
      if (!Array.isArray(articleIds)) throw new ArticleInputError("articleIds must be an array.");
      const ids = [...new Set(articleIds.filter((id) => typeof id === "string" && isUuid(id)))];
      const grouped = new Map(ids.map((id) => [id, { categories: [] as Taxonomy[], tags: [] as Taxonomy[] }]));
      if (ids.length === 0) return grouped;
      for (const kind of ["category", "tag"]) {
        validateTaxonomyKind(kind);
        const rows = await sql.unsafe(
          `SELECT link.article_id AS ref_article_id, tax.id, tax.kind, tax.slug, tax.created_by,
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
           WHERE link.article_id = ANY($1::uuid[]) AND COALESCE(requested.name, fallback.name) IS NOT NULL
           ORDER BY lower(COALESCE(requested.name, fallback.name)), tax.id`,
          [ids, kind, locale],
        );
        for (const row of rows) {
          const bucket = grouped.get(row.ref_article_id);
          if (bucket) (kind === "category" ? bucket.categories : bucket.tags).push(mapTaxonomy(row));
        }
      }
      return grouped;
    },
    async createTag({ actorId, name, locale = "zh-CN" }) {
      requiredText("actorId", actorId, 300);
      validateArticleLocale(locale);
      const normalized = normalizeHashtag(name);
      return sql.begin(async (tx) => {
        const transactionId = createMigrationTransactionId();
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
        const [taxonomySnapshot, translationSnapshot] = await Promise.all([
          tx.unsafe("SELECT * FROM taxonomies WHERE id = $1", [taxonomy.id]),
          tx.unsafe("SELECT * FROM taxonomy_translations WHERE taxonomy_id = $1 AND locale = $2", [taxonomy.id, locale]),
        ]);
        await captureChanges(tx, transactionId, [
          { entityType: "taxonomies", entityId: taxonomy.id, operation: "upsert", payload: taxonomySnapshot[0] },
          { entityType: "taxonomy_translations", entityId: migrationEntityKey(taxonomy.id, locale), operation: "upsert", payload: translationSnapshot[0] },
        ]);
        return mapTaxonomy(found[0]);
      });
    },
    /**
     * `actorIsEditor` is answered by the application layer, which is the only
     * layer that can see `EDITOR_USER_IDS`; persistence treats it as a fact and
     * defaults it to false, so a caller that forgets to ask gets no privilege.
     */
    /**
     * `actorIsEditor` is answered by the application layer, which is the only
     * layer that can see `EDITOR_USER_IDS`; persistence treats it as a fact and
     * defaults it to false, so a caller that forgets to ask gets no privilege.
     */
    async createTaxonomy({ actorId, actorIsEditor = false, kind, slug, name, description = "", locale = "zh-CN" }) {
      requiredText("actorId", actorId, 300);
      validateTaxonomyKind(kind);
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
      try {
        return await sql.begin(async (tx) => {
          const transactionId = createMigrationTransactionId();
          let taxonomyRows = await tx.unsafe(
            "INSERT INTO taxonomies (id, kind, slug, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT (kind, slug) DO NOTHING RETURNING id, kind, slug, created_by",
            [randomUUID(), kind, normalizedSlug, actorId],
          );
          let taxonomy = taxonomyRows[0];
          if (!taxonomy) {
            taxonomyRows = await tx.unsafe("SELECT id, kind, slug, created_by FROM taxonomies WHERE kind = $1 AND slug = $2 FOR UPDATE", [kind, normalizedSlug]);
            taxonomy = taxonomyRows[0];
            if (!taxonomy) throw new TaxonomyConflictError();
            // A category is maintained by the editors as a group, not by whoever
            // created it; a tag stays the creator's own words.
            if (taxonomy.created_by !== actorId && !(kind === "category" && actorIsEditor === true)) {
              throw new ArticleAuthorizationError(
                kind === "category"
                  ? "Only an editor can add a translation to a category."
                  : "Only the taxonomy creator can add another translation.",
              );
            }
          }
          await tx.unsafe(
            "INSERT INTO taxonomy_translations (taxonomy_id, locale, name, description) VALUES ($1, $2, $3, $4) ON CONFLICT (taxonomy_id, locale) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, updated_at = now()",
            [taxonomy.id, locale, name, description],
          );
          const found = await tx.unsafe(
            "SELECT tax.id, tax.kind, tax.slug, tax.created_by, tr.name, tr.description, tr.locale, 0::int AS article_count FROM taxonomies AS tax JOIN taxonomy_translations AS tr ON tr.taxonomy_id = tax.id AND tr.locale = $2 WHERE tax.id = $1",
            [taxonomy.id, locale],
          );
          const [taxonomySnapshot, translationSnapshot] = await Promise.all([
            tx.unsafe("SELECT * FROM taxonomies WHERE id = $1", [taxonomy.id]),
            tx.unsafe("SELECT * FROM taxonomy_translations WHERE taxonomy_id = $1 AND locale = $2", [taxonomy.id, locale]),
          ]);
          await captureChanges(tx, transactionId, [
            { entityType: "taxonomies", entityId: taxonomy.id, operation: "upsert", payload: taxonomySnapshot[0] },
            { entityType: "taxonomy_translations", entityId: migrationEntityKey(taxonomy.id, locale), operation: "upsert", payload: translationSnapshot[0] },
          ]);
          return mapTaxonomy(found[0]);
        });
      } catch (error) {
        if (error?.code === "23505") throw new TaxonomyConflictError();
        throw error;
      }
    },
    async deleteTaxonomy({ taxonomyId, actorId, actorIsEditor = false }) {
      if (!isUuid(taxonomyId)) throw new ArticleInputError("taxonomyId must be a valid UUID.");
      requiredText("actorId", actorId, 300);
      return sql.begin(async (tx) => {
        const transactionId = createMigrationTransactionId();
        const rows = await tx.unsafe("SELECT kind, created_by FROM taxonomies WHERE id = $1 FOR UPDATE", [taxonomyId]);
        if (rows.length === 0) return false;
        if (rows[0].kind === "category" ? actorIsEditor !== true : rows[0].created_by !== actorId) {
          throw new ArticleAuthorizationError(
            rows[0].kind === "category"
              ? "Only an editor can delete a category."
              : "Only the taxonomy creator can delete it.",
          );
        }
        const [translations, links] = await Promise.all([
          tx.unsafe("SELECT taxonomy_id, locale FROM taxonomy_translations WHERE taxonomy_id = $1", [taxonomyId]),
          tx.unsafe("SELECT article_id, taxonomy_id FROM article_taxonomies WHERE taxonomy_id = $1", [taxonomyId]),
        ]);
        await tx.unsafe("DELETE FROM taxonomies WHERE id = $1", [taxonomyId]);
        await captureChanges(tx, transactionId, [
          { entityType: "taxonomies", entityId: taxonomyId, operation: "delete", payload: null },
          ...translations.map((row) => ({ entityType: "taxonomy_translations", entityId: migrationEntityKey(taxonomyId, row.locale), operation: "delete", payload: null })),
          ...links.map((row) => ({ entityType: "article_taxonomies", entityId: migrationEntityKey(row.article_id, taxonomyId), operation: "delete", payload: null })),
        ]);
        return true;
      });
    },
  });
}
