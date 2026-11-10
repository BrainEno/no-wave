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
export function createSqliteImportStore(db: SqliteRunner) {
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

  return Object.freeze({
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

    async upsertExternalContentLink(input: {
      provider: string; externalId: string; locale: string; articleId: string;
      ownerId: string; digest: string; syncedAt: string;
    }) {
      const transactionId = createMigrationTransactionId();
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = db.prepare(`INSERT INTO external_content_links (provider, external_id, locale, article_id, owner_id, digest, synced_at)
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
        const row = get(
          "SELECT provider, external_id, locale, article_id, owner_id, digest, synced_at FROM external_content_links WHERE provider = ? AND external_id = ? AND locale = ?",
          input.provider, input.externalId, input.locale,
        );
        if (!row) throw new Error("External content link upsert did not produce a row.");
        migrationCapture.captureInTransaction(db, transactionId, [
          { entityType: "external_content_links", entityId: migrationEntityKey(input.provider, input.externalId, input.locale), operation: "upsert", payload: row },
        ]);
        db.exec("COMMIT");
        return mapRow(row);
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
        throw error;
      }
    },
  }) satisfies Pick<TypedPersistenceAdapterContract, "getExternalContentLink" | "listExternalContentLinks" | "upsertExternalContentLink">;
}
