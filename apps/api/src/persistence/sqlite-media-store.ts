import { createMigrationTransactionId } from "./provider-migration-journal.ts";
import { createSqliteProviderMigrationCapture } from "./sqlite-provider-migration-capture.ts";
import type { MediaScanRow } from "../application/media-assets.ts";
import type { TypedPersistenceAdapterContract } from "../application/persistence-ports.ts";
import type { SqliteRow, SqliteRunner } from "./sqlite.ts";

function mapMediaAssetRow(row: SqliteRow) {
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

/** A read that may legitimately find nothing (a missing id, or another owner's). */
function mapMediaAsset(row: SqliteRow | undefined) {
  return row ? mapMediaAssetRow(row) : null;
}

/** SQLite implementation of the portable media metadata port. Object bytes never enter SQLite. */
export function createSqliteMediaStore(db: SqliteRunner) {
  if (!db || typeof db.prepare !== "function" || typeof db.exec !== "function") {
    throw new TypeError("A node:sqlite DatabaseSync connection is required.");
  }
  const migrationCapture = createSqliteProviderMigrationCapture(db);
  const run = (sql: string, ...args: unknown[]) => db.prepare(sql).run(...args);
  const get = (sql: string, ...args: unknown[]) => db.prepare(sql).get(...args);

  /** Work bodies and avatars, in the shape the media reference scan reads. */
  const BODY_SQL = `SELECT a.id AS article_id, a.slug, a.status, a.deleted_at, a.author_id, t.locale, t.title, t.content_blocks
         FROM article_translations t
         JOIN articles a ON a.id = t.article_id`;
  const AVATAR_SQL = "SELECT avatar_url FROM user_profiles WHERE avatar_url IS NOT NULL AND avatar_url <> ''";
  const mapBody = (row: SqliteRow): MediaScanRow => ({
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
  const mapAvatar = (row: SqliteRow): MediaScanRow => ({ kind: "avatar", content: row.avatar_url });
  /**
   * The same two questions answered from the materialised references (#163)
   * instead of by scanning every body on the site.
   *
   * The definition of "in use" has not changed — an asset whose id appears in a
   * body counts — but the place it is *answered* has: `article_media_refs` holds
   * that relationship materialised, and #156 made the database enforce it with
   * `ON DELETE RESTRICT`.
   *
   * That constraint only refuses a delete it can see a row for. A row can be
   * *missing* — a provider replay that predates reference capture (#217), an
   * older writer, a direct SQL fix — and then the foreign key has nothing to
   * refuse while the body still holds the URL. So this query is the fast path,
   * not the proof: `evidenceRowsUsing` is asked as well before anything is
   * deleted.
   */
  const referenceRowsUsing = (id: string): MediaScanRow[] => {
    const assetId = String(id).toLowerCase();
    const bodyRows = db.prepare(
      `SELECT a.id AS article_id, a.slug, a.status, a.deleted_at, a.author_id, t.locale, t.title, t.content_blocks
       FROM article_media_refs r
       JOIN article_translations t ON t.article_id = r.article_id AND t.locale = r.locale
       JOIN articles a ON a.id = r.article_id
       WHERE r.asset_id = ?`,
    ).all(assetId);
    const avatarRows = db.prepare(
      "SELECT avatar_url FROM user_profiles WHERE avatar_media_id = ? AND avatar_url IS NOT NULL AND avatar_url <> ''",
    ).all(assetId);
    return [...bodyRows.map(mapBody), ...avatarRows.map(mapAvatar)];
  };

  /**
   * The site-wide scan narrowed to one asset: the *evidence* that it is in use.
   *
   * `listMediaScanRows` asks this about every asset at once, which is what makes
   * the library page expensive; here the question is about one id at the moment
   * it would be deleted, so the same definition of "in use" costs one scan of
   * `article_translations` and one of the profiles instead of a materialised copy
   * kept correct forever.
   *
   * This is not the fast path and it is deliberately not the first answer — the
   * reference table is. It is the backstop for a reference table that is wrong,
   * which is the one case the foreign key cannot cover. `LIMIT` caps how much a
   * pathological body can return; the caller only needs to know that something
   * uses the asset.
   */
  const evidenceRowsUsing = (id: string): MediaScanRow[] => {
    const assetId = String(id).toLowerCase();
    // The row says "this asset": `content` carries the asset's own id, exactly as
    // the reference-table rows do, so the caller's extraction and redaction code
    // does not care which of the two questions answered.
    const evidence = `/media/${assetId}`;
    const bodies = db.prepare(
      `${BODY_SQL} WHERE instr(lower(t.content_blocks), ?) > 0 LIMIT 200`,
    ).all(assetId).map((row): MediaScanRow => ({ ...mapBody(row), content: evidence }));
    const avatars = db.prepare(
      "SELECT avatar_url FROM user_profiles WHERE avatar_url IS NOT NULL AND avatar_url <> '' AND instr(lower(avatar_url), ?) > 0 LIMIT 200",
    ).all(assetId).map((): MediaScanRow => ({ kind: "avatar", content: evidence }));
    return [...bodies, ...avatars];
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
        return mapMediaAssetRow(row);
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
      return rows.map(mapMediaAssetRow);
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
     * Who uses these assets, read from `article_media_refs` (#163).
     *
     * One indexed query for a page of at most 60 ids, instead of pulling every
     * work body on the site into memory. The work's title, slug, status and
     * author are joined in rather than stored on the reference row, so a retitled
     * work is described by its current title and a purged work leaves no row
     * behind.
     *
     * The result is shaped exactly like `listMediaScanRows` — one row per
     * (asset, use) with `content` carrying only the asset's own id — so the pure
     * extraction and redaction functions stay unchanged.
     */
    async listReferencesForAssets({ assetIds }) {
      if (!Array.isArray(assetIds)) throw new TypeError("assetIds must be an array.");
      const ids = [...new Set(assetIds.filter((id) => typeof id === "string" && id))];
      if (ids.length === 0) return [];
      const placeholders = ids.map(() => "?").join(", ");
      const workRows = db.prepare(
        `SELECT r.asset_id, r.locale, a.id AS article_id, a.slug, a.status, a.deleted_at, a.author_id, t.title
         FROM article_media_refs r
         JOIN articles a ON a.id = r.article_id
         JOIN article_translations t ON t.article_id = r.article_id AND t.locale = r.locale
         WHERE r.asset_id IN (${placeholders})`,
      ).all(...ids);
      // The reference row is what counts, not the join: a translation can be
      // removed by a purge between the two statements only in a torn read, and
      // the foreign key makes that impossible within one snapshot.
      const avatarRows = db.prepare(
        `SELECT avatar_media_id AS asset_id FROM user_profiles WHERE avatar_media_id IN (${placeholders})`,
      ).all(...ids);
      return [
        ...workRows.map((row): MediaScanRow => ({
          kind: "work",
          content: `/media/${row.asset_id}`,
          work: {
            articleId: row.article_id,
            slug: row.slug,
            status: row.status,
            deletedAt: row.deleted_at ?? null,
            locale: row.locale,
            title: row.title,
            authorId: row.author_id ?? "",
          },
        })),
        ...avatarRows.map((row): MediaScanRow => ({ kind: "avatar", content: `/media/${row.asset_id}` })),
      ];
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
        // The reference table answers this in O(references), not O(site text),
        // and `ON DELETE RESTRICT` refuses a delete it can see a row for. The
        // gap it cannot cover is a row that was never written: then the body
        // still holds the URL and this delete would commit over a live image
        // (#217). The same transaction therefore asks the body scan as well.
        const usedBy = referenceRowsUsing(id);
        if (usedBy.length > 0) {
          db.exec("COMMIT");
          return { deleted: null, usedBy };
        }
        const evidence = evidenceRowsUsing(id);
        if (evidence.length > 0) {
          db.exec("COMMIT");
          return { deleted: null, usedBy: evidence };
        }
        run("DELETE FROM media_assets WHERE id = ? AND owner_id = ?", id, ownerId);
        migrationCapture.captureInTransaction(db, transactionId, [
          { entityType: "media_assets", entityId: id, operation: "delete", payload: null },
        ]);
        db.exec("COMMIT");
        return { deleted: mapMediaAssetRow(row), usedBy: [] };
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
        throw error;
      }
    },
  }) satisfies Pick<TypedPersistenceAdapterContract, "createMediaAsset" | "getMediaAsset" | "listMediaAssets" | "listMediaScanRows" | "listReferencesForAssets" | "deleteUnusedMediaAsset">;
}
