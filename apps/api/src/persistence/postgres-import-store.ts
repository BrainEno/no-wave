import { ExternalContentConflictError } from "../application/external-content-conflict.ts";
import { createPostgresProviderMigrationCapture, migrationEntityKey } from "./postgres-provider-migration-capture.ts";
import { createMigrationTransactionId } from "./provider-migration-journal.ts";
import type { TypedPersistenceAdapterContract } from "../application/persistence-ports.ts";
import { isUuid } from "../domain/validation.ts";
import type { PgDatabase } from "./postgres-driver.ts";

/**
 * Import provenance on PostgreSQL (ADR 0037) — the same table and the same
 * semantics as the SQLite slice, so the contract test can assert one behaviour.
 *
 * The upsert and its journal row share a transaction: a captured change that
 * describes a row which did not commit would make a provider cutover invent a
 * link to a page that does not exist.
 */
type ExternalContentLinkRow = {
  provider: string;
  external_id: string;
  locale: string;
  article_id: string;
  owner_id: string;
  digest: string;
  synced_at: Date | string;
};

function mapLinkRow(row: ExternalContentLinkRow) {
  return {
    provider: row.provider,
    externalId: row.external_id,
    locale: row.locale,
    articleId: row.article_id,
    ownerId: row.owner_id,
    digest: row.digest,
    // postgres.js decodes `timestamptz` as a Date; the contract answers ISO
    // strings so both providers are indistinguishable to a caller.
    syncedAt: row.synced_at instanceof Date ? row.synced_at.toISOString() : String(row.synced_at),
  };
}

const SELECT_COLUMNS = "provider, external_id, locale, article_id, owner_id, digest, synced_at";

export function createPostgresImportStore(sql: PgDatabase) {
  if (!sql || typeof sql.unsafe !== "function" || typeof sql.begin !== "function") {
    throw new TypeError("A postgres.js SQL client is required.");
  }
  const capture = createPostgresProviderMigrationCapture(sql);

  return Object.freeze({
    async getExternalContentLink({ provider, externalId, locale }: { provider: string; externalId: string; locale: string }) {
      const rows = await sql.unsafe<ExternalContentLinkRow>(
        `SELECT ${SELECT_COLUMNS} FROM external_content_links WHERE provider = $1 AND external_id = $2 AND locale = $3`,
        [provider, externalId, locale],
      );
      return rows[0] ? mapLinkRow(rows[0]) : null;
    },

    /** The links of one work, locale order; see the SQLite slice. */
    async listExternalContentLinks({ provider, articleId, ownerId }: { provider: string; articleId: string; ownerId: string }) {
      // An id that is not a uuid cannot match a uuid column; answer like a miss
      // instead of letting the cast raise a driver error, exactly like `getMyArticle`.
      if (!isUuid(articleId)) return [];
      const rows = await sql.unsafe<ExternalContentLinkRow>(
        `SELECT ${SELECT_COLUMNS} FROM external_content_links
         WHERE provider = $1 AND article_id = $2::uuid AND owner_id = $3
         ORDER BY locale`,
        [provider, articleId, ownerId],
      );
      return rows.map(mapLinkRow);
    },

    async upsertExternalContentLink(input: {
      provider: string; externalId: string; locale: string; articleId: string;
      ownerId: string; digest: string; syncedAt: string;
    }) {
      try {
        return await sql.begin(async (tx) => {
        const rows = await tx.unsafe<ExternalContentLinkRow>(
          `INSERT INTO external_content_links (provider, external_id, locale, article_id, owner_id, digest, synced_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
           ON CONFLICT (provider, external_id, locale) DO UPDATE SET
             article_id = excluded.article_id,
             owner_id = excluded.owner_id,
             digest = excluded.digest,
             synced_at = excluded.synced_at
           WHERE external_content_links.owner_id = excluded.owner_id
             AND external_content_links.article_id = excluded.article_id
           RETURNING ${SELECT_COLUMNS}`,
          [input.provider, input.externalId, input.locale, input.articleId, input.ownerId, input.digest, input.syncedAt],
        );
        const row = rows[0];
        if (!row) throw new ExternalContentConflictError();
        await capture.captureInTransaction(tx, createMigrationTransactionId(), [
          {
            entityType: "external_content_links",
            entityId: migrationEntityKey(input.provider, input.externalId, input.locale),
            operation: "upsert",
            payload: row,
          },
        ]);
        return mapLinkRow(row);
        });
      } catch (error: unknown) {
        // Only translate our ownership constraint; unrelated database failures
        // must retain their original error and diagnostics.
        if (typeof error === "object" && error !== null && "code" in error && error.code === "23P01" &&
            "constraint_name" in error && error.constraint_name === "external_content_links_page_owner_excl") {
          throw new ExternalContentConflictError();
        }
        throw error;
      }
    },
  }) satisfies Pick<TypedPersistenceAdapterContract, "getExternalContentLink" | "listExternalContentLinks" | "upsertExternalContentLink">;
}
