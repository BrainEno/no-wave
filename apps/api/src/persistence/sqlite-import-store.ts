import { articleIdempotencyKeyHash } from "../application/article-idempotency.ts";
import { assertNotionImportWorkState, type CommitNotionImportWorkInput, type CommittedNotionImportEdition } from "../application/notion-import-plan.ts";
import { ArticleSlugConflictError } from "../domain/errors.ts";
import { createSqliteArticleStore } from "./sqlite-article-store.ts";
import { createSqliteTaxonomyStore } from "./sqlite-taxonomy-store.ts";
import { importCreateCandidate, importEditionFields, MAX_AUTO_SLUG_ATTEMPTS, sqliteImportSavepoints } from "./notion-import-transaction.ts";
import { createMigrationTransactionId } from "./provider-migration-journal.ts";
import { createSqliteProviderMigrationCapture, migrationEntityKey } from "./sqlite-provider-migration-capture.ts";
import type { TypedPersistenceAdapterContract } from "../application/persistence-ports.ts";
import type { SqliteRow, SqliteRunner } from "./sqlite.ts";

/**
 * Import provenance on SQLite (ADR 0037).
 *
 * One row per `(provider, external page, locale)`. The write is an upsert on the
 * primary key, which is the whole idempotency story: re-importing the same page
 * replaces its digest and `synced_at` in place, and cannot produce a second row
 * even under a retry.
 *
 * The row is captured in the provider-migration journal like every other domain
 * write. A provider cutover copies rows, so a link that is not captured would
 * vanish in the move — and the next import would then create a duplicate work
 * under a suffixed slug, which is exactly the failure the table exists to
 * prevent.
 */
export function createSqliteImportStore(db: SqliteRunner, options: { transactionId?: string } = {}) {
  if (!db || typeof db.prepare !== "function" || typeof db.exec !== "function") {
    throw new TypeError("A node:sqlite DatabaseSync connection is required.");
  }
  const migrationCapture = createSqliteProviderMigrationCapture(db);
  const get = (sql: string, ...args: unknown[]) => db.prepare(sql).get(...args);

  const mapRow = (row: SqliteRow) => ({
    provider: String(row.provider),
    externalId: String(row.external_id),
    locale: String(row.locale),
    articleId: String(row.article_id),
    ownerId: String(row.owner_id),
    digest: String(row.digest),
    syncedAt: String(row.synced_at),
  });

  function upsertLink(input: {
    provider: string; externalId: string; locale: string; articleId: string;
    ownerId: string; digest: string; syncedAt: string;
  }, runner: SqliteRunner = db, fixedTransactionId?: string) {
    const transactionId = fixedTransactionId ?? options.transactionId ?? createMigrationTransactionId();
    runner.exec("BEGIN IMMEDIATE");
    try {
      const result = runner.prepare(`INSERT INTO external_content_links (provider, external_id, locale, article_id, owner_id, digest, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (provider, external_id, locale) DO UPDATE SET
           article_id = excluded.article_id,
           owner_id = excluded.owner_id,
           digest = excluded.digest,
           synced_at = excluded.synced_at
         WHERE external_content_links.owner_id = excluded.owner_id
           AND external_content_links.article_id = excluded.article_id`).run(
        input.provider, input.externalId, input.locale, input.articleId, input.ownerId, input.digest, input.syncedAt,
      );
      if (Number(result.changes) !== 1) throw new Error("The Notion page is already linked to another work or account.");
      const row = runner.prepare(
        "SELECT provider, external_id, locale, article_id, owner_id, digest, synced_at FROM external_content_links WHERE provider = ? AND external_id = ? AND locale = ?",
      ).get(input.provider, input.externalId, input.locale);
      if (!row) throw new Error("External content link upsert did not produce a row.");
      migrationCapture.captureInTransaction(runner, transactionId, [
        { entityType: "external_content_links", entityId: migrationEntityKey(input.provider, input.externalId, input.locale), operation: "upsert", payload: row },
      ]);
      runner.exec("COMMIT");
      return mapRow(row);
    } catch (error) {
      try { runner.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
      throw error;
    }
  }

  const generation = (): string => {
    const row = get("SELECT generation FROM import_plan_generation WHERE singleton = 1");
    if (!row) throw new Error("The import plan generation is missing; run migrations.");
    return String(row.generation);
  };

  return Object.freeze({
    getImportPlanGeneration: generation,

    /** No asynchronous work is permitted while this connection's write lock is held. */
    commitNotionImportWork(input: CommitNotionImportWorkInput): CommittedNotionImportEdition[] {
      db.exec("BEGIN IMMEDIATE");
      try {
        const expected = input.expected;
        const placeholders = expected.sourceIds.map(() => "?").join(", ");
        const links = db.prepare(`SELECT provider, external_id, locale, article_id, owner_id, digest, synced_at
          FROM external_content_links WHERE provider = 'notion' AND external_id IN (${placeholders})`).all(...expected.sourceIds).map(mapRow);
        const keyArticle = get("SELECT id FROM articles WHERE author_id = ? AND idempotency_key_hash = ?",
          input.actorId, articleIdempotencyKeyHash(input.actorId, expected.createKey));
        const row = expected.article ? get("SELECT id, author_id, deleted_at, CAST(import_revision AS TEXT) AS revision FROM articles WHERE id = ?", expected.article.id) : undefined;
        assertNotionImportWorkState(input, { generation: generation(), links,
          createKeyArticleId: keyArticle ? String(keyArticle.id) : null,
          article: row ? { id: String(row.id), authorId: String(row.author_id), revision: String(row.revision), deleted: row.deleted_at !== null } : null });

        const scoped = sqliteImportSavepoints(db);
        const transactionId = createMigrationTransactionId();
        const articles = createSqliteArticleStore(scoped, { transactionId });
        const taxonomy = createSqliteTaxonomyStore(scoped, { transactionId });
        const wanted = [...new Set(input.editions.flatMap((edition) => edition.tags))].sort();
        const tags = new Map<string, string>();
        if (wanted.length) for (const tag of taxonomy.listTaxonomies({ kind: "tag", locale: "zh-CN", limit: 100 })) tags.set(tag.name, tag.id);
        for (const name of wanted) if (!tags.has(name)) tags.set(name, taxonomy.createTag({ actorId: input.actorId, name }).id);

        let articleId = expected.article?.id ?? null;
        const committed: CommittedNotionImportEdition[] = [];
        for (const edition of input.editions) {
          const tagIds = edition.tags.map((name) => tags.get(name)!).filter(Boolean);
          const created = articleId === null;
          let article;
          if (articleId === null) {
            for (let attempt = 1; ; attempt += 1) {
              try { article = articles.createArticle(importCreateCandidate(input, edition, tagIds, attempt)); break; }
              catch (error) {
                if (edition.requestedSlug !== null || !(error instanceof ArticleSlugConflictError) || attempt >= MAX_AUTO_SLUG_ATTEMPTS) throw error;
              }
            }
          } else {
            // The checked work lock remains held; prior editions are our own changes.
            const current = get("SELECT slug FROM articles WHERE id = ?", articleId);
            article = articles.updateArticle({ ...importEditionFields(edition, tagIds), articleId, actorId: input.actorId, slug: String(current!.slug) });
          }
          articleId = String(article.id);
          upsertLink({ provider: "notion", externalId: edition.externalId, locale: edition.locale,
            articleId, ownerId: input.actorId, digest: edition.digest, syncedAt: edition.syncedAt }, scoped, transactionId);
          committed.push({ externalId: edition.externalId, article, created });
        }
        db.exec("COMMIT");
        return committed;
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* preserve the original error */ }
        throw error;
      }
    },
    async getExternalContentLink({ provider, externalId, locale }: { provider: string; externalId: string; locale: string }) {
      const row = get(
        "SELECT provider, external_id, locale, article_id, owner_id, digest, synced_at FROM external_content_links WHERE provider = ? AND external_id = ? AND locale = ?",
        provider,
        externalId,
        locale,
      );
      return row ? mapRow(row) : null;
    },

    /**
     * The links of one work — the export's question, answered by the index that
     * already exists on `article_id`.
     *
     * Scoped by owner as well: the article predicate is what makes this a read of
     * the caller's own work, and the owner predicate keeps a link that was moved
     * (or never was theirs) from being reported as provenance.
     */
    async listExternalContentLinks({ provider, articleId, ownerId }: { provider: string; articleId: string; ownerId: string }) {
      return db.prepare(
        "SELECT provider, external_id, locale, article_id, owner_id, digest, synced_at FROM external_content_links WHERE provider = ? AND article_id = ? AND owner_id = ? ORDER BY locale",
      ).all(provider, articleId, ownerId).map(mapRow);
    },

    async upsertExternalContentLink(input: Parameters<typeof upsertLink>[0]) {
      return upsertLink(input);
    },
  }) satisfies Pick<TypedPersistenceAdapterContract, "getExternalContentLink" | "listExternalContentLinks" | "upsertExternalContentLink" | "getImportPlanGeneration" | "commitNotionImportWork">;
}
