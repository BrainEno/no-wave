/**
 * PostgreSQL persistence slice: Media asset metadata and reference scans.
 *
 * Composed by postgres.ts. Row mapping and shared SQL helpers live in
 * postgres-shared.ts so every slice reads rows the same way.
 */
import { createMigrationTransactionId } from "./provider-migration-journal.ts";
import type { PostgresStoreContext } from "./postgres-shared.ts";
import type { MediaPersistencePort } from "../application/persistence-ports.ts";

export function createPostgresMediaStore(ctx: PostgresStoreContext) {
  const { sql, captureChanges } = ctx;
  return Object.freeze({
    async createMediaAsset(asset) {
      return sql.begin(async (tx) => {
        const transactionId = createMigrationTransactionId();
        const inserted = await tx.unsafe(
          // The migration normalizes the column default too; writing it here
          // keeps this adapter independent of that default.
          "INSERT INTO media_assets (id, owner_id, storage_key, content_type, byte_size, width, height, sha256, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, date_trunc('milliseconds', now())) RETURNING *",
          [asset.id, asset.ownerId, asset.storageKey, asset.contentType, asset.byteSize, asset.width, asset.height, asset.sha256],
        );
        const row = inserted[0];
        if (!row) throw new Error("Media metadata insert did not return a row.");
        await captureChanges(tx, transactionId, [{ entityType: "media_assets", entityId: row.id, operation: "upsert", payload: row }]);
        return {
          id: row.id, ownerId: row.owner_id, storageKey: row.storage_key, contentType: row.content_type,
          byteSize: row.byte_size, width: row.width, height: row.height, sha256: row.sha256,
          createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
        };
      });
    },

    async getMediaAsset({ id }) {
      if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return null;
      const rows = await sql.unsafe("SELECT * FROM media_assets WHERE id = $1", [id]);
      const row = rows[0];
      return row ? {
        id: row.id, ownerId: row.owner_id, storageKey: row.storage_key, contentType: row.content_type,
        byteSize: row.byte_size, width: row.width, height: row.height, sha256: row.sha256,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
      } : null;
    },

    /**
     * Every article body, as raw JSON text, for the media reference scan (ADR 0022).
     *
     * `content_blocks` is cast to text so both providers hand the application
     * layer the same thing: SQLite stores the JSON as text, PostgreSQL as
     * `jsonb`, and one of them would otherwise return an object.
     *
     * Drafts and tombstones are included on purpose — a draft gets published and
     * a tombstone can be restored, and restoring a work into broken images is
     * worse than keeping a few bytes.
     */
    /** Every place a media URL can live: work bodies in every locale, and profile pictures. */
    async listMediaScanRows() {
      const [bodies, avatars] = await Promise.all([
        sql.unsafe(
          `SELECT a.id AS article_id, a.slug, a.status, a.deleted_at, a.author_id, t.locale, t.title, t.content_blocks::text AS content_blocks
           FROM article_translations t
           JOIN articles a ON a.id = t.article_id`,
        ),
        sql.unsafe("SELECT avatar_url FROM user_profiles WHERE avatar_url IS NOT NULL AND avatar_url <> ''"),
      ]);
      return [
        ...bodies.map((row) => ({
          kind: "work",
          content: row.content_blocks,
          work: {
            articleId: row.article_id,
            slug: row.slug,
            status: row.status,
            deletedAt: row.deleted_at ? new Date(row.deleted_at).toISOString() : null,
            locale: row.locale,
            title: row.title,
            authorId: row.author_id ?? "",
          },
        })),
        ...avatars.map((row) => ({ kind: "avatar", content: row.avatar_url })),
      ];
    },

    /** One owner's assets, newest first. One extra row is read so the caller can see whether there is a next page. */
    async listMediaAssets({ ownerId, cursor = null, limit = 24 }) {
      const safeLimit = Math.min(Math.max(Math.trunc(Number(limit)) || 24, 1), 60);
      const rows = await sql.unsafe(
        cursor === null
          ? "SELECT * FROM media_assets WHERE owner_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2"
          // The cursor is a millisecond ISO string; normalizing the parameter
          // keeps media_assets_owner_created_idx usable and compares like with like.
          : "SELECT * FROM media_assets WHERE owner_id = $1 AND (created_at < date_trunc('milliseconds', $2::timestamptz) OR (created_at = date_trunc('milliseconds', $2::timestamptz) AND id < $3)) ORDER BY created_at DESC, id DESC LIMIT $4",
        cursor === null ? [ownerId, safeLimit + 1] : [ownerId, cursor.at, cursor.id, safeLimit + 1],
      );
      return rows.map((row) => ({
        id: row.id, ownerId: row.owner_id, storageKey: row.storage_key, contentType: row.content_type,
        byteSize: row.byte_size, width: row.width, height: row.height, sha256: row.sha256,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
      }));
    },

    /**
     * Delete one of an owner's assets, but only if nothing uses it — scanned and
     * deleted inside one transaction, because a scan and a delete done
     * separately leave a gap a concurrent save fits through.
     *
     * `null` when the asset is not this owner's, which is the same answer as
     * "not there". `ILIKE` rather than a JSON walk, for the same reason as the
     * SQLite provider: a UUID inside a `/media/` path is a reference, and being
     * imprecise this way round only ever refuses a delete.
     */
    async deleteUnusedMediaAsset({ id, ownerId }) {
      if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return null;
      return sql.begin(async (tx) => {
        const transactionId = createMigrationTransactionId();
        const existing = await tx.unsafe("SELECT * FROM media_assets WHERE id = $1 AND owner_id = $2", [id, ownerId]);
        const row = existing[0];
        if (!row) return null;
        const needle = `%/media/${id.toLowerCase()}%`;
        const [bodies, avatars] = await Promise.all([
          tx.unsafe(
            `SELECT a.id AS article_id, a.slug, a.status, a.deleted_at, a.author_id, t.locale, t.title, t.content_blocks::text AS content_blocks
             FROM article_translations t
             JOIN articles a ON a.id = t.article_id
             WHERE t.content_blocks::text ILIKE $1`,
            [needle],
          ),
          tx.unsafe("SELECT avatar_url FROM user_profiles WHERE avatar_url IS NOT NULL AND avatar_url ILIKE $1", [needle]),
        ]);
        const usedBy = [
          ...bodies.map((body) => ({
            kind: "work",
            content: body.content_blocks,
            work: {
              articleId: body.article_id,
              slug: body.slug,
              status: body.status,
              deletedAt: body.deleted_at ? new Date(body.deleted_at).toISOString() : null,
              locale: body.locale,
              title: body.title,
              authorId: body.author_id ?? "",
            },
          })),
          ...avatars.map((avatar) => ({ kind: "avatar", content: avatar.avatar_url })),
        ];
        if (usedBy.length > 0) return { deleted: null, usedBy };
        await tx.unsafe("DELETE FROM media_assets WHERE id = $1 AND owner_id = $2", [id, ownerId]);
        await captureChanges(tx, transactionId, [{ entityType: "media_assets", entityId: id, operation: "delete", payload: null }]);
        return {
          deleted: {
            id: row.id, ownerId: row.owner_id, storageKey: row.storage_key, contentType: row.content_type,
            byteSize: row.byte_size, width: row.width, height: row.height, sha256: row.sha256,
            createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
          },
          usedBy: [],
        };
      });
    },

  }) satisfies MediaPersistencePort;
}
