import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { create } from "fontkit";
import subsetFont from "subset-font";
import { FONT_SOURCES, fontSourceReceipt, type FontSource } from "./font-sources.ts";
import { downloadPinnedFontBlob } from "./source-download.ts";
import {
  assertFontReproduction,
  assertSubsetCoverage,
  fontBundleNeedsGeneration,
  renderFontCss,
  unicodeRange,
  validateWoff2,
  verifyFontBundle,
  type FontAsset,
  type FontManifest,
} from "../lib/font-assets.ts";
import { applicationRepertoires, fontPartitions, verifyFontRecipe, type Repertoires } from "./repertoires.ts";
import {
  archiveTargetToCache,
  clearFontCache,
  computeShardKey,
  readCachedShard,
  readCachedSourceBlob,
  resolveFontCacheDirectories,
  restoreBundleFromCache,
  writeCachedShard,
  writeCachedSourceBlob,
} from "./font-cache.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const target = join(root, "packages/web-ui/src/styles/fonts");
const stylesheet = join(root, "packages/web-ui/src/styles/fonts.css");
const legacyCache = join(root, ".cache/font-sources");
const cacheDirs = resolveFontCacheDirectories(root);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const LICENSE_NAME_IDS = [0, 1, 2, 4, 6, 13, 14, 16, 17];

async function pinnedBlob(blob: string, expected: string): Promise<Buffer> {
  const fromCache = await readCachedSourceBlob(blob, expected, cacheDirs);
  if (fromCache) return fromCache;

  // Legacy local repo cache fallback
  await mkdir(legacyCache, { recursive: true });
  const cached = join(legacyCache, `${blob}.bin`);
  try {
    const bytes = await readFile(cached);
    if (bytes.length <= MAX_SOURCE_BYTES && digest(bytes) === expected) {
      await writeCachedSourceBlob(blob, bytes, cacheDirs);
      return bytes;
    }
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }

  const bytes = await downloadPinnedFontBlob(blob, expected);
  await writeFile(cached, bytes).catch(() => {});
  await writeCachedSourceBlob(blob, bytes, cacheDirs);
  return bytes;
}

function assertExactCoverage(expected: readonly number[], actual: readonly number[], label: string): void {
  const a = [...new Set(actual)].sort((x, y) => x - y);
  const b = [...new Set(expected)].sort((x, y) => x - y);
  if (a.length !== b.length || a.some((point, index) => point !== b[index])) {
    throw new Error(`Font glyph coverage changed: ${label}`);
  }
}

async function emitSource(
  source: FontSource,
  directory: string,
  repertoires: Repertoires,
  force = false,
): Promise<FontAsset[]> {
  const input = await pinnedBlob(source.blob, source.sha256);
  const license = await pinnedBlob(source.licenseBlob, source.licenseSha256);
  await writeFile(join(directory, `${source.licenseId}-OFL.txt`), license);
  const original = create(input);
  // U+0000 and other control mappings do not represent renderable text. Keep
  // every printable original scalar, including supplementary Han characters.
  const all: number[] = original.characterSet.filter((point: number) => point >= 32 && !(point >= 0x7f && point <= 0x9f));
  if (all.length !== source.characterCount || digest(Buffer.from([...all].sort((a, b) => a - b).join(","))) !== source.coverageSha256) {
    throw new Error(`Unexpected upstream glyph repertoire: ${source.id}`);
  }
  const weights = fontSourceReceipt(source).weights;
  const result: FontAsset[] = [];
  let cacheHits = 0;
  for (const weight of weights) {
    const partitions = fontPartitions(all, source, weight, repertoires);
    const axis = weight === "400" ? 400 : weight === "500 700" ? { min: 500, max: 700 } : { min: 400, max: 700 };
    for (const shard of partitions) {
      const file = `${source.id}-${source.style}-${weight.replace(" ", "-")}-${shard.id}.woff2`;
      const shardKey = computeShardKey(source.blob, weight, shard.id, shard.points, source.variable ? axis : undefined);
      let bytes = force ? null : await readCachedShard(shardKey, cacheDirs);
      if (bytes) {
        cacheHits += 1;
      } else {
        bytes = await subsetFont(input, String.fromCodePoint(...shard.points), {
          targetFormat: "woff2",
          preserveNameIds: LICENSE_NAME_IDS,
          ...(source.variable ? { variationAxes: { wght: axis } } : {}),
        });
        await writeCachedShard(shardKey, digest(bytes), bytes, cacheDirs);
      }
      validateWoff2(bytes);
      assertSubsetCoverage(shard.points, create(bytes).characterSet, all);
      const face: FontAsset = {
        file,
        source: source.id,
        family: source.family,
        style: source.style,
        weight,
        unicodeRange: unicodeRange(shard.points),
        byteLength: bytes.length,
        sha256: digest(bytes),
      };
      await writeFile(join(directory, file), bytes);
      result.push(face);
    }
    assertExactCoverage(all, partitions.flatMap((shard) => shard.points), `${source.id}/${weight}/complete`);
  }
  const cacheHitNote = cacheHits > 0 ? ` (${cacheHits}/${result.length} faces from computer cache)` : "";
  console.log(`${source.id}: ${all.length} codepoints, ${result.length} faces, ${result.reduce((sum, face) => sum + face.byteLength, 0)} bytes${cacheHitNote}`);
  return result;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const prepareMode = args.includes("--prepare");
  const force = args.includes("--force");
  const clearCacheMode = args.includes("--clear-cache");

  if (args.some((arg) => !["--check", "--prepare", "--force", "--clear-cache"].includes(arg))) {
    throw new Error("Usage: node scripts/fonts/generate.ts [--check|--prepare|--force|--clear-cache]");
  }

  if (clearCacheMode) {
    await clearFontCache(cacheDirs);
    console.log("Local font cache cleared.");
    return;
  }

  const manifestPath = join(target, "manifest.json");
  const manifestExists = existsSync(manifestPath);
  const cssExists = existsSync(stylesheet);

  let expected: { manifest: string; css: string } | undefined;
  if (manifestExists && cssExists) {
    const rawManifest = await readFile(manifestPath, "utf8");
    const rawCss = await readFile(stylesheet, "utf8");
    if (prepareMode) {
      expected = { manifest: rawManifest, css: rawCss };
    }

    const data: unknown = JSON.parse(rawManifest);
    const manifest = data as FontManifest;

    // Both inspections validate the manifest before it reaches the recipe.
    await verifyFontRecipe(manifest, root);
    if (JSON.stringify(manifest.sources) !== JSON.stringify(FONT_SOURCES.map(fontSourceReceipt))) {
      throw new Error("Font source receipts differ from the pinned source catalog.");
    }

    if (checkOnly) {
      console.log(await verifyFontBundle(data, target, rawCss));
      return;
    }

    // Try fast restore from local computer cache
    if (!force) {
      const { restored } = await restoreBundleFromCache(manifest, target, cacheDirs);
      const needsGeneration = await fontBundleNeedsGeneration(data, target, rawCss);
      if (!needsGeneration) {
        await archiveTargetToCache(manifest, target, cacheDirs);
        if (restored > 0) {
          console.log(`First-party fonts are ready; restored ${restored} faces from local computer cache without regeneration.`);
        } else {
          console.log("First-party fonts are ready; verified offline without regeneration.");
        }
        return;
      }
    }
  } else if (checkOnly) {
    throw new Error("Font manifest or stylesheet is missing; cannot check.");
  }

  await mkdir(dirname(target), { recursive: true });
  const staging = await mkdtemp(join(dirname(target), ".font-staging-"));
  try {
    const faces: FontAsset[] = [];
    const repertoires = await applicationRepertoires(root);
    for (const source of FONT_SOURCES) {
      faces.push(...await emitSource(source, staging, repertoires, force));
    }
    const manifest: FontManifest = {
      version: 1,
      generator: "subset-font@2.9.0",
      sources: FONT_SOURCES.map(fontSourceReceipt),
      faces,
    };
    const css = renderFontCss(faces);
    const receipts = { manifest: `${JSON.stringify(manifest, null, 2)}\n`, css };
    await writeFile(join(staging, "manifest.json"), receipts.manifest);
    await verifyFontBundle(manifest, staging, css);
    if (expected) {
      assertFontReproduction(expected, receipts);
      assertFontReproduction(expected, {
        manifest: await readFile(join(target, "manifest.json"), "utf8"),
        css: await readFile(stylesheet, "utf8"),
      });
      await fontBundleNeedsGeneration(JSON.parse(expected.manifest), target, expected.css);
      await verifyFontRecipe(manifest, root);
    }
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
    if (!expected) await writeFile(stylesheet, css);

    // Archive all freshly emitted faces to local computer cache
    await archiveTargetToCache(manifest, target, cacheDirs);
    console.log(`Prepared ${faces.length} first-party font faces (cached locally). WOFF2 files stay ignored; review receipts, licenses, manifest and CSS for intentional recipe changes.`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

await main();
