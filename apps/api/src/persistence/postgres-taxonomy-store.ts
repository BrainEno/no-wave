/**
 * PostgreSQL persistence slice: User-generated hashtags and editorial categories.
 *
 * Composed by postgres.ts. Row mapping and shared SQL helpers live in
 * postgres-shared.ts so every slice reads rows the same way.
 */
import { randomUUID } from "node:crypto";
import { validateArticleLocale, validateArticleSlug } from "../domain/article.ts";
import { ArticleAuthorizationError, ArticleInputError, TaxonomyConflictError } from "../domain/errors.ts";
import { normalizeHashtag, validateTaxonomyKind } from "../domain/taxonomy.ts";
import { isUuid, requiredText } from "../domain/validation.ts";
import { migrationEntityKey } from "./postgres-provider-migration-capture.ts";
import { listTaxonomiesFrom, mapArticle, mapTaxonomy } from "./postgres-shared.ts";
import { createMigrationTransactionId } from "./provider-migration-journal.ts";
import type { PostgresStoreContext } from "./postgres-shared.ts";
import type { TypedPersistenceAdapterContract } from "../application/persistence-ports.ts";

export function createPostgresTaxonomyStore(ctx: PostgresStoreContext) {
  const { sql, captureChanges } = ctx;
  return Object.freeze({
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
          ...translations.map((row) => ({ entityType: "taxonomy_translations", entityId: migrationEntityKey(taxonomyId, row.locale), operation: "delete" as const, payload: null })),
          ...links.map((row) => ({ entityType: "article_taxonomies", entityId: migrationEntityKey(row.article_id, taxonomyId), operation: "delete" as const, payload: null })),
        ]);
        return true;
      });
    },

  }) satisfies Pick<TypedPersistenceAdapterContract, "listTaxonomies" | "getTaxonomyBySlug" | "listTaxonomyArticles" | "listArticleTaxonomies" | "createTag" | "createTaxonomy" | "deleteTaxonomy">;
}
