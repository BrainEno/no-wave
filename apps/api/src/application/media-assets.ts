import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
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

type MediaMetadataStore = {
  createMediaAsset(asset: Omit<MediaAsset, "createdAt">): Promise<MediaAsset>;
  getMediaAsset(input: { id: string }): Promise<MediaAsset | null>;
};

export class MediaUploadInputError extends Error {
  readonly statusCode = 400;
  readonly code = "BAD_USER_INPUT";
  constructor(message: string) { super(message); this.name = "MediaUploadInputError"; }
}

export class MediaAssetNotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = "NOT_FOUND";
  constructor() { super("The requested media asset was not found."); this.name = "MediaAssetNotFoundError"; }
}

function inputError(message: string): never { throw new MediaUploadInputError(message); }

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
  if (!store || typeof store.createMediaAsset !== "function" || typeof store.getMediaAsset !== "function") {
    throw new TypeError("Media metadata persistence must support createMediaAsset and getMediaAsset.");
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
  });
}
