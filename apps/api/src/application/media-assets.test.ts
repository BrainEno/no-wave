import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { normalizeUploadedImage, createMediaAssetService } from "./media-assets.ts";

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
