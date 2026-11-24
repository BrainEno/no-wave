/** Media upload, public delivery, the media library and deletion guards. Split from server.test.ts (#357). */
import assert from "node:assert/strict";
import test from "node:test";
import { MediaAssetInUseError, MediaAssetNotFoundError } from "./application/media-assets.ts";
import { authEnv, signedToken, withServer } from "./test-support/rest-server-harness.ts";



test("media upload route requires authentication and passes bounded binary data to the media service", async () => {
  const calls: Array<{ ownerId: string; contentType: string; bytes: Buffer }> = [];
  const assetId = "11111111-1111-4111-8111-111111111111";
  const mediaAssets = {
    async upload(input) {
      calls.push({ ownerId: input.ownerId, contentType: input.contentType, bytes: input.bytes });
      return { id: assetId, src: "/api/media/" + assetId, contentType: "image/webp", byteSize: 12, width: 10, height: 8 };
    },
    async getPublic() { throw new Error("unused"); },
  };
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  await withServer(async (baseUrl) => {
    const unauthenticated = await fetch(baseUrl + "/api/v1/me/media", {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: bytes,
    });
    assert.equal(unauthenticated.status, 401);

    const response = await fetch(baseUrl + "/api/v1/me/media", {
      method: "POST",
      headers: { authorization: "Bearer " + signedToken("media-writer"), "content-type": "image/png" },
      body: bytes,
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { data: { id: assetId, src: "/api/media/" + assetId, contentType: "image/webp", byteSize: 12, width: 10, height: 8 } });

    const unsupported = await fetch(baseUrl + "/api/v1/me/media", {
      method: "POST",
      headers: { authorization: "Bearer " + signedToken("media-writer"), "content-type": "image/svg+xml" },
      body: "<svg/>",
    });
    assert.equal(unsupported.status, 415);
  }, { env: authEnv, store: {}, mediaAssets });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].ownerId, "media-writer");
  assert.equal(calls[0].contentType, "image/png");
  assert.deepEqual(calls[0].bytes, bytes);
});

test("public media route emits an immutable WebP response and supports conditional requests", async () => {
  const assetId = "11111111-1111-4111-8111-111111111111";
  const bytes = Buffer.from("RIFF-test-webp");
  const sha256 = "a".repeat(64);
  let calls = 0;
  const mediaAssets = {
    async upload() { throw new Error("unused"); },
    async getPublic({ id }) {
      calls += 1;
      assert.equal(id, assetId);
      return { id, bytes, byteSize: bytes.byteLength, width: 10, height: 8, sha256, contentType: "image/webp" as const };
    },
  };
  await withServer(async (baseUrl) => {
    const url = baseUrl + "/api/v1/media/" + assetId;
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/webp");
    assert.match(response.headers.get("cache-control") ?? "", /immutable/);
    assert.equal(response.headers.get("etag"), '"' + sha256 + '"');
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);

    const cached = await fetch(url, { headers: { "if-none-match": '"' + sha256 + '"' } });
    assert.equal(cached.status, 304);
    assert.equal(cached.headers.get("etag"), '"' + sha256 + '"');
  }, { mediaAssets });
  assert.equal(calls, 2);
});

/**
 * The media library, at the transport boundary (ADR 0022).
 *
 * What a client can observe: the list is the author's own and paginated, an
 * asset still used by a work is refused with the works that use it, an id that
 * is not that author's is simply not found, and a deployment without object
 * storage says so instead of showing an empty library.
 */
test("the media library lists one author's uploads, newest first, and only theirs", async () => {
  const assetId = "11111111-1111-4111-8111-111111111111";
  const calls: Array<Record<string, unknown>> = [];
  const mediaAssets = {
    async upload() { throw new Error("unused"); },
    async getPublic() { throw new Error("unused"); },
    async listLibrary(input) {
      calls.push({ ...input });
      return {
        items: [{
          id: assetId, src: "/api/media/" + assetId, contentType: "image/webp", byteSize: 2048,
          width: 20, height: 10, createdAt: "2026-10-30T00:00:00.000Z", orphan: true, referencedBy: [],
        }],
        nextCursor: null,
      };
    },
    async deleteAsset() { throw new Error("unused"); },
  };
  await withServer(async (baseUrl) => {
    const unauthenticated = await fetch(baseUrl + "/api/v1/me/media");
    assert.equal(unauthenticated.status, 401);
    await unauthenticated.text();

    const response = await fetch(baseUrl + "/api/v1/me/media?limit=12", {
      headers: { authorization: "Bearer " + signedToken("media-writer") },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
    const body = await response.json();
    assert.equal(body.data.items.length, 1);
    assert.equal(body.data.items[0].orphan, true);
    assert.equal(body.data.nextCursor, null);

    // The owner is the token, never the query string.
    assert.deepEqual(calls, [{ ownerId: "media-writer", cursor: null, limit: 12 }]);

    const fractional = await fetch(baseUrl + "/api/v1/me/media?limit=2.5", {
      headers: { authorization: "Bearer " + signedToken("media-writer") },
    });
    assert.equal(fractional.status, 400);
    await fractional.text();

    const repeated = await fetch(baseUrl + "/api/v1/me/media?limit=12&limit=13", {
      headers: { authorization: "Bearer " + signedToken("media-writer") },
    });
    assert.equal(repeated.status, 400, "a repeated parameter is rejected, not silently read as the first");

    const wrongMethod = await fetch(baseUrl + "/api/v1/me/media", {
      method: "PUT",
      headers: { authorization: "Bearer " + signedToken("media-writer") },
    });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "GET, POST");
  }, { env: authEnv, store: {}, mediaAssets });
});

/**
 * The deployment switch (#156).
 *
 * Deleting an image is off unless an operator turns it on, because the reference
 * check and the delete are not serialised against a concurrent save on
 * PostgreSQL — a work saved in that window loses its images for good. Hiding the
 * button in the Web app does not help: a Flutter build, or curl, talks to the
 * same route.
 *
 * So the route itself has to refuse, and it has to refuse in the right order:
 * authentication first (an anonymous caller learns 401, not how the instance is
 * configured), then the switch, then — only if both pass — the expensive scan.
 */
test("media deletion is refused by default, before the reference scan runs", async () => {
  const assetId = "11111111-1111-4111-8111-111111111111";
  const calls: Array<Record<string, unknown>> = [];
  const mediaAssets = {
    async upload() { throw new Error("unused"); },
    async getPublic() { throw new Error("unused"); },
    async listLibrary() { return { items: [], nextCursor: null }; },
    async deleteAsset(input) { calls.push({ ...input }); return { id: input.id, objectDeleted: true }; },
  };
  // authEnv turns the switch on for the other tests; this one removes it, which
  // is exactly the configuration a stock deployment has.
  const { MEDIA_DELETE_ENABLED: _omitted, ...offByDefault } = authEnv;
  await withServer(async (baseUrl) => {
    // Anonymous first: the refusal must not describe the deployment to someone
    // who has not proved who they are.
    const anonymous = await fetch(baseUrl + "/api/v1/me/media/" + assetId, { method: "DELETE" });
    assert.equal(anonymous.status, 401);
    await anonymous.text();

    const response = await fetch(baseUrl + "/api/v1/me/media/" + assetId, {
      method: "DELETE",
      headers: { authorization: "Bearer " + signedToken("media-writer") },
    });
    assert.equal(response.status, 409, "a decision, not an outage: 409, never 503");
    assert.deepEqual(await response.json(), {
      error: { code: "MEDIA_DELETE_DISABLED", message: "Deleting images is not enabled on this instance." },
    });
    // Nothing was scanned and nothing was deleted. A refused request must also
    // be an unexpensive one: the scan reads every work's body.
    assert.deepEqual(calls, [], "the asset service must not be reached at all");

    // Reading the library and an individual asset stays available: the switch
    // governs deletion, not the whole media feature.
    const library = await fetch(baseUrl + "/api/v1/me/media", {
      headers: { authorization: "Bearer " + signedToken("media-writer") },
    });
    assert.equal(library.status, 200, "listing is unaffected");
  }, { env: offByDefault, store: {}, mediaAssets });
});

test("media deletion runs when the switch is on", async () => {
  const assetId = "11111111-1111-4111-8111-111111111111";
  const calls: Array<Record<string, unknown>> = [];
  const mediaAssets = {
    async upload() { throw new Error("unused"); },
    async getPublic() { throw new Error("unused"); },
    async listLibrary() { return { items: [], nextCursor: null }; },
    async deleteAsset(input) { calls.push({ ...input }); return { id: input.id, objectDeleted: true }; },
  };
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/v1/me/media/" + assetId, {
      method: "DELETE",
      headers: { authorization: "Bearer " + signedToken("media-writer") },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { id: assetId } });
    assert.deepEqual(calls, [{ ownerId: "media-writer", id: assetId }], "the owner is the authenticated caller, never a body field");
  }, { env: authEnv, store: {}, mediaAssets });
});

test("only an explicit word switches media deletion on", async () => {
  const assetId = "11111111-1111-4111-8111-111111111111";
  const makeMediaAssets = (onDelete) => ({
    async upload() { throw new Error("unused"); },
    async getPublic() { throw new Error("unused"); },
    async listLibrary() { return { items: [], nextCursor: null }; },
    async deleteAsset(input) { return { id: input.id, objectDeleted: true }; },
  });
  const statusFor = async (value) => {
    const { MEDIA_DELETE_ENABLED: _ignored, ...rest } = authEnv;
    const env = value === undefined ? rest : { ...rest, MEDIA_DELETE_ENABLED: value };
    let status;
    await withServer(async (baseUrl) => {
      const response = await fetch(baseUrl + "/api/v1/me/media/" + assetId, {
        method: "DELETE",
        headers: { authorization: "Bearer " + signedToken("media-writer") },
      });
      status = response.status;
      await response.text();
    }, { env, store: {}, mediaAssets: makeMediaAssets() });
    return status;
  };
  // Accepting the same affirmative spellings as MAIL_ENABLED keeps one
  // convention for deployment switches in this codebase.
  for (const on of ["true", "TRUE", "1", "yes", "on", "  true  "]) {
    assert.equal(await statusFor(on), 200, `"${on}" must switch deletion on`);
  }
  // Everything else is off. A typo must never be able to destroy data, so the
  // unrecognised case is not "probably fine" — it is refused.
  for (const off of ["false", "0", "no", "off", "", "   ", "ture", "trueee", "enabled"]) {
    assert.equal(await statusFor(off), 409, `"${off}" must leave deletion off`);
  }
  assert.equal(await statusFor(undefined), 409, "unset means off");
});

test("deleting an asset is refused while a work uses it, and answers 404 for anything else", async () => {
  const assetId = "11111111-1111-4111-8111-111111111111";
  const calls: Array<Record<string, unknown>> = [];
  const inUse = {
    async upload() { throw new Error("unused"); },
    async getPublic() { throw new Error("unused"); },
    async listLibrary() { return { items: [], nextCursor: null }; },
    async deleteAsset(input) {
      calls.push({ ...input });
      throw new MediaAssetInUseError([
        { kind: "work", articleId: "a1", slug: "uses-it", title: "用了它", locale: "zh-CN", state: "draft", redacted: false },
      ]);
    },
  };
  await withServer(async (baseUrl) => {
    const unauthenticated = await fetch(baseUrl + "/api/v1/me/media/" + assetId, { method: "DELETE" });
    assert.equal(unauthenticated.status, 401);
    await unauthenticated.text();

    const response = await fetch(baseUrl + "/api/v1/me/media/" + assetId, {
      method: "DELETE",
      headers: { authorization: "Bearer " + signedToken("media-writer") },
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error.code, "MEDIA_IN_USE");
    // The refusal carries the works, so the page can say why instead of just no.
    assert.deepEqual(body.error.details.referencedBy.map((entry) => entry.slug), ["uses-it"]);
    assert.equal(body.error.details.referencedBy[0].redacted, false, "this one the reader is allowed to see");
  }, { env: authEnv, store: {}, mediaAssets: inUse });

  const notFound = {
    async upload() { throw new Error("unused"); },
    async getPublic() { throw new Error("unused"); },
    async listLibrary() { return { items: [], nextCursor: null }; },
    async deleteAsset() { throw new MediaAssetNotFoundError(); },
  };
  await withServer(async (baseUrl) => {
    // "Not yours" and "not a media id at all" are the same answer, so the
    // endpoint cannot be used to find out which assets exist.
    const response = await fetch(baseUrl + "/api/v1/me/media/not-a-uuid", {
      method: "DELETE",
      headers: { authorization: "Bearer " + signedToken("media-writer") },
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: { code: "NOT_FOUND", message: "The requested media asset was not found." },
    });

    const wrongMethod = await fetch(baseUrl + "/api/v1/me/media/" + assetId, {
      headers: { authorization: "Bearer " + signedToken("media-writer") },
    });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "DELETE");
  }, { env: authEnv, store: {}, mediaAssets: notFound });
});

/**
 * The refusal has to stay a refusal when the use it names is not the reader's to
 * read.
 *
 * An image can sit in another author's unpublished draft. The delete is blocked —
 * that is the whole point — but the 409 body is built from the scan, and a body
 * that named the draft would publish its title to whoever owns the bytes. What
 * goes out instead is the count and the state: enough to explain the refusal,
 * nothing of the words.
 */
test("a delete refused by another author's draft says so without naming the draft", async () => {
  const assetId = "11111111-1111-4111-8111-111111111111";
  const mediaAssets = {
    async upload() { throw new Error("unused"); },
    async getPublic() { throw new Error("unused"); },
    async listLibrary() { return { items: [], nextCursor: null }; },
    async deleteAsset() {
      throw new MediaAssetInUseError([
        { kind: "work", articleId: "", slug: "", title: "", locale: "", state: "draft", redacted: true },
        { kind: "avatar" },
      ]);
    },
  };
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/v1/me/media/" + assetId, {
      method: "DELETE",
      headers: { authorization: "Bearer " + signedToken("media-writer") },
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error.code, "MEDIA_IN_USE");
    assert.equal(body.error.details.referencedBy.length, 2, "both uses still count");
    assert.equal(body.error.details.referencedBy[0].redacted, true);
    assert.equal(body.error.details.referencedBy[1].kind, "avatar");
  }, { env: authEnv, store: {}, mediaAssets });
});

/**
 * The delete that half-succeeded.
 *
 * Once the row is gone nothing can be referencing it, so a bucket that cannot be
 * reached leaves bytes with no name attached to them — a bill, not a broken work.
 * The reader asked for one deletion and got it; the leftover is for whoever runs
 * the bucket, which is what the log line is for.
 */
test("a delete whose object cannot be removed still answers 200, and says what is left behind", async () => {
  const assetId = "11111111-1111-4111-8111-111111111111";
  const storageKey = "assets/media-writer/left-behind.webp";
  const mediaAssets = {
    async upload() { throw new Error("unused"); },
    async getPublic() { throw new Error("unused"); },
    async listLibrary() { return { items: [], nextCursor: null }; },
    async deleteAsset() { return { id: assetId, objectDeleted: false, orphanedStorageKey: storageKey }; },
  };
  // The log is the only trace of the leftover, so it is part of the contract.
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  (process.stderr as { write: typeof process.stderr.write }).write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(baseUrl + "/api/v1/me/media/" + assetId, {
        method: "DELETE",
        headers: { authorization: "Bearer " + signedToken("media-writer") },
      });
      assert.equal(response.status, 200, "the row is gone: the deletion the reader asked for happened");
      assert.deepEqual(await response.json(), { data: { id: assetId } });
      const entry = captured.split("\n").filter(Boolean).map((line) => JSON.parse(line))
        .find((record) => record.event === "media.object_orphaned");
      assert.ok(entry, "the leftover is logged for whoever pays for the bucket");
      assert.equal(entry.level, "warn");
      assert.equal(entry.storageKey, storageKey);
      assert.equal(entry.mediaId, assetId);
    }, { env: authEnv, store: {}, mediaAssets });
  } finally {
    (process.stderr as { write: typeof process.stderr.write }).write = original;
  }
});

test("a deployment without object storage says so instead of showing an empty library", async () => {
  await withServer(async (baseUrl) => {
    const list = await fetch(baseUrl + "/api/v1/me/media", {
      headers: { authorization: "Bearer " + signedToken("media-writer") },
    });
    assert.equal(list.status, 503);
    assert.equal((await list.json()).error.code, "MEDIA_STORAGE_UNAVAILABLE");

    const remove = await fetch(baseUrl + "/api/v1/me/media/11111111-1111-4111-8111-111111111111", {
      method: "DELETE",
      headers: { authorization: "Bearer " + signedToken("media-writer") },
    });
    assert.equal(remove.status, 503);
    assert.equal((await remove.json()).error.code, "MEDIA_STORAGE_UNAVAILABLE");
  }, { env: authEnv, store: {} });
});
