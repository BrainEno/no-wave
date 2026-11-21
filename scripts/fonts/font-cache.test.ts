import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FontManifest } from "../lib/font-assets.ts";
import {
  archiveTargetToCache,
  clearFontCache,
  computeShardKey,
  readCachedShard,
  readCachedSourceBlob,
  readCachedSubset,
  resolveFontCacheDirectories,
  resolveUserFontCacheDir,
  restoreBundleFromCache,
  writeCachedShard,
  writeCachedSourceBlob,
} from "./font-cache.ts";

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

function dummyWoff2(seed = "test"): Buffer {
  const bytes = Buffer.alloc(52);
  bytes.write("wOF2");
  bytes.write(seed, 4);
  return bytes;
}

test("resolveUserFontCacheDir respects NO_WAVE_FONT_CACHE environment variable", () => {
  const previous = process.env.NO_WAVE_FONT_CACHE;
  try {
    process.env.NO_WAVE_FONT_CACHE = "/tmp/custom-font-cache";
    assert.equal(resolveUserFontCacheDir(), "/tmp/custom-font-cache");
  } finally {
    if (previous !== undefined) process.env.NO_WAVE_FONT_CACHE = previous;
    else delete process.env.NO_WAVE_FONT_CACHE;
  }
});

test("resolveFontCacheDirectories provides both user machine cache and workspace cache", () => {
  const dirs = resolveFontCacheDirectories("/workspace/test-repo");
  assert.ok(dirs.length >= 1);
  assert.ok(dirs.some((d) => d.endsWith(".cache/font-subsets") || d.endsWith(".cache\\font-subsets")));
});

test("computeShardKey is deterministic and sensitive to blob, weight, shard and codepoints", () => {
  const key1 = computeShardKey("blob-a", "400", "0001", [10, 20, 30]);
  const key2 = computeShardKey("blob-a", "400", "0001", [30, 10, 20]); // sorted order identical
  const keyDiffBlob = computeShardKey("blob-b", "400", "0001", [10, 20, 30]);
  const keyDiffWeight = computeShardKey("blob-a", "700", "0001", [10, 20, 30]);
  const keyDiffPoints = computeShardKey("blob-a", "400", "0001", [10, 20, 31]);

  assert.equal(key1, key2, "reordered codepoints produce the same deterministic key");
  assert.notEqual(key1, keyDiffBlob);
  assert.notEqual(key1, keyDiffWeight);
  assert.notEqual(key1, keyDiffPoints);
});

test("writeCachedShard and readCachedShard round-trip across cache directories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "no-wave-cache-test-"));
  try {
    const bytes = dummyWoff2("shard-roundtrip");
    const digest = sha256(bytes);
    const shardKey = "shard-test-key-123";

    await writeCachedShard(shardKey, digest, bytes, [dir]);

    const read = await readCachedShard(shardKey, [dir]);
    assert.ok(read);
    assert.deepEqual(read, bytes);

    const readByHash = await readCachedSubset(digest, [dir]);
    assert.ok(readByHash);
    assert.deepEqual(readByHash, bytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeCachedSourceBlob and readCachedSourceBlob round-trip with integrity verification", async () => {
  const dir = await mkdtemp(join(tmpdir(), "no-wave-source-test-"));
  try {
    const bytes = Buffer.from("RAW_TTF_MOCK_CONTENT");
    const digest = sha256(bytes);
    const blob = "commit-blob-hash";

    await writeCachedSourceBlob(blob, bytes, [dir]);

    const read = await readCachedSourceBlob(blob, digest, [dir]);
    assert.ok(read);
    assert.deepEqual(read, bytes);

    const badRead = await readCachedSourceBlob(blob, "wrong-digest".padEnd(64, "0"), [dir]);
    assert.equal(badRead, null, "mismatched hash fails closed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("restoreBundleFromCache and archiveTargetToCache restore fonts without regeneration", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "no-wave-bundle-cache-"));
  const targetDir = await mkdtemp(join(tmpdir(), "no-wave-bundle-target-"));
  try {
    const file1 = "font-face-1.woff2";
    const bytes1 = dummyWoff2("face-1");
    const digest1 = sha256(bytes1);

    const file2 = "font-face-2.woff2";
    const bytes2 = dummyWoff2("face-2");
    const digest2 = sha256(bytes2);

    const manifest: FontManifest = {
      version: 1,
      generator: "subset-font@2.9.0",
      sources: [],
      faces: [
        { file: file1, source: "s1", family: "Inter Tight", style: "normal", weight: "400", unicodeRange: "U+20", byteLength: bytes1.length, sha256: digest1 },
        { file: file2, source: "s1", family: "Inter Tight", style: "normal", weight: "400", unicodeRange: "U+21", byteLength: bytes2.length, sha256: digest2 },
      ],
    };

    // Prepopulate target with file1 and archive to cache
    await writeFile(join(targetDir, file1), bytes1);
    await writeFile(join(targetDir, file2), bytes2);
    const archived = await archiveTargetToCache(manifest, targetDir, [cacheDir]);
    assert.equal(archived, 2);

    // Wipe target
    await rm(join(targetDir, file1), { force: true });
    await rm(join(targetDir, file2), { force: true });

    // Restore from cache
    const result = await restoreBundleFromCache(manifest, targetDir, [cacheDir]);
    assert.equal(result.restored, 2);
    assert.equal(result.missing, 0);

    // Verify files restored
    const restored1 = await readFile(join(targetDir, file1));
    const restored2 = await readFile(join(targetDir, file2));
    assert.deepEqual(restored1, bytes1);
    assert.deepEqual(restored2, bytes2);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});
