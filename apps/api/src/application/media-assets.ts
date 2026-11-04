import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { decodeCursor, encodeCursor } from "../domain/cursor.ts";
import { isUuid } from "../domain/validation.ts";
import { MediaStorageUnavailableError, type MediaObjectStorage } from "../infrastructure/media-storage.ts";

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;
const MAX_DIMENSION = 2560;
const ACCEPTED_INPUT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const FORMAT_TYPES: Record<string, string> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

export type MediaAsset = {
  id: string;
  ownerId: string;
  storageKey: string;
  contentType: "image/webp";
  byteSize: number;
  width: number;
  height: number;
  sha256: string;
  createdAt: string;
};

/** One page of the media library. */
export const MEDIA_PAGE_SIZE = 24;
export const MEDIA_PAGE_SIZE_MAX = 60;

/** What a work that uses an asset is, as far as the reader is concerned. */
export type MediaWorkState = "draft" | "published" | "deleted";

/**
 * A reference as the scan finds it — including who wrote the work, which is
 * what lets the library keep somebody else's unpublished draft to itself.
 *
 * This shape never leaves the service.
 */
export type ScannedMediaReference =
  | { kind: "avatar" }
  | {
    kind: "work";
    articleId: string;
    slug: string;
    title: string;
    locale: string;
    state: MediaWorkState;
    authorId: string;
  };

/**
 * A reference as the library reports it.
 *
 * `state` is why a draft and a tombstone count as references: a draft is
 * published eventually and a tombstone can be restored, and restoring a work
 * into broken images is worse than keeping a few unreachable bytes.
 *
 * `redacted` is the other half of that: a draft belongs to whoever wrote it, so
 * a reference from somebody else's unpublished work is still a reference — the
 * image cannot be deleted — but whose work it is and what it is called are not
 * the asset owner's to read.
 */
export type MediaReference =
  | { kind: "avatar" }
  | {
    kind: "work";
    articleId: string;
    slug: string;
    title: string;
    locale: string;
    state: MediaWorkState;
    /** Another author's unpublished work: it counts, and it stays nameless. */
    redacted: boolean;
  };

/** One asset in the library: what the upload returned, plus whether anything uses it. */
export type MediaLibraryItem = {
  id: string;
  src: string;
  contentType: "image/webp";
  byteSize: number;
  width: number;
  height: number;
  createdAt: string;
  /** Nothing — no work's body, no profile picture — points at it. The only asset this library will delete. */
  orphan: boolean;
  referencedBy: MediaReference[];
};

/**
 * A page of the library.
 *
 * The cursor is built here rather than by the reader, which is the one way this
 * list differs from the public work lists: those existed before cursors did and
 * their readers build one from the last row, while nothing has ever read this
 * endpoint, so it can keep the encoding on the server where it belongs.
 */
export type MediaLibraryPage = { items: MediaLibraryItem[]; nextCursor: string | null };

/**
 * One place a media URL can live, as the reference scan reads it.
 *
 * A work's body is not the only one. A member's profile picture is stored as a
 * URL on the profile, outside any body, and it is as much in use as a cover
 * image: a scan that looked only at bodies would offer the avatar of a live
 * account as an orphan to be deleted.
 *
 * `content` is raw JSON text for a body (SQLite) or a parsed value (PostgreSQL),
 * and the stored URL for an avatar.
 */
export type MediaScanRow = {
  kind: "work" | "avatar";
  content: unknown;
  /** Present when `kind` is `work`. */
  work?: {
    articleId: string;
    slug: string;
    status: string;
    deletedAt: string | null;
    locale: string;
    title: string;
    authorId: string;
  };
};

type MediaMetadataStore = {
  createMediaAsset(asset: Omit<MediaAsset, "createdAt">): Promise<MediaAsset>;
  getMediaAsset(input: { id: string }): Promise<MediaAsset | null>;
  listMediaAssets(input: {
    ownerId: string;
    cursor: { at: string; id: string } | null;
    limit: number;
  }): Promise<MediaAsset[]>;
  /**
   * Every place a media URL can appear, for the reference scan.
   *
   * One method, because a reference is a reference wherever it lives: two
   * methods would be two chances for one of them to be forgotten at the point
   * where forgetting costs an image.
   */
  listMediaScanRows(): Promise<MediaScanRow[]>;
  /**
   * Delete one of an owner's assets **only if nothing uses it**, and answer
   * what was found either way.
   *
   * `null` when the asset is not this owner's — the only answer for "not yours"
   * and "not there". Otherwise the check and the delete have already happened
   * as one operation: a work saved after the check and before the delete is a
   * work whose images would otherwise go missing, and no amount of care in the
   * application layer can close a gap that is really between two statements.
   */
  deleteUnusedMediaAsset(input: { id: string; ownerId: string }): Promise<{
    deleted: MediaAsset | null;
    usedBy: MediaScanRow[];
  } | null>;
};

/**
 * The one place the reference scan's idea of "a media URL" is written down.
 *
 * Deliberately `/media/<uuid>` and not `/api/media/<uuid>`: the Web app serves
 * `/api/media/<id>` and relays it, and the API's own route is
 * `/api/v1/media/<id>` — which is the address a client that talks to the API
 * directly (the Flutter app) stores in a body. A pattern that matched only one
 * of them marked live cover images and avatars as orphans.
 *
 * Matching the path rather than a full URL also covers an absolute address, and
 * a stray `/media/<uuid>` in a code block would count as a reference, which is
 * the direction a mistake should go: it refuses a delete instead of allowing
 * one.
 */
export const MEDIA_SRC_PATTERN =
  /\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/gi;

export class MediaInputError extends Error {
  readonly statusCode = 400;
  readonly code = "BAD_USER_INPUT";
  constructor(message: string) { super(message); this.name = "MediaInputError"; }
}

/**
 * Is media deletion switched on for this deployment? (default: no)
 *
 * The delete route decides whether an image is still referenced by scanning
 * every work's body, then deletes it. Those two steps are not serialised against
 * a concurrent `createArticle` / `upsertAuthorProfile` on PostgreSQL, which runs
 * at READ COMMITTED and takes no lock on the `media_assets` row: a work saved in
 * the window between the scan and the delete loses its images permanently. That
 * is a data-loss race, not a performance problem, and the fix (#163) is a
 * materialised reference table with an `ON DELETE RESTRICT` foreign key.
 *
 * Until that lands the operation is off. This is the server-side answer, and it
 * is deliberately at the route rather than in the Web app: hiding a button in
 * one client leaves every other caller — including a Flutter build against the
 * same API — able to delete.
 *
 * Read at request time, like `isMailEnabled`, so an operator can turn it on
 * without a rebuild. Unset, empty and unrecognised values all mean "off": a
 * typo must never be able to switch on the operation that can destroy data.
 */
export function isMediaDeleteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = typeof env.MEDIA_DELETE_ENABLED === "string" ? env.MEDIA_DELETE_ENABLED.trim().toLowerCase() : "";
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

export class MediaAssetNotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = "NOT_FOUND";
  constructor() { super("The requested media asset was not found."); this.name = "MediaAssetNotFoundError"; }
}

/**
 * The asset is still in a work, so it cannot be deleted (409).
 *
 * The references travel with the error rather than being looked up again by the
 * transport: the answer to "why not" is the works that use it, and an error
 * carrying them cannot disagree with the check that raised it.
 */
export class MediaAssetInUseError extends Error {
  readonly statusCode = 409;
  readonly code = "MEDIA_IN_USE";
  readonly referencedBy: readonly MediaReference[];
  constructor(referencedBy: readonly MediaReference[]) {
    super("This image is still used by a work.");
    this.name = "MediaAssetInUseError";
    this.referencedBy = referencedBy;
  }
}

function inputError(message: string): never { throw new MediaInputError(message); }

/** Content blocks arrive as JSON text from SQLite and as a parsed value from PostgreSQL. */
function scanText(contentBlocks: unknown): string {
  if (typeof contentBlocks === "string") return contentBlocks;
  try {
    return JSON.stringify(contentBlocks) ?? "";
  } catch {
    return "";
  }
}

/**
 * Which assets are in use, and where.
 *
 * Pure, so the rule "an image is referenced when its URL appears in a work's
 * body or as somebody's avatar" is testable without a database — and the same
 * function answers for the library list, for the delete check and for the
 * provider's own guarded delete, so the badge a reader sees and the decision the
 * delete makes cannot drift apart.
 */
export function extractMediaReferences(rows: readonly MediaScanRow[]): Map<string, ScannedMediaReference[]> {
  const references = new Map<string, ScannedMediaReference[]>();
  if (!Array.isArray(rows)) return references;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    // An unrecognised row is skipped rather than assumed: counting it would
    // refuse a delete that is allowed, and ignoring it refuses nothing.
    if (row.kind !== "work" && row.kind !== "avatar") continue;
    const text = scanText(row.content);
    if (!text) continue;
    const work = row.kind === "work" ? row.work : undefined;
    if (row.kind === "work" && (!work || typeof work.articleId !== "string")) continue;
    const state: MediaWorkState = !work ? "draft"
      : work.deletedAt ? "deleted"
        : work.status === "published" ? "published"
          : "draft";
    const seen = new Set<string>();
    for (const match of text.matchAll(MEDIA_SRC_PATTERN)) {
      const id = match[1]!.toLowerCase();
      if (seen.has(id)) continue;
      seen.add(id);
      const list = references.get(id) ?? [];
      list.push(row.kind === "avatar" || !work ? { kind: "avatar" } : {
        kind: "work",
        articleId: work.articleId,
        slug: typeof work.slug === "string" ? work.slug : "",
        title: typeof work.title === "string" ? work.title : "",
        locale: typeof work.locale === "string" ? work.locale : "",
        state,
        authorId: typeof work.authorId === "string" ? work.authorId : "",
      });
      references.set(id, list);
    }
  }
  return references;
}

/**
 * What this reader may be told about the works using an asset.
 *
 * A published work is public and a reader's own draft is theirs, so both are
 * named. Somebody else's draft or tombstone is not: the asset owner has to be
 * told the image is in use — that is what stops them deleting it — but the
 * title of a work they cannot read is none of their business, and putting it in
 * a list response would publish it to whoever happens to own the bytes.
 */
export function referencesForOwner(
  references: ReadonlyMap<string, ScannedMediaReference[]>,
  assetId: string,
  viewerId: string,
): MediaReference[] {
  const found = references.get(String(assetId).toLowerCase()) ?? [];
  return found.map((reference) => {
    if (reference.kind === "avatar") return { kind: "avatar" } as MediaReference;
    const visible = reference.state === "published" || reference.authorId === viewerId;
    return visible
      ? {
        kind: "work",
        articleId: reference.articleId,
        slug: reference.slug,
        title: reference.title,
        locale: reference.locale,
        state: reference.state,
        redacted: false,
      }
      : { kind: "work", articleId: "", slug: "", title: "", locale: "", state: reference.state, redacted: true };
  });
}

/** An asset as the library shows it, without the reference check. */
function presentAsset(asset: MediaAsset): Omit<MediaLibraryItem, "orphan" | "referencedBy"> {
  return {
    id: asset.id,
    src: `/api/media/${asset.id}`,
    contentType: "image/webp",
    byteSize: asset.byteSize,
    width: asset.width,
    height: asset.height,
    createdAt: asset.createdAt,
  };
}

export async function normalizeUploadedImage(input: Buffer, declaredContentType: string): Promise<{
  bytes: Buffer; contentType: "image/webp"; byteSize: number; width: number; height: number; sha256: string;
}> {
  if (!Buffer.isBuffer(input) || input.byteLength < 1) inputError("The image body must not be empty.");
  if (input.byteLength > MAX_UPLOAD_BYTES) inputError("Images must be no larger than 8 MiB.");
  if (!ACCEPTED_INPUT_TYPES.has(declaredContentType.toLowerCase())) {
    inputError("Only JPEG, PNG and WebP images are accepted.");
  }

  let metadata;
  try {
    metadata = await sharp(input, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS, animated: false }).metadata();
  } catch {
    inputError("The uploaded bytes are not a supported, valid image.");
  }
  const actualContentType = metadata.format ? FORMAT_TYPES[metadata.format] : undefined;
  if (!actualContentType || actualContentType !== declaredContentType.toLowerCase()) {
    inputError("The image bytes do not match the declared JPEG, PNG or WebP media type.");
  }
  if (!metadata.width || !metadata.height || metadata.width < 1 || metadata.height < 1 ||
      metadata.width > 12000 || metadata.height > 12000 || (metadata.pages ?? 1) > 1) {
    inputError("Animated images and images with unsafe or unsupported dimensions are not accepted.");
  }

  let encoded;
  try {
    encoded = await sharp(input, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS, animated: false })
      .rotate()
      .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 84, effort: 4, smartSubsample: true })
      .toBuffer({ resolveWithObject: true });
  } catch {
    inputError("The image could not be safely normalized.");
  }
  if (encoded.data.byteLength < 1 || encoded.data.byteLength > MAX_UPLOAD_BYTES) {
    inputError("The normalized image exceeds the 8 MiB storage limit.");
  }
  const sha256 = createHash("sha256").update(encoded.data).digest("hex");
  return {
    bytes: encoded.data,
    contentType: "image/webp",
    byteSize: encoded.data.byteLength,
    width: encoded.info.width,
    height: encoded.info.height,
    sha256,
  };
}

/** The application service coordinates normalization, object storage and DB metadata with orphan cleanup. */
export function createMediaAssetService({ store, storage }: {
  store: MediaMetadataStore;
  storage: MediaObjectStorage;
}) {
  const requiredStoreMethods = [
    "createMediaAsset", "getMediaAsset", "listMediaAssets", "listMediaScanRows", "deleteUnusedMediaAsset",
  ];
  const missingStoreMethods = requiredStoreMethods.filter((method) => typeof store?.[method] !== "function");
  if (missingStoreMethods.length > 0) {
    throw new TypeError(`Media metadata persistence must support ${missingStoreMethods.join(", ")}.`);
  }
  if (!storage || typeof storage.putObject !== "function" || typeof storage.getObject !== "function" || typeof storage.deleteObject !== "function") {
    throw new TypeError("A configured media object storage adapter is required.");
  }
  return Object.freeze({
    async upload({ ownerId, bytes, contentType }: { ownerId: string; bytes: Buffer; contentType: string }) {
      if (!isUuid(ownerId)) inputError("The authenticated user identity is invalid.");
      const normalized = await normalizeUploadedImage(bytes, contentType);
      const id = randomUUID();
      const storageKey = `assets/${ownerId}/${id}.webp`;
      try {
        await storage.putObject({ key: storageKey, bytes: normalized.bytes, sha256: normalized.sha256 });
      } catch {
        try { await storage.deleteObject(storageKey); } catch { /* storage may be unavailable; no database row exists yet */ }
        throw new MediaStorageUnavailableError("The image could not be stored. Check the configured media service.");
      }
      try {
        const asset = await store.createMediaAsset({
          id, ownerId, storageKey, contentType: normalized.contentType,
          byteSize: normalized.byteSize, width: normalized.width, height: normalized.height, sha256: normalized.sha256,
        });
        return { id: asset.id, src: `/api/media/${asset.id}`, contentType: asset.contentType, byteSize: asset.byteSize, width: asset.width, height: asset.height };
      } catch (error) {
        try { await storage.deleteObject(storageKey); } catch { /* retain the original persistence error; orphan cleanup is an operational follow-up */ }
        throw error;
      }
    },
    async getPublic({ id }: { id: string }) {
      if (!isUuid(id)) throw new MediaAssetNotFoundError();
      const asset = await store.getMediaAsset({ id });
      if (!asset) throw new MediaAssetNotFoundError();
      if (!asset.storageKey.startsWith(`assets/${asset.ownerId}/`) || !asset.storageKey.endsWith(`.webp`) || asset.contentType !== "image/webp") {
        throw new MediaStorageUnavailableError("Stored media metadata is inconsistent.");
      }
      let bytes: Buffer;
      try {
        bytes = await storage.getObject(asset.storageKey);
      } catch {
        throw new MediaStorageUnavailableError("The stored image could not be retrieved.");
      }
      if (bytes.byteLength !== asset.byteSize || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
        throw new MediaStorageUnavailableError("Stored media integrity validation failed.");
      }
      return { id: asset.id, bytes, byteSize: asset.byteSize, width: asset.width, height: asset.height, sha256: asset.sha256, contentType: "image/webp" as const };
    },
    /**
     * `GET /api/v1/me/media` — this author's uploads, newest first.
     *
     * Every item carries its own reference check, because "is it an orphan" is
     * the only reason to open this page: an asset nothing uses is storage being
     * paid for and shown to nobody.
     */
    async listLibrary({ ownerId, cursor = null, limit = MEDIA_PAGE_SIZE }: {
      ownerId: string;
      cursor?: string | null;
      limit?: number;
    }): Promise<MediaLibraryPage> {
      if (!isUuid(ownerId)) inputError("The authenticated user identity is invalid.");
      let page = limit;
      if (cursor !== null && cursor !== undefined) {
        if (typeof cursor !== "string") inputError("Invalid cursor.");
        const decoded = decodeCursor(cursor);
        if (!decoded) inputError("Invalid cursor.");
      }
      // An integer, not merely a number: a fractional page size is a caller that
      // disagrees with itself, and truncating it would answer a different
      // question than the one asked.
      if (typeof page !== "number" || !Number.isInteger(page) || page < 1 || page > MEDIA_PAGE_SIZE_MAX) {
        inputError(`limit must be a whole number between 1 and ${MEDIA_PAGE_SIZE_MAX}.`);
      }
      const requested = page;
      const rows = await store.listMediaAssets({
        ownerId,
        cursor: cursor ? decodeCursor(cursor) : null,
        limit: requested + 1,
      });
      const items = rows.slice(0, requested);
      const references = extractMediaReferences(await store.listMediaScanRows());
      const page1 = items.map((asset) => {
        const referencedBy = referencesForOwner(references, asset.id, ownerId);
        return { ...presentAsset(asset), orphan: referencedBy.length === 0, referencedBy };
      });
      const last = items[items.length - 1];
      // Normalized rather than passed through: the cursor has to decode to the
      // same format whichever provider formatted the timestamp.
      const hasMore = rows.length > requested;
      const nextCursor = hasMore && last ? encodeCursor(new Date(last.createdAt).toISOString(), last.id) : null;
      return { items: page1, nextCursor };
    },
    /**
     * `DELETE /api/v1/me/media/:id` — delete an unused asset: its row, then its
     * object.
     *
     * The reference check is not trusted from the list — a work can have been
     * saved between the page being rendered and the button being pressed — and
     * it is not done here either, because a check followed by a delete is two
     * statements with a gap between them, and a work saved in that gap loses its
     * images. `deleteUnusedMediaAsset` scans and deletes in one operation, and
     * answers with whatever it found.
     *
     * The **row goes first**, which is the other way round from what this used to
     * do, and the reason is the same race: once the guarded delete has committed,
     * nothing can be referencing the row, so a failure to reach the bucket
     * afterwards can only leave invisible bytes — never a work pointing at bytes
     * that are gone. The caller is told whether the object went as well, so the
     * leftovers can be reclaimed instead of being quietly forgotten.
     */
    async deleteAsset({ ownerId, id }: { ownerId: string; id: string }): Promise<{
      id: string;
      objectDeleted: boolean;
      /** Set when the object could not be reached: the bytes are still there and nothing links to them. */
      orphanedStorageKey?: string;
    }> {
      if (!isUuid(ownerId)) inputError("The authenticated user identity is invalid.");
      if (!isUuid(id)) throw new MediaAssetNotFoundError();
      const result = await store.deleteUnusedMediaAsset({ id, ownerId });
      if (!result) throw new MediaAssetNotFoundError();
      if (!result.deleted) {
        throw new MediaAssetInUseError(referencesForOwner(extractMediaReferences(result.usedBy), id, ownerId));
      }
      const { storageKey } = result.deleted;
      try {
        await storage.deleteObject(storageKey);
        return { id, objectDeleted: true };
      } catch {
        // The row is gone and the page will say so; what is left is an object
        // nothing links to, which is a storage bill and not a broken work.
        return { id, objectDeleted: false, orphanedStorageKey: storageKey };
      }
    },
  });
}
