import { articleIdempotencyKeyHash } from "../application/article-idempotency.ts";
import { assertNotionImportWorkState, type CommitNotionImportWorkInput, type CommittedNotionImportEdition } from "../application/notion-import-plan.ts";
import { ArticleSlugConflictError, ImportConflictError } from "../domain/errors.ts";
import { createPostgresArticleStore } from "./postgres-article-store.ts";
import { createPostgresTaxonomyStore } from "./postgres-taxonomy-store.ts";
import { createPostgresStoreContext } from "./postgres-shared.ts";
import { importCreateCandidate, importEditionFields, MAX_AUTO_SLUG_ATTEMPTS, postgresImportSavepoints, lockNotionImportPages } from "./notion-import-transaction.ts";
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

export function createPostgresImportStore(sql: PgDatabase, options: { transactionId?: string } = {}) {
  if (!sql || typeof sql.unsafe !== "function" || typeof sql.begin !== "function") {
    throw new TypeError("A postgres.js SQL client is required.");
  }
  const capture = createPostgresProviderMigrationCapture(sql);

  return Object.freeze({
    async getImportPlanGeneration(): Promise<string> {
      const [row] = await sql.unsafe("SELECT generation FROM import_plan_generation WHERE singleton = 1");
      if (!row) throw new Error("The import plan generation is missing; run migrations.");
      return String(row.generation);
    },

    async commitNotionImportWork(input: CommitNotionImportWorkInput): Promise<CommittedNotionImportEdition[]> {
      return sql.begin(async (tx) => {
        const expected = input.expected;
        // Claims of an absent page/locale cannot be row-locked. All adapter link
        // writers take the same sorted page locks before looking or inserting.
        await lockNotionImportPages(tx, expected.sourceIds);
        const [epoch] = await tx.unsafe("SELECT generation FROM import_plan_generation WHERE singleton = 1 FOR SHARE");
        const links = await tx.unsafe<ExternalContentLinkRow>(`SELECT ${SELECT_COLUMNS} FROM external_content_links
          WHERE provider = 'notion' AND external_id = ANY($1::text[]) FOR UPDATE`, [expected.sourceIds]);
        const [keyArticle] = await tx.unsafe("SELECT id FROM articles WHERE author_id = $1 AND idempotency_key_hash = $2",
          [input.actorId, articleIdempotencyKeyHash(input.actorId, expected.createKey)]);
        const [row] = expected.article ? await tx.unsafe("SELECT id, author_id, deleted_at, import_revision::text AS revision FROM articles WHERE id = $1 FOR UPDATE", [expected.article.id]) : [];
        assertNotionImportWorkState(input, { generation: String(epoch?.generation), links: links.map(mapLinkRow),
          createKeyArticleId: keyArticle ? String(keyArticle.id) : null,
          article: row ? { id: String(row.id), authorId: String(row.author_id), revision: String(row.revision), deleted: row.deleted_at !== null } : null });

        const scoped = postgresImportSavepoints(tx);
        const transactionId = createMigrationTransactionId();
        const base = createPostgresStoreContext(scoped);
        const ctx: ReturnType<typeof createPostgresStoreContext> = { sql: scoped,
          captureChanges: (executor, _childId, changes) => base.captureChanges(executor, transactionId, changes) };
        const articles = createPostgresArticleStore(ctx);
        const taxonomy = createPostgresTaxonomyStore(ctx);
        const imports = createPostgresImportStore(scoped, { transactionId });
        const wanted = [...new Set(input.editions.flatMap((edition) => edition.tags))].sort();
        const tags = new Map<string, string>();
        if (wanted.length) for (const tag of await taxonomy.listTaxonomies({ kind: "tag", locale: "zh-CN", limit: 100 })) tags.set(tag.name, tag.id);
        for (const name of wanted) if (!tags.has(name)) tags.set(name, (await taxonomy.createTag({ actorId: input.actorId, name })).id);

        let articleId = expected.article?.id ?? null;
        const committed: CommittedNotionImportEdition[] = [];
        for (const edition of input.editions) {
          const tagIds = edition.tags.map((name) => tags.get(name)!).filter(Boolean);
          const created = articleId === null;
          let article;
          if (articleId === null) {
            for (let attempt = 1; ; attempt += 1) {
              try { article = await articles.createArticle(importCreateCandidate(input, edition, tagIds, attempt)); break; }
              catch (error) {
                if (edition.requestedSlug !== null || !(error instanceof ArticleSlugConflictError) || attempt >= MAX_AUTO_SLUG_ATTEMPTS) throw error;
              }
            }
          } else {
            const [current] = await tx.unsafe("SELECT slug FROM articles WHERE id = $1", [articleId]);
            article = await articles.updateArticle({ ...importEditionFields(edition, tagIds), articleId, actorId: input.actorId, slug: String(current!.slug) });
          }
          articleId = String(article.id);
          await imports.upsertExternalContentLink({ provider: "notion", externalId: edition.externalId, locale: edition.locale,
            articleId, ownerId: input.actorId, digest: edition.digest, syncedAt: edition.syncedAt });
          committed.push({ externalId: edition.externalId, article, created });
        }
        return committed;
      });
    },
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
          await lockNotionImportPages(tx, [input.externalId]);
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
          if (!row) throw new ImportConflictError("provenance");
          await capture.captureInTransaction(tx, options.transactionId ?? createMigrationTransactionId(), [
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
        // Match both the SQLSTATE and our named constraint, not every exclusion.
        if (typeof error === "object" && error !== null && "code" in error && error.code === "23P01" &&
            "constraint_name" in error && error.constraint_name === "external_content_links_page_owner_excl") {
          throw new ImportConflictError("ownership");
        }
        throw error;
      }
    },
  }) satisfies Pick<TypedPersistenceAdapterContract, "getExternalContentLink" | "listExternalContentLinks" | "upsertExternalContentLink" | "getImportPlanGeneration" | "commitNotionImportWork">;
}
