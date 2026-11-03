import { createMigrationTransactionId } from "./provider-migration-journal.ts";
import { isoDate } from "./postgres-row-mappers.ts";
import type { TypedPersistenceAdapterContract } from "../application/persistence-adapter.ts";

/**
 * PostgreSQL media slice: asset metadata and the reference scan — the counterpart of
 * `sqlite-media-store.ts`. Bytes never enter the database.
 */
/** The reference rows in the shape the application's redaction rule reads. */
function referenceRowsToScan(referenced, avatarsByColumn, assetId) {
  return [
    ...referenced.map((row) => ({
      kind: "work",
      content: `/media/${assetId}`,
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
    ...avatarsByColumn.map(() => ({ kind: "avatar", content: `/media/${assetId}` })),
  ];
}

export function createPostgresMediaStore({ sql, captureChanges }): Pick<TypedPersistenceAdapterContract, "createMediaAsset" | "getMediaAsset" | "listMediaScanRows" | "listMediaRefs" | "listMediaAssets" | "deleteUnusedMediaAsset"> {
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
    /**
     * Who uses these assets, from the materialized reference table (issue #163).
     *
     * One indexed query bounded by the page, and no `content_blocks` read: the
     * reference the row already carries is enough for the redaction rule, which
     * only needs to know *that* a work points at the image and who wrote it.
     */
    async listMediaRefs({ assetIds }) {
      if (!Array.isArray(assetIds) || assetIds.length === 0) return [];
      const ids = assetIds.filter((id) => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id));
      if (ids.length === 0) return [];
      const [bodies, avatars] = await Promise.all([
        sql.unsafe(
          `SELECT r.asset_id, a.id AS article_id, a.slug, a.status, a.deleted_at, a.author_id, t.locale, t.title
           FROM article_media_refs r
           JOIN articles a ON a.id = r.article_id
           JOIN article_translations t ON t.article_id = a.id AND t.locale = r.locale
           WHERE r.asset_id = ANY($1::uuid[])`,
          [ids],
        ),
        sql.unsafe("SELECT avatar_media_id FROM user_profiles WHERE avatar_media_id = ANY($1::uuid[])", [ids]),
      ]);
      return [
        ...bodies.map((row) => ({
          kind: "work",
          content: `/media/${row.asset_id}`,
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
        ...avatars.map((row) => ({ kind: "avatar", content: `/media/${row.avatar_media_id}` })),
      ];
    },
    /** One owner's assets, newest first. One extra row is read so the caller can see whether there is a next page. */
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
     * The scan alone is not enough under READ COMMITTED (issue #156): a save that
     * commits between the scan and the `DELETE` has added a reference the scan
     * never saw, and the object that follows is unrecoverable. So the asset row
     * is locked `FOR UPDATE` **first**, and every writer that can create a
     * reference names its assets and locks them `FOR SHARE` (see
     * `lockMediaAssetReferences`). The two orders are the protocol:
     *
     * - this transaction first: a concurrent save blocks on the row and, once it
     *   continues, finds the asset gone and fails instead of writing a reference
     *   to nothing;
     * - a save first: this transaction blocks, and when it continues the
     *   committed reference is visible to the scan, which refuses the delete.
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
        // Locked before the scan, not after: the whole point is that no reference
        // can be committed between "nothing uses it" and "delete it".
        const existing = await tx.unsafe("SELECT * FROM media_assets WHERE id = $1 AND owner_id = $2 FOR UPDATE", [id, ownerId]);
        const row = existing[0];
        if (!row) return null;
        // The materialized answer first (issue #163), then the body scan as the
        // backstop: the table is what keeps this fast and the scan is what keeps
        // it honest if a row ever went missing from it. Either answer refusing is
        // enough — and the `ON DELETE RESTRICT` foreign key on the table is the
        // final word if both somehow miss.
        const needle = `%/media/${id.toLowerCase()}%`;
        const [referenced, avatarsByColumn] = await Promise.all([
          tx.unsafe(
            `SELECT r.asset_id, a.id AS article_id, a.slug, a.status, a.deleted_at, a.author_id, t.locale, t.title
             FROM article_media_refs r
             JOIN articles a ON a.id = r.article_id
             JOIN article_translations t ON t.article_id = a.id AND t.locale = r.locale
             WHERE r.asset_id = $1`,
            [id],
          ),
          tx.unsafe("SELECT user_id FROM user_profiles WHERE avatar_media_id = $1", [id]),
        ]);
        if (referenced.length > 0 || avatarsByColumn.length > 0) {
          return { deleted: null, usedBy: referenceRowsToScan(referenced, avatarsByColumn, id) };
        }
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
  });
}
