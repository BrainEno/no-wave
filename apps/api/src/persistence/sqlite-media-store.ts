import { createMigrationTransactionId } from "./provider-migration-journal.ts";
import { createSqliteProviderMigrationCapture } from "./sqlite-provider-migration-capture.ts";
import type { TypedPersistenceAdapterContract } from "../application/persistence-ports.ts";

function mapMediaAsset(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerId: row.owner_id,
    storageKey: row.storage_key,
    contentType: row.content_type,
    byteSize: row.byte_size,
    width: row.width,
    height: row.height,
    sha256: row.sha256,
    createdAt: row.created_at,
  };
}

/** SQLite implementation of the portable media metadata port. Object bytes never enter SQLite. */
export function createSqliteMediaStore(db) {
  if (!db || typeof db.prepare !== "function" || typeof db.exec !== "function") {
    throw new TypeError("A node:sqlite DatabaseSync connection is required.");
  }
  const migrationCapture = createSqliteProviderMigrationCapture(db);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const get = (sql, ...args) => db.prepare(sql).get(...args);

  /** Work bodies and avatars, in the shape the media reference scan reads. */
  const BODY_SQL = `SELECT a.id AS article_id, a.slug, a.status, a.deleted_at, a.author_id, t.locale, t.title, t.content_blocks
         FROM article_translations t
         JOIN articles a ON a.id = t.article_id`;
  const AVATAR_SQL = "SELECT avatar_url FROM user_profiles WHERE avatar_url IS NOT NULL AND avatar_url <> ''";
  const mapBody = (row) => ({
    kind: "work",
    content: row.content_blocks,
    work: {
      articleId: row.article_id,
      slug: row.slug,
      status: row.status,
      deletedAt: row.deleted_at ?? null,
      locale: row.locale,
      title: row.title,
      authorId: row.author_id ?? "",
    },
  });
  const mapAvatar = (row) => ({ kind: "avatar", content: row.avatar_url });
  /**
   * The rows whose text holds `<id>` in a media path.
   *
   * `lower(...) LIKE` rather than a JSON walk: the id is a UUID, and a UUID
   * cannot be part of a media path by accident. It is also the safe direction to
   * be imprecise in — an extra match refuses a delete, a missed one allows one.
   */
  const scanRowsUsing = (id) => {
    const needle = `%/media/${String(id).toLowerCase()}%`;
    return [
      ...db.prepare(`${BODY_SQL} WHERE lower(t.content_blocks) LIKE ?`).all(needle).map(mapBody),
      ...db.prepare(`${AVATAR_SQL} AND lower(avatar_url) LIKE ?`).all(needle).map(mapAvatar),
    ];
  };

  return Object.freeze({
    async createMediaAsset(asset) {
      const transactionId = createMigrationTransactionId();
      db.exec("BEGIN IMMEDIATE");
      try {
        run(
          "INSERT INTO media_assets (id, owner_id, storage_key, content_type, byte_size, width, height, sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          asset.id, asset.ownerId, asset.storageKey, asset.contentType, asset.byteSize, asset.width, asset.height, asset.sha256,
        );
        const row = get("SELECT * FROM media_assets WHERE id = ?", asset.id);
        if (!row) throw new Error("Media metadata insert did not produce a row.");
        migrationCapture.captureInTransaction(db, transactionId, [
          { entityType: "media_assets", entityId: asset.id, operation: "upsert", payload: row },
        ]);
        db.exec("COMMIT");
        return mapMediaAsset(row);
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
        throw error;
      }
    },
    async getMediaAsset({ id }) {
      if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return null;
      return mapMediaAsset(get("SELECT * FROM media_assets WHERE id = ?", id));
    },
    /**
     * One owner's assets, newest first.
     *
     * `limit + 1` rows are read so the caller can tell "exactly a page" from
     * "the end" without a second query; the extra row is never returned.
     *
     * A cursor is a place in the `(created_at DESC, id DESC)` order, expanded
     * into a plain comparison instead of a row-value one so the same predicate
     * works on both providers and still uses `media_assets_owner_created_idx`.
     */
    async listMediaAssets({ ownerId, cursor = null, limit = 24 }) {
      const safeLimit = Math.min(Math.max(Math.trunc(Number(limit)) || 24, 1), 60);
      const rows = cursor === null
        ? db.prepare(
          "SELECT * FROM media_assets WHERE owner_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
        ).all(ownerId, safeLimit + 1)
        : db.prepare(
          "SELECT * FROM media_assets WHERE owner_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?",
        ).all(ownerId, cursor.at, cursor.at, cursor.id, safeLimit + 1);
      return rows.map(mapMediaAsset);
    },
    /**
     * Every place a media URL can live, for the reference scan: every work body,
     * in every locale, and every profile picture.
     *
     * Bodies are the obvious half. Avatars are the half that costs an image when
     * it is missed: they are stored as a URL on the profile and appear in no
     * body at all, so a scan of bodies alone offers a live account's picture as
     * an orphan to be deleted.
     */
    async listMediaScanRows() {
      return [...db.prepare(BODY_SQL).all().map(mapBody), ...db.prepare(AVATAR_SQL).all().map(mapAvatar)];
    },
    /**
     * Delete one of an owner's assets, but only if nothing uses it — and scan
     * for that inside the same transaction as the delete.
     *
     * `null` means the asset is not this owner's, which is the same answer as
     * "not there": the endpoint cannot be used to find out which ids exist.
     * Otherwise the rows that were found are returned whether or not the delete
     * happened, so the caller can name them (as far as it is allowed to).
     *
     * The scan and the delete are one transaction because they are one decision.
     * Doing them as two statements leaves a gap a concurrent save fits through:
     * the scan sees nothing, a work is saved with the image in it, the delete
     * removes the row — and the work that was just saved has lost its picture.
     */
    async deleteUnusedMediaAsset({ id, ownerId }) {
      if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return null;
      const transactionId = createMigrationTransactionId();
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = get("SELECT * FROM media_assets WHERE id = ? AND owner_id = ?", id, ownerId);
        if (!row) {
          db.exec("COMMIT");
          return null;
        }
        const usedBy = scanRowsUsing(id);
        if (usedBy.length > 0) {
          db.exec("COMMIT");
          return { deleted: null, usedBy };
        }
        run("DELETE FROM media_assets WHERE id = ? AND owner_id = ?", id, ownerId);
        migrationCapture.captureInTransaction(db, transactionId, [
          { entityType: "media_assets", entityId: id, operation: "delete", payload: null },
        ]);
        db.exec("COMMIT");
        return { deleted: mapMediaAsset(row), usedBy: [] };
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
        throw error;
      }
    },
  }) satisfies Pick<TypedPersistenceAdapterContract, "createMediaAsset" | "getMediaAsset" | "listMediaAssets" | "listMediaScanRows" | "deleteUnusedMediaAsset">;
}
