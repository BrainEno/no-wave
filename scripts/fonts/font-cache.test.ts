import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  fontBundleNeedsGeneration,
  renderFontCss,
  type FontManifest,
} from "../lib/font-assets.ts";
import {
  archiveTargetToCache,
  cleanResidualFontAssets,
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

const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

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
  assert.ok(
    dirs.some(
      (d) =>
        d.endsWith(".cache/font-subsets") || d.endsWith(".cache\\font-subsets"),
    ),
  );
});

test("computeShardKey is deterministic and sensitive to blob, weight, shard and codepoints", () => {
  const key1 = computeShardKey("blob-a", "400", "0001", [10, 20, 30]);
  const key2 = computeShardKey("blob-a", "400", "0001", [30, 10, 20]); // sorted order identical
  const keyDiffBlob = computeShardKey("blob-b", "400", "0001", [10, 20, 30]);
  const keyDiffWeight = computeShardKey("blob-a", "700", "0001", [10, 20, 30]);
  const keyDiffPoints = computeShardKey("blob-a", "400", "0001", [10, 20, 31]);

  assert.equal(
    key1,
    key2,
    "reordered codepoints produce the same deterministic key",
  );
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

    const badRead = await readCachedSourceBlob(
      blob,
      "wrong-digest".padEnd(64, "0"),
      [dir],
    );
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
        {
          file: file1,
          source: "s1",
          family: "Inter Tight",
          style: "normal",
          weight: "400",
          unicodeRange: "U+20",
          byteLength: bytes1.length,
          sha256: digest1,
        },
        {
          file: file2,
          source: "s1",
          family: "Inter Tight",
          style: "normal",
          weight: "400",
          unicodeRange: "U+21",
          byteLength: bytes2.length,
          sha256: digest2,
        },
      ],
    };

    // Prepopulate target with file1 and archive to cache
    await writeFile(join(targetDir, file1), bytes1);
    await writeFile(join(targetDir, file2), bytes2);
    const archived = await archiveTargetToCache(manifest, targetDir, [
      cacheDir,
    ]);
    assert.equal(archived, 2);

    // Wipe target
    await rm(join(targetDir, file1), { force: true });
    await rm(join(targetDir, file2), { force: true });

    // Restore from cache
    const result = await restoreBundleFromCache(manifest, targetDir, [
      cacheDir,
    ]);
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

test("restoreBundleFromCache purges corrupted/changed residual files from target when missing from cache", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "no-wave-purge-cache-"));
  const targetDir = await mkdtemp(join(tmpdir(), "no-wave-purge-target-"));
  try {
    const file = "corrupt-face.woff2";
    const goodBytes = dummyWoff2("good");
    const corruptBytes = dummyWoff2("bad!");
    const manifest: FontManifest = {
      version: 1,
      generator: "subset-font@2.9.0",
      sources: [],
      faces: [
        {
          file,
          source: "s1",
          family: "Inter Tight",
          style: "normal",
          weight: "400",
          unicodeRange: "U+20",
          byteLength: goodBytes.length,
          sha256: sha256(goodBytes),
        },
      ],
    };

    // Prepopulate target with corrupt bytes of matching length
    await writeFile(join(targetDir, file), corruptBytes);

    // Cache is empty, so restoration cannot find good bytes
    const result = await restoreBundleFromCache(manifest, targetDir, [
      cacheDir,
    ]);
    assert.equal(result.restored, 0);
    assert.equal(result.alreadyPresent, 0);
    assert.equal(result.missing, 1);

    // Corrupted residual file must be removed from target so targetDir is clean for generation
    const exists = await readFile(join(targetDir, file)).then(
      () => true,
      () => false,
    );
    assert.equal(
      exists,
      false,
      "corrupted residual file must be purged from target directory",
    );
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});

test("restoreBundleFromCache cleans up unowned .woff2 files in target directory", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "no-wave-unowned-cache-"));
  const targetDir = await mkdtemp(join(tmpdir(), "no-wave-unowned-target-"));
  try {
    const validFile = "valid-face.woff2";
    const unownedFile = "old-stale-shard.woff2";
    const bytes = dummyWoff2("valid");
    const manifest: FontManifest = {
      version: 1,
      generator: "subset-font@2.9.0",
      sources: [],
      faces: [
        {
          file: validFile,
          source: "s1",
          family: "Inter Tight",
          style: "normal",
          weight: "400",
          unicodeRange: "U+20",
          byteLength: bytes.length,
          sha256: sha256(bytes),
        },
      ],
    };

    await writeFile(join(targetDir, validFile), bytes);
    await writeFile(join(targetDir, unownedFile), dummyWoff2("unowned"));

    const result = await restoreBundleFromCache(manifest, targetDir, [
      cacheDir,
    ]);
    assert.equal(result.alreadyPresent, 1);

    // Valid file preserved, unowned file purged
    const validExists = await readFile(join(targetDir, validFile)).then(
      () => true,
      () => false,
    );
    const unownedExists = await readFile(join(targetDir, unownedFile)).then(
      () => true,
      () => false,
    );
    assert.equal(validExists, true, "valid file must be preserved");
    assert.equal(unownedExists, false, "unowned .woff2 file must be removed");
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});

test("restoreBundleFromCache restores and overwrites corrupted residual file with valid cached file", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "no-wave-heal-cache-"));
  const targetDir = await mkdtemp(join(tmpdir(), "no-wave-heal-target-"));
  try {
    const file = "healed-face.woff2";
    const goodBytes = dummyWoff2("heal-good");
    const corruptBytes = dummyWoff2("heal-corrupt");
    const digest = sha256(goodBytes);

    const manifest: FontManifest = {
      version: 1,
      generator: "subset-font@2.9.0",
      sources: [],
      faces: [
        {
          file,
          source: "s1",
          family: "Inter Tight",
          style: "normal",
          weight: "400",
          unicodeRange: "U+20",
          byteLength: goodBytes.length,
          sha256: digest,
        },
      ],
    };

    // Prepopulate target with corrupted file
    await writeFile(join(targetDir, file), corruptBytes);

    // Cache contains the genuine good subset
    const subsetDir = join(cacheDir, "subsets");
    await mkdir(subsetDir, { recursive: true });
    await writeFile(join(subsetDir, `${digest}.woff2`), goodBytes);

    const result = await restoreBundleFromCache(manifest, targetDir, [
      cacheDir,
    ]);
    assert.equal(result.restored, 1);
    assert.equal(result.missing, 0);

    const restoredBytes = await readFile(join(targetDir, file));
    assert.deepEqual(
      restoredBytes,
      goodBytes,
      "corrupted file must be overwritten with valid cached asset",
    );
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});

test("restoreBundleFromCache purges corrupted/poisoned cache files rather than copying them into target", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "no-wave-poison-cache-"));
  const targetDir = await mkdtemp(join(tmpdir(), "no-wave-poison-target-"));
  try {
    const file = "poison-face.woff2";
    const goodBytes = dummyWoff2("poison-good");
    const badBytes = dummyWoff2("poison-bad-bytes");
    const digest = sha256(goodBytes);

    const manifest: FontManifest = {
      version: 1,
      generator: "subset-font@2.9.0",
      sources: [],
      faces: [
        {
          file,
          source: "s1",
          family: "Inter Tight",
          style: "normal",
          weight: "400",
          unicodeRange: "U+20",
          byteLength: goodBytes.length,
          sha256: digest,
        },
      ],
    };

    // Cache contains a corrupted file whose filename is the good digest but content has bad bytes
    const subsetDir = join(cacheDir, "subsets");
    await mkdir(subsetDir, { recursive: true });
    const cachedFilePath = join(subsetDir, `${digest}.woff2`);
    await writeFile(cachedFilePath, badBytes);

    const result = await restoreBundleFromCache(manifest, targetDir, [
      cacheDir,
    ]);
    assert.equal(result.restored, 0);
    assert.equal(result.missing, 1);

    // Corrupted cache file must be deleted so it cannot cause future harm
    const cacheExists = await readFile(cachedFilePath).then(
      () => true,
      () => false,
    );
    assert.equal(cacheExists, false, "poisoned cache file must be deleted");
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});

test("archiveTargetToCache verifies SHA-256 and refuses to archive corrupted or mismatched files", async () => {
  const cacheDir = await mkdtemp(
    join(tmpdir(), "no-wave-archive-integrity-cache-"),
  );
  const targetDir = await mkdtemp(
    join(tmpdir(), "no-wave-archive-integrity-target-"),
  );
  try {
    const fileGood = "good.woff2";
    const fileBad = "bad.woff2";
    const goodBytes = dummyWoff2("genuine-face");
    const badBytes = dummyWoff2("spoofed-face");

    const manifest: FontManifest = {
      version: 1,
      generator: "subset-font@2.9.0",
      sources: [],
      faces: [
        {
          file: fileGood,
          source: "s1",
          family: "Inter Tight",
          style: "normal",
          weight: "400",
          unicodeRange: "U+20",
          byteLength: goodBytes.length,
          sha256: sha256(goodBytes),
        },
        // Manifest expects genuine digest, but target has badBytes
        {
          file: fileBad,
          source: "s1",
          family: "Inter Tight",
          style: "normal",
          weight: "400",
          unicodeRange: "U+21",
          byteLength: badBytes.length,
          sha256: sha256("expected-different-hash"),
        },
      ],
    };

    await writeFile(join(targetDir, fileGood), goodBytes);
    await writeFile(join(targetDir, fileBad), badBytes);

    const archived = await archiveTargetToCache(manifest, targetDir, [
      cacheDir,
    ]);
    assert.equal(archived, 1, "only genuine verified asset must be archived");

    const goodInCache = await readFile(
      join(cacheDir, "subsets", `${sha256(goodBytes)}.woff2`),
    ).then(
      () => true,
      () => false,
    );
    const badInCache = await readFile(
      join(cacheDir, "subsets", `${sha256("expected-different-hash")}.woff2`),
    ).then(
      () => true,
      () => false,
    );
    assert.equal(goodInCache, true);
    assert.equal(
      badInCache,
      false,
      "mismatched file must not be written to cache",
    );
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});

test("cleanResidualFontAssets removes corrupted and unowned files while preserving valid files", async () => {
  const targetDir = await mkdtemp(join(tmpdir(), "no-wave-clean-test-"));
  try {
    const validFile = "valid.woff2";
    const corruptFile = "corrupt.woff2";
    const unownedFile = "unowned.woff2";

    const validBytes = dummyWoff2("valid-content");
    const corruptBytes = dummyWoff2("corrupt-content");

    const manifest: FontManifest = {
      version: 1,
      generator: "subset-font@2.9.0",
      sources: [],
      faces: [
        {
          file: validFile,
          source: "s1",
          family: "Inter Tight",
          style: "normal",
          weight: "400",
          unicodeRange: "U+20",
          byteLength: validBytes.length,
          sha256: sha256(validBytes),
        },
        {
          file: corruptFile,
          source: "s1",
          family: "Inter Tight",
          style: "normal",
          weight: "400",
          unicodeRange: "U+21",
          byteLength: corruptBytes.length,
          sha256: sha256("wrong-hash"),
        },
      ],
    };

    await writeFile(join(targetDir, validFile), validBytes);
    await writeFile(join(targetDir, corruptFile), corruptBytes);
    await writeFile(join(targetDir, unownedFile), dummyWoff2("unowned"));

    const result = await cleanResidualFontAssets(manifest, targetDir);
    assert.equal(result.preserved, 1);
    assert.equal(result.cleaned, 2);

    assert.equal(
      await readFile(join(targetDir, validFile)).then(
        () => true,
        () => false,
      ),
      true,
    );
    assert.equal(
      await readFile(join(targetDir, corruptFile)).then(
        () => true,
        () => false,
      ),
      false,
    );
    assert.equal(
      await readFile(join(targetDir, unownedFile)).then(
        () => true,
        () => false,
      ),
      false,
    );
  } finally {
    await rm(targetDir, { recursive: true, force: true });
  }
});

test("self-healing workflow: residual changed asset in target is purged so fontBundleNeedsGeneration succeeds instead of throwing", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "no-wave-heal-test-cache-"));
  const targetDir = await mkdtemp(join(tmpdir(), "no-wave-heal-test-target-"));
  try {
    const file = "noto-sans-sc-normal-400-700-common.woff2";
    const goodBytes = dummyWoff2("genuine-shard");
    const badBytes = dummyWoff2("stale-old-shard");
    const manifest: FontManifest = {
      version: 1,
      generator: "subset-font@2.9.0",
      sources: [
        {
          id: "noto-sans-sc",
          blob: "fb0637bafbcd804fe32152370a1225990745b4bc",
          sha256:
            "a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da",
          license: "noto-sans-sc-OFL.txt",
          licenseSha256: sha256(
            "SIL OPEN FONT LICENSE Version 1.1\nCopyright test",
          ),
          family: "Noto Sans SC",
          style: "normal",
          weights: ["400 700"],
          characterCount: 1,
          coverageSha256: sha256("65"),
        },
      ],
      faces: [
        {
          file,
          source: "noto-sans-sc",
          family: "Noto Sans SC",
          style: "normal",
          weight: "400 700",
          unicodeRange: "U+41",
          byteLength: goodBytes.length,
          sha256: sha256(goodBytes),
        },
      ],
    };
    await writeFile(
      join(targetDir, "noto-sans-sc-OFL.txt"),
      "SIL OPEN FONT LICENSE Version 1.1\nCopyright test",
    );
    const css = renderFontCss(manifest.faces);

    // Write the stale/corrupted asset into targetDir
    await writeFile(join(targetDir, file), badBytes);

    // Before fix: fontBundleNeedsGeneration would throw 'Changed font asset' and abort.
    // With restoreBundleFromCache:
    const restoreResult = await restoreBundleFromCache(manifest, targetDir, [
      cacheDir,
    ]);
    assert.equal(restoreResult.missing, 1);

    // The corrupted asset was purged, so fontBundleNeedsGeneration safely reports that generation is needed without throwing
    const needsGeneration = await fontBundleNeedsGeneration(
      manifest,
      targetDir,
      css,
    );
    assert.equal(
      needsGeneration,
      true,
      "bundle accurately reports missing asset without throwing 'Changed font asset'",
    );
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});
