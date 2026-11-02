import { createMigrationTransactionId } from "./provider-migration-journal.ts";
import { createSqliteProviderMigrationCapture } from "./sqlite-provider-migration-capture.ts";

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
     * Delete one of an owner's assets, or answer `null`.
     *
     * The owner is part of the predicate rather than a check before it: the row
     * that disappears is the row this owner had, so "not yours" and "not there"
     * stay the same answer — the endpoint cannot be used to find out which ids
     * exist.
     */
    async deleteMediaAsset({ id, ownerId }) {
      if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return null;
      const transactionId = createMigrationTransactionId();
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = get("SELECT * FROM media_assets WHERE id = ? AND owner_id = ?", id, ownerId);
        if (!row) {
          db.exec("COMMIT");
          return null;
        }
        run("DELETE FROM media_assets WHERE id = ? AND owner_id = ?", id, ownerId);
        migrationCapture.captureInTransaction(db, transactionId, [
          { entityType: "media_assets", entityId: id, operation: "delete", payload: null },
        ]);
        db.exec("COMMIT");
        return mapMediaAsset(row);
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
        throw error;
      }
    },
  });
}
