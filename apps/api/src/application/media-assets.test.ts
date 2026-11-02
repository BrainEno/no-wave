import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {
  MEDIA_PAGE_SIZE,
  MediaAssetInUseError,
  MediaAssetNotFoundError,
  MediaInputError,
  createMediaAssetService,
  extractMediaReferences,
  normalizeUploadedImage,
} from "./media-assets.ts";
import { MediaStorageUnavailableError } from "../infrastructure/media-storage.ts";

async function pngBuffer() {
  return sharp({ create: { width: 24, height: 18, channels: 4, background: { r: 240, g: 30, b: 120, alpha: 1 } } }).png().toBuffer();
}

test("upload normalization verifies the declared type and emits bounded WebP bytes", async () => {
  const bytes = await pngBuffer();
  const result = await normalizeUploadedImage(bytes, "image/png");
  const metadata = await sharp(result.bytes).metadata();
  assert.equal(result.contentType, "image/webp");
  assert.equal(metadata.format, "webp");
  assert.equal(result.width, 24);
  assert.equal(result.height, 18);
  assert.equal(result.byteSize, result.bytes.byteLength);
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
});

test("upload normalization rejects empty, oversized, mismatched and unsupported payloads", async () => {
  await assert.rejects(normalizeUploadedImage(Buffer.alloc(0), "image/png"), /must not be empty/);
  await assert.rejects(normalizeUploadedImage(Buffer.alloc(8 * 1024 * 1024 + 1), "image/png"), /8 MiB/);
  await assert.rejects(normalizeUploadedImage(await pngBuffer(), "image/jpeg"), /do not match/);
  await assert.rejects(normalizeUploadedImage(Buffer.from("<svg/>"), "image/svg+xml"), /Only JPEG, PNG and WebP/);
  await assert.rejects(normalizeUploadedImage(Buffer.from("not an image"), "image/png"), /not a supported/);
});

test("media service removes uploaded objects if metadata persistence fails", async () => {
  const keyLog: string[] = [];
  const store = {
    async createMediaAsset() { throw new Error("db down"); },
    async getMediaAsset() { return null; },
    async listMediaAssets() { return []; },
    async deleteMediaAsset() { return null; },
    async listArticleContentForMediaScan() { return []; },
  };
  const storage = {
    async putObject({ key }: { key: string }) { keyLog.push("put:" + key); },
    async getObject() { return Buffer.alloc(0); },
    async deleteObject(key: string) { keyLog.push("delete:" + key); },
    close() {},
  };
  const service = createMediaAssetService({ store, storage });
  await assert.rejects(service.upload({ ownerId: "11111111-1111-4111-8111-111111111111", bytes: await pngBuffer(), contentType: "image/png" }), /db down/);
  assert.equal(keyLog.length, 2);
  assert.match(keyLog[0]!, /^put:assets\/11111111-1111-4111-8111-111111111111\//);
  assert.equal(keyLog[0]!.replace("put:", "delete:"), keyLog[1]);
});

test("object-storage failures are sanitized as service-unavailable errors", async () => {
  const store = {
    async createMediaAsset() { throw new Error("not expected"); },
    async getMediaAsset() {
      return {
        id: "22222222-2222-4222-8222-222222222222",
        ownerId: "11111111-1111-4111-8111-111111111111",
        storageKey: "assets/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.webp",
        contentType: "image/webp",
        byteSize: 10,
        width: 10,
        height: 10,
        sha256: "a".repeat(64),
        createdAt: "2026-10-29T00:00:00.000Z",
      };
    },
    async listMediaAssets() { return []; },
    async deleteMediaAsset() { return null; },
    async listArticleContentForMediaScan() { return []; },
  };
  const storage = {
    async putObject() { throw new Error("private bucket credentials leaked"); },
    async getObject() { throw new Error("private bucket credentials leaked"); },
    async deleteObject() { throw new Error("bucket unavailable"); },
    close() {},
  };
  const service = createMediaAssetService({ store, storage });
  await assert.rejects(
    service.upload({ ownerId: "11111111-1111-4111-8111-111111111111", bytes: await pngBuffer(), contentType: "image/png" }),
    (error) => error instanceof MediaStorageUnavailableError && !error.message.includes("credentials"),
  );
  await assert.rejects(
    service.getPublic({ id: "22222222-2222-4222-8222-222222222222" }),
    (error) => error instanceof MediaStorageUnavailableError && !error.message.includes("credentials"),
  );
});

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";

function assetAt(index: number, id = `0000000${index}-0000-4000-8000-${String(index).padStart(12, "0")}`) {
  return {
    id,
    ownerId: OWNER,
    storageKey: `assets/${OWNER}/${id}.webp`,
    contentType: "image/webp",
    byteSize: 1024,
    width: 24,
    height: 18,
    sha256: "b".repeat(64),
    // Newest first, so a later index is an earlier upload.
    createdAt: `2026-10-${String(29 - index).padStart(2, "0")}T00:00:00.000Z`,
  };
}

/** A store whose list is `assets` and whose content scan is `scanRows`. */
function libraryStore(assets: ReturnType<typeof assetAt>[], scanRows: unknown[] = []) {
  const calls: string[] = [];
  return {
    calls,
    store: {
      async createMediaAsset() { throw new Error("not used"); },
      async getMediaAsset({ id }: { id: string }) { return assets.find((asset) => asset.id === id) ?? null; },
      async listMediaAssets({ limit, cursor }: { limit: number; cursor: { at: string; id: string } | null }) {
        calls.push(`list:${limit}`);
        // Newest first, past the cursor — the same predicate both providers use.
        const after = cursor === null
          ? assets
          : assets.filter((asset) => asset.createdAt < cursor.at || (asset.createdAt === cursor.at && asset.id < cursor.id));
        return after.slice(0, limit);
      },
      async deleteMediaAsset({ id }: { id: string }) {
        calls.push(`delete:${id}`);
        return assets.find((asset) => asset.id === id) ?? null;
      },
      async listArticleContentForMediaScan() { return scanRows; },
    },
  };
}

function storageSpy(fail = false) {
  const deleted: string[] = [];
  return {
    deleted,
    storage: {
      async putObject() { throw new Error("not used"); },
      async getObject() { return Buffer.alloc(0); },
      async deleteObject(key: string) {
        if (fail) throw new Error("bucket unreachable");
        deleted.push(key);
      },
      close() {},
    },
  };
}

test("the reference scan finds an image in a draft, a published work and a tombstone", () => {
  const id = "abcdef01-2345-4678-89ab-cdef01234567";
  const references = extractMediaReferences([
    { articleId: "a1", slug: "draft", status: "draft", deletedAt: null, locale: "zh-CN", title: "草稿", contentBlocks: JSON.stringify([{ type: "image", src: `/api/media/${id}` }]) },
    { articleId: "a2", slug: "live", status: "published", deletedAt: null, locale: "en", title: "Live", contentBlocks: JSON.stringify([{ src: `/api/media/${id.toUpperCase()}` }]) },
    { articleId: "a3", slug: "gone", status: "draft", deletedAt: "2026-11-01T00:00:00.000Z", locale: "zh-CN", title: "墓碑", contentBlocks: `[{"src":"/api/media/${id}"}]` },
    { articleId: "a4", slug: "none", status: "published", deletedAt: null, locale: "zh-CN", title: "没有图", contentBlocks: '[{"type":"paragraph","text":"nothing here"}]' },
  ]);
  const found = references.get(id) ?? [];
  assert.equal(found.length, 3, "the draft, the published work and the restorable tombstone all count");
  assert.deepEqual(found.map((entry) => entry.state), ["draft", "published", "deleted"]);
  assert.ok(references.has(id), "an upper-case id in the body matches the lower-case asset id");
  assert.equal(references.get("00000000-0000-4000-8000-000000000000"), undefined);
});

test("a work that uses the same image twice is reported once", () => {
  const id = "abcdef01-2345-4678-89ab-cdef01234567";
  const references = extractMediaReferences([
    { articleId: "a1", slug: "twice", status: "published", deletedAt: null, locale: "zh-CN", title: "两次", contentBlocks: `[{"src":"/api/media/${id}"},{"src":"/api/media/${id}"}]` },
  ]);
  assert.equal((references.get(id) ?? []).length, 1);
});

test("unparseable scan rows are skipped rather than crashing the library", () => {
  const references = extractMediaReferences([
    null,
    { contentBlocks: "[{" },
    { articleId: "a1", slug: "x", status: "published", deletedAt: null, locale: "zh-CN", title: "X", contentBlocks: undefined },
  ]);
  assert.equal(references.size, 0);
});

test("the library is newest first, one page at a time, and marks what nothing uses", async () => {
  const used = assetAt(1).id;
  const { store, calls } = libraryStore([assetAt(1), assetAt(2), assetAt(3)], [
    { articleId: "a1", slug: "uses-it", status: "published", deletedAt: null, locale: "zh-CN", title: "用了这张", contentBlocks: `[{"src":"/api/media/${used}"}]` },
  ]);
  const service = createMediaAssetService({ store, storage: storageSpy().storage });
  const first = await service.listLibrary({ ownerId: OWNER, limit: 2 });
  assert.deepEqual(first.items.map((item) => item.id), [assetAt(1).id, assetAt(2).id]);
  assert.equal(first.items[0]!.orphan, false, "the first asset is in a work");
  assert.equal(first.items[0]!.referencedBy.length, 1);
  assert.equal(first.items[0]!.referencedBy[0]!.slug, "uses-it");
  assert.equal(first.items[1]!.orphan, true, "nothing points at the second");
  assert.ok(first.nextCursor, "a full page has a next cursor");
  assert.ok(calls.includes(`list:${2 + 1}`), "one extra row is read to detect the next page");

  const second = await service.listLibrary({ ownerId: OWNER, cursor: first.nextCursor, limit: 2 });
  assert.deepEqual(second.items.map((item) => item.id), [assetAt(3).id]);
  assert.equal(second.nextCursor, null, "a short page is the end");
});

test("a library read rejects a bad limit and a bad cursor instead of guessing", async () => {
  const { store } = libraryStore([assetAt(1)]);
  const service = createMediaAssetService({ store, storage: storageSpy().storage });
  await assert.rejects(service.listLibrary({ ownerId: OWNER, limit: 0 }), MediaInputError);
  await assert.rejects(service.listLibrary({ ownerId: OWNER, limit: 61 }), MediaInputError);
  await assert.rejects(service.listLibrary({ ownerId: OWNER, limit: 2.5 }), MediaInputError);
  await assert.rejects(service.listLibrary({ ownerId: OWNER, cursor: "not-a-cursor" }), MediaInputError);
  await assert.rejects(service.listLibrary({ ownerId: "not-a-user" }), MediaInputError);
  // The default page size is the documented one, not whatever the caller sent.
  const page = await service.listLibrary({ ownerId: OWNER });
  assert.equal(page.items.length, 1);
  assert.ok(page.items[0]!.createdAt.startsWith("2026-10-"));
});

test("an unused asset is deleted object first, then row", async () => {
  const target = assetAt(1);
  const { store, calls } = libraryStore([target]);
  const { storage, deleted } = storageSpy();
  const service = createMediaAssetService({ store, storage });
  assert.deepEqual(await service.deleteAsset({ ownerId: OWNER, id: target.id }), { id: target.id });
  assert.deepEqual(deleted, [target.storageKey]);
  assert.deepEqual(calls, [`delete:${target.id}`], "the row goes only after the object is gone");
});

test("an asset still used by a work is refused with the works that use it", async () => {
  const target = assetAt(1);
  const scanRow = {
    articleId: "a1", slug: "uses-it", status: "draft", deletedAt: null, locale: "zh-CN", title: "草稿用了它",
    contentBlocks: `[{"src":"/api/media/${target.id}"}]`,
  };
  const { store, calls } = libraryStore([target], [scanRow]);
  const { storage, deleted } = storageSpy();
  const service = createMediaAssetService({ store, storage });
  const error = await service.deleteAsset({ ownerId: OWNER, id: target.id }).then(
    () => null,
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof MediaAssetInUseError, "the refusal is a 409, not a silent success");
  assert.equal(error.referencedBy.length, 1);
  assert.equal(error.referencedBy[0]!.slug, "uses-it");
  assert.deepEqual(deleted, [], "nothing is deleted when the answer is no");
  assert.deepEqual(calls, [], "the row is not touched either");
});

test("another author's asset cannot be deleted, and neither can a missing one", async () => {
  const target = assetAt(1);
  const { store } = libraryStore([{ ...target, ownerId: OTHER }]);
  const { storage, deleted } = storageSpy();
  const service = createMediaAssetService({ store, storage });
  await assert.rejects(service.deleteAsset({ ownerId: OWNER, id: target.id }), MediaAssetNotFoundError);
  await assert.rejects(service.deleteAsset({ ownerId: OWNER, id: "00000000-0000-4000-8000-000000000000" }), MediaAssetNotFoundError);
  assert.deepEqual(deleted, []);
});

test("an unreachable bucket leaves the row in place rather than a work pointing at nothing", async () => {
  const target = assetAt(1);
  const { store, calls } = libraryStore([target]);
  const { storage } = storageSpy(true);
  const service = createMediaAssetService({ store, storage });
  const error = await service.deleteAsset({ ownerId: OWNER, id: target.id }).then(
    () => null,
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof MediaStorageUnavailableError);
  assert.deepEqual(calls, [], "the metadata survives: a leaked object is invisible, a missing one is not");
});
