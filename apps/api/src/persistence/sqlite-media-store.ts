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
  });
}
