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
  referencesForOwner,
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
    async deleteUnusedMediaAsset() { return null; },
    async listMediaScanRows() { return []; },
    async listMediaRefs() { return []; },
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
    async deleteUnusedMediaAsset() { return null; },
    async listMediaScanRows() { return []; },
    async listMediaRefs() { return []; },
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

/**
 * A store whose list is `assets` and whose scan is `scanRows`.
 *
 * Its guarded delete behaves the way both providers do: the scan and the delete
 * are one operation, so a row that appears in the scan *between* what the
 * library page showed and what the delete asks about is found by the delete.
 */
function libraryStore(assets: ReturnType<typeof assetAt>[], scanRows: unknown[] = []) {
  const calls: string[] = [];
  const rows = () => scanRows as { kind?: string; content?: unknown }[];
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
      async deleteUnusedMediaAsset({ id, ownerId }: { id: string; ownerId: string }) {
        calls.push(`delete:${id}`);
        const asset = assets.find((entry) => entry.id === id);
        if (!asset || asset.ownerId !== ownerId) return null;
        const needle = `/media/${id.toLowerCase()}`;
        const usedBy = (await this.listMediaScanRows()).filter((row) => String(row?.content ?? "").toLowerCase().includes(needle));
        if (usedBy.length > 0) return { deleted: null, usedBy };
        return { deleted: asset, usedBy: [] };
      },
      async listMediaScanRows() { return rows(); },
      /**
       * The materialized answer (issue #163): who uses this page's assets.
       *
       * The fake derives it from the same `scanRows` fixture, because the point of
       * a fake is to agree with the rule, not to reimplement the table.
       */
      async listMediaRefs({ assetIds }: { assetIds: string[] }) {
        calls.push(`refs:${assetIds.length}`);
        return rows().filter((row) => assetIds.some((id) => String(row?.content ?? "").toLowerCase().includes(`/media/${id.toLowerCase()}`)));
      },
    },
  };
}

/**
 * One work's body, in the shape the scan returns.
 *
 * `authorId` is the part that matters for the privacy rules: the library has to
 * be able to tell "this reader's own draft" from "somebody else's".
 */
function workRow(
  work: { articleId: string; slug?: string; status?: string; deletedAt?: string | null; locale?: string; title?: string; authorId?: string },
  ...sources: string[]
) {
  return {
    kind: "work" as const,
    content: JSON.stringify(sources.map((src) => ({ id: "block", type: "image", src, alt: "" }))),
    work: {
      articleId: work.articleId,
      slug: work.slug ?? "a-work",
      status: work.status ?? "published",
      deletedAt: work.deletedAt ?? null,
      locale: work.locale ?? "zh-CN",
      title: work.title ?? "一篇作品",
      authorId: work.authorId ?? OWNER,
    },
  };
}

/** A profile picture: a media URL that lives outside any body. */
const avatarRow = (url: string) => ({ kind: "avatar" as const, content: url });

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
    workRow({ articleId: "a1", slug: "draft", status: "draft", title: "草稿" }, `/api/media/${id}`),
    workRow({ articleId: "a2", slug: "live", status: "published", locale: "en", title: "Live" }, `/api/media/${id.toUpperCase()}`),
    workRow({ articleId: "a3", slug: "gone", status: "draft", deletedAt: "2026-11-01T00:00:00.000Z", title: "墓碑" }, `/api/media/${id}`),
    workRow({ articleId: "a4", slug: "none", status: "published", title: "没有图" }),
  ]);
  const found = references.get(id) ?? [];
  assert.equal(found.length, 3, "the draft, the published work and the restorable tombstone all count");
  assert.deepEqual(
    found.map((entry) => (entry.kind === "work" ? entry.state : "avatar")),
    ["draft", "published", "deleted"],
  );
  assert.ok(references.has(id), "an upper-case id in the body matches the lower-case asset id");
  assert.equal(references.get("00000000-0000-4000-8000-000000000000"), undefined);
});

/**
 * The address a client that talks to the API directly stores.
 *
 * The Web app serves `/api/media/<id>` and relays it; the API's own route is
 * `/api/v1/media/<id>`, which is what the Flutter app writes into a body. A scan
 * that matched only the Web form read every one of those covers as "no work uses
 * this" — and offered to delete it.
 */
test("an image stored under the API's own /api/v1/media/… address is a reference", () => {
  const id = "abcdef01-2345-4678-89ab-cdef01234567";
  for (const src of [`/api/v1/media/${id}`, `https://api.example.test/api/v1/media/${id}`, `/api/media/${id}`]) {
    const references = extractMediaReferences([workRow({ articleId: "a1", slug: "cover", title: "封面" }, src)]);
    assert.equal((references.get(id) ?? []).length, 1, `${src} is a reference, not an orphan`);
  }
});

/**
 * A profile picture lives on the profile, in no body at all.
 *
 * It is the case the scan missed entirely: avatars and covers saved before the
 * library existed were the first things it offered to delete.
 */
test("a profile picture is a reference, like a cover image is", () => {
  const id = "abcdef01-2345-4678-89ab-cdef01234567";
  const references = extractMediaReferences([avatarRow(`/api/v1/media/${id}`)]);
  const found = references.get(id) ?? [];
  assert.equal(found.length, 1, "an avatar in use is not an orphan");
  assert.equal(found[0]!.kind, "avatar");
});

test("a work that uses the same image twice is reported once", () => {
  const id = "abcdef01-2345-4678-89ab-cdef01234567";
  const references = extractMediaReferences([
    workRow({ articleId: "a1", slug: "twice", title: "两次" }, `/api/media/${id}`, `/api/media/${id}`),
  ]);
  assert.equal((references.get(id) ?? []).length, 1);
});

test("unparseable scan rows are skipped rather than crashing the library", () => {
  const id = "abcdef01-2345-4678-89ab-cdef01234567";
  const references = extractMediaReferences([
    null,
    { content: "[{" },
    { kind: "work", content: undefined },
    { kind: "avatar", content: null },
    { kind: "work", content: `/api/media/${id}` },
    { kind: "something-new", content: `/api/media/${id}` },
  ]);
  assert.equal(references.size, 0, "a row the scan does not understand is not counted as a reference");
});

/**
 * Whose words they are.
 *
 * The asset owner has to be told the image is in use — that is what stops them
 * deleting it — but the title of somebody else's unpublished work is not theirs
 * to read, and a list response would publish it to whoever happens to own the
 * bytes. A published work is public, and a reader's own draft is theirs, so both
 * are named.
 */
test("another author's unpublished work counts as a reference without being named", () => {
  const id = "abcdef01-2345-4678-89ab-cdef01234567";
  const scan = extractMediaReferences([
    workRow({ articleId: "a1", slug: "theirs", status: "draft", title: "别人的私密草稿", authorId: OTHER }, `/api/media/${id}`),
    workRow({ articleId: "a2", slug: "mine", status: "draft", title: "我自己的草稿", authorId: OWNER }, `/api/media/${id}`),
    workRow({ articleId: "a3", slug: "public", status: "published", title: "已发表", authorId: OTHER }, `/api/media/${id}`),
    avatarRow(`/api/media/${id}`),
  ]);
  const shown = referencesForOwner(scan, id, OWNER);
  assert.equal(shown.length, 4, "every reference still counts, named or not");
  const [theirs, mine, published, avatar] = shown;
  assert.deepEqual(theirs, { kind: "work", articleId: "", slug: "", title: "", locale: "", state: "draft", redacted: true });
  assert.equal(mine?.kind === "work" && mine.redacted, false, "a reader's own draft is theirs to see");
  assert.equal(mine?.kind === "work" && mine.title, "我自己的草稿");
  assert.equal(published?.kind === "work" && published.redacted, false, "a published work is public");
  assert.equal(published?.kind === "work" && published.title, "已发表");
  assert.equal(avatar?.kind, "avatar");
  assert.equal(JSON.stringify(shown).includes("别人的私密草稿"), false, "the title of the other author's draft is not in the answer");
});

test("the library is newest first, one page at a time, and marks what nothing uses", async () => {
  const used = assetAt(1).id;
  const { store, calls } = libraryStore([assetAt(1), assetAt(2), assetAt(3)], [
    workRow({ articleId: "a1", slug: "uses-it", status: "published", title: "用了这张" }, `/api/media/${used}`),
  ]);
  const service = createMediaAssetService({ store, storage: storageSpy().storage });
  const first = await service.listLibrary({ ownerId: OWNER, limit: 2 });
  assert.deepEqual(first.items.map((item) => item.id), [assetAt(1).id, assetAt(2).id]);
  assert.equal(first.items[0]!.orphan, false, "the first asset is in a work");
  assert.equal(first.items[0]!.referencedBy.length, 1);
  assert.equal(first.items[0]!.referencedBy[0]!.slug, "uses-it");
  assert.equal(first.items[1]!.orphan, true, "nothing points at the second");
  assert.equal(first.items[0]!.referencedBy[0]!.kind, "work");
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

test("an unused asset is deleted row first, then object", async () => {
  const target = assetAt(1);
  const { store, calls } = libraryStore([target]);
  const { storage, deleted } = storageSpy();
  const service = createMediaAssetService({ store, storage });
  const result = await service.deleteAsset({ ownerId: OWNER, id: target.id });
  assert.equal(result.id, target.id);
  assert.equal(result.objectDeleted, true);
  assert.deepEqual(deleted, [target.storageKey]);

});

/**
 * The race that made a delete dangerous.
 *
 * The library page said "unused". Before the button was pressed, a work was saved
 * with the image in it. A check-then-delete in the application layer cannot see
 * that: the two statements have a gap between them and the save lands in it. The
 * provider's guarded delete scans and deletes in one operation, so the save is
 * found however late it arrives.
 */
test("a work saved after the page was rendered still blocks the delete", async () => {
  const target = assetAt(1);
  const { store, calls } = libraryStore([target], []);
  const { storage, deleted } = storageSpy();
  // The save that lands in the gap: by the time the delete looks, the work is there.
  store.listMediaScanRows = async () => [
    workRow({ articleId: "a1", slug: "saved-just-now", status: "draft", title: "刚刚保存" }, `/api/v1/media/${target.id}`),
  ];
  const service = createMediaAssetService({ store, storage });
  const error = await service.deleteAsset({ ownerId: OWNER, id: target.id }).then(
    () => null,
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof MediaAssetInUseError, "the delete is refused, not raced through");
  assert.equal(error.referencedBy.length, 1);
  assert.deepEqual(deleted, [], "no object is touched");
  assert.deepEqual(calls, [`delete:${target.id}`], "the guarded delete is what said no — one call, one answer");
});

test("an asset still used by a work is refused with the works that use it", async () => {
  const target = assetAt(1);
  const scanRow = workRow({ articleId: "a1", slug: "uses-it", status: "draft", title: "草稿用了它" }, `/api/media/${target.id}`);
  const { store, calls } = libraryStore([target], [scanRow]);
  const { storage, deleted } = storageSpy();
  const service = createMediaAssetService({ store, storage });
  const error = await service.deleteAsset({ ownerId: OWNER, id: target.id }).then(
    () => null,
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof MediaAssetInUseError, "the refusal is a 409, not a silent success");
  assert.equal(error.referencedBy.length, 1);
  assert.equal(error.referencedBy[0]!.kind === "work" && error.referencedBy[0]!.slug, "uses-it");
  assert.deepEqual(deleted, [], "nothing is deleted when the answer is no");
});

/**
 * The one the security report is about: the refusal has to say *that* the image
 * is in use without saying whose draft it is.
 */
test("a delete refused by another author's draft does not name that draft", async () => {
  const target = assetAt(1);
  const { store } = libraryStore([target], [
    workRow({ articleId: "a1", slug: "theirs", status: "draft", title: "别人的私密草稿", authorId: OTHER }, `/api/media/${target.id}`),
  ]);
  const { storage, deleted } = storageSpy();
  const service = createMediaAssetService({ store, storage });
  const error = await service.deleteAsset({ ownerId: OWNER, id: target.id }).then(
    () => null,
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof MediaAssetInUseError);
  assert.equal(error.referencedBy.length, 1, "it still counts: the image is in use");
  assert.equal(error.referencedBy[0]!.kind === "work" && error.referencedBy[0]!.redacted, true);
  assert.equal(JSON.stringify(error.referencedBy).includes("别人的私密草稿"), false, "and it is not named");
  assert.deepEqual(deleted, []);
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

/**
 * The failure that is not the reader's problem.
 *
 * Once the guarded delete has committed, nothing can be referencing the row, so
 * an unreachable bucket can only leave invisible bytes — never a work pointing at
 * bytes that are gone. Storing the row back would be the wrong kind of honest:
 * the delete happened, and what is left is a bill for whoever runs the bucket.
 */
test("an unreachable bucket leaves the bytes behind, named, but never a work pointing at nothing", async () => {
  const target = assetAt(1);
  const { store, calls } = libraryStore([target]);
  const { storage } = storageSpy(true);
  const service = createMediaAssetService({ store, storage });
  const result = await service.deleteAsset({ ownerId: OWNER, id: target.id });
  assert.equal(result.id, target.id);
  assert.equal(result.objectDeleted, false);
  assert.equal(result.orphanedStorageKey, target.storageKey, "the leftovers can be reclaimed");
  assert.deepEqual(calls, [`delete:${target.id}`], "the row is gone: no work can be left pointing at it");
});

/**
 * The cost of a library page (issue #163).
 *
 * The library used to answer "is this image used?" by reading every work's body
 * into memory — every author, every state, every locale — to decide about the
 * twenty-four images in front of one author. The materialized reference table
 * makes the question a lookup, and this is the assertion that keeps it that way:
 * a page must ask about its own assets and nothing else.
 *
 * It is written against the *calls*, not a timer, because a timing assertion
 * passes on a fast machine with a bad query and fails on a loaded one with a good
 * one. What the page is allowed to do is the contract; how long it takes follows.
 */
test("a library page asks the reference table about its own page, never about the whole platform", async () => {
  const assets = [assetAt(1), assetAt(2), assetAt(3)];
  const { store, calls } = libraryStore(assets, [
    workRow({ articleId: "a1", slug: "uses-first", status: "published", title: "用了第一张" }, `/api/media/${assets[0]!.id}`),
    // A reference to an image on *another* author's page: it must not be read,
    // because nothing on this page asks about it.
    workRow({ articleId: "a2", slug: "unrelated", status: "draft", title: "别的页面", authorId: OTHER }, `/api/media/${"77777777-7777-4777-8777-777777777777"}`),
  ]);
  const scanned: string[] = [];
  store.listMediaScanRows = async () => { scanned.push("full-scan"); return []; };
  const { storage } = storageSpy();
  const service = createMediaAssetService({ store, storage });

  const page = await service.listLibrary({ ownerId: OWNER, limit: 3 });
  assert.equal(page.items.length, 3);
  assert.deepEqual(calls.filter((call) => call.startsWith("refs:")), ["refs:3"], "one reference query, sized to the page");
  assert.deepEqual(scanned, [], "the library never reads every work's body");

  const byId = new Map(page.items.map((item) => [item.id, item]));
  assert.equal(byId.get(assets[0]!.id)!.orphan, false, "the used image is not offered for deletion");
  assert.equal(byId.get(assets[1]!.id)!.orphan, true);
  assert.equal(byId.get(assets[2]!.id)!.orphan, true);
  // The unrelated work is on nobody's page, and its draft title is not in the
  // payload of this one.
  assert.equal(JSON.stringify(page.items).includes("别的页面"), false);
});

test("a library page with no assets asks nothing at all", async () => {
  const { store, calls } = libraryStore([], []);
  const { storage } = storageSpy();
  const service = createMediaAssetService({ store, storage });
  const page = await service.listLibrary({ ownerId: OWNER });
  assert.deepEqual(page.items, []);
  assert.deepEqual(calls, ["list:25"], "one query for the page, and that is the whole read");
});
