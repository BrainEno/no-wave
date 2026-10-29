import assert from "node:assert/strict";
import test from "node:test";
import { createSqliteClient, runSqliteMigrations } from "./sqlite.ts";
import { createSqliteMediaStore } from "./sqlite-media-store.ts";

const ownerId = "11111111-1111-4111-8111-111111111111";
const assetId = "22222222-2222-4222-8222-222222222222";

async function fixture() {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  await runSqliteMigrations(db);
  db.prepare("INSERT INTO auth_accounts (user_id, email, password_hash) VALUES (?, ?, ?)").run(ownerId, "media-owner@example.test", "fixture");
  return { db, store: createSqliteMediaStore(db) };
}

test("SQLite media metadata persists a normalized image and rejects duplicate asset keys", async () => {
  const { db, store } = await fixture();
  try {
    const input = {
      id: assetId,
      ownerId,
      storageKey: "assets/" + ownerId + "/" + assetId + ".webp",
      contentType: "image/webp" as const,
      byteSize: 1234,
      width: 400,
      height: 300,
      sha256: "a".repeat(64),
    };
    const created = await store.createMediaAsset(input);
    assert.deepEqual({
      id: created.id,
      ownerId: created.ownerId,
      storageKey: created.storageKey,
      contentType: created.contentType,
      byteSize: created.byteSize,
      width: created.width,
      height: created.height,
      sha256: created.sha256,
    }, input);
    assert.equal(typeof created.createdAt, "string");
    assert.deepEqual(await store.getMediaAsset({ id: assetId }), created);
    assert.equal(await store.getMediaAsset({ id: "not-a-uuid" }), null);
    await assert.rejects(store.createMediaAsset(input));
    assert.equal(db.prepare("SELECT count(*) AS count FROM media_assets").get().count, 1);
  } finally {
    db.close();
  }
});

test("SQLite media metadata enforces the owner foreign key and image storage constraints", async () => {
  const { db, store } = await fixture();
  try {
    await assert.rejects(store.createMediaAsset({
      id: assetId,
      ownerId: "33333333-3333-4333-8333-333333333333",
      storageKey: "assets/missing-owner/" + assetId + ".webp",
      contentType: "image/webp",
      byteSize: 1234,
      width: 400,
      height: 300,
      sha256: "a".repeat(64),
    }));
    await assert.rejects(store.createMediaAsset({
      id: assetId,
      ownerId,
      storageKey: "assets/" + ownerId + "/" + assetId + ".webp",
      contentType: "image/png",
      byteSize: 1234,
      width: 400,
      height: 300,
      sha256: "a".repeat(64),
    }));
    assert.equal(db.prepare("SELECT count(*) AS count FROM media_assets").get().count, 0);
  } finally {
    db.close();
  }
});
