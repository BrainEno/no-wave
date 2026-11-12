import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { create } from "fontkit";
import subsetFont from "subset-font";
import { FONT_SOURCES, fontSourceReceipt, type FontSource } from "./font-sources.ts";
import { assertSubsetCoverage, renderFontCss, unicodeRange, validateWoff2, verifyFontBundle, type FontAsset, type FontManifest } from "../lib/font-assets.ts";

import { applicationRepertoires, fontPartitions, verifyFontRecipe, type Repertoires } from "./repertoires.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const target = join(root, "packages/web-ui/src/styles/fonts");
const stylesheet = join(root, "packages/web-ui/src/styles/fonts.css");
const cache = join(root, ".cache/font-sources");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const LICENSE_NAME_IDS = [0, 1, 2, 4, 6, 13, 14, 16, 17];

async function pinnedBlob(blob: string, expected: string): Promise<Buffer> {
  await mkdir(cache, { recursive: true });
  const cached = join(cache, `${blob}.bin`);
  try {
    const bytes = await readFile(cached);
    if (bytes.length > MAX_SOURCE_BYTES || digest(bytes) !== expected) throw new Error(`Source cache checksum mismatch: ${blob}`);
    return bytes;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const url = `https://api.github.com/repos/google/fonts/git/blobs/${blob}`;
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(60_000),
    headers: { Accept: "application/vnd.github+json", "User-Agent": "no-wave-font-builder" } });
  if (!response.ok) throw new Error(`Font source download failed (${response.status}): ${url}`);
  const data: unknown = await response.json();
  if (typeof data !== "object" || data === null || !("encoding" in data) || data.encoding !== "base64" ||
      !("content" in data) || typeof data.content !== "string" || data.content.length > MAX_SOURCE_BYTES * 1.4) throw new Error("Invalid Git font blob response.");
  const bytes = Buffer.from(data.content, "base64");
  if (!bytes.length || bytes.length > MAX_SOURCE_BYTES || digest(bytes) !== expected) throw new Error(`Upstream font checksum mismatch: ${blob}`);
  await writeFile(cached, bytes);
  return bytes;
}

function assertExactCoverage(expected: readonly number[], actual: readonly number[], label: string): void {
  const a = [...new Set(actual)].sort((x, y) => x - y);
  const b = [...new Set(expected)].sort((x, y) => x - y);
  if (a.length !== b.length || a.some((point, index) => point !== b[index])) throw new Error(`Font glyph coverage changed: ${label}`);
}

async function emitSource(source: FontSource, directory: string, repertoires: Repertoires): Promise<FontAsset[]> {
  const input = await pinnedBlob(source.blob, source.sha256);
  const license = await pinnedBlob(source.licenseBlob, source.licenseSha256);
  await writeFile(join(directory, `${source.licenseId}-OFL.txt`), license);
  const original = create(input);
  // U+0000 and other control mappings do not represent renderable text. Keep
  // every printable original scalar, including supplementary Han characters.
  const all: number[] = original.characterSet.filter((point: number) => point >= 32 && !(point >= 0x7f && point <= 0x9f));
  if (all.length !== source.characterCount || digest(Buffer.from([...all].sort((a, b) => a - b).join(","))) !== source.coverageSha256) throw new Error(`Unexpected upstream glyph repertoire: ${source.id}`);
  const weights = fontSourceReceipt(source).weights;
  const result: FontAsset[] = [];
  for (const weight of weights) {
    const partitions = fontPartitions(all, source, weight, repertoires);
    const axis = weight === "400" ? 400 : weight === "500 700" ? { min: 500, max: 700 } : { min: 400, max: 700 };
    for (const shard of partitions) {
      const bytes = await subsetFont(input, String.fromCodePoint(...shard.points), {
        targetFormat: "woff2", preserveNameIds: LICENSE_NAME_IDS,
        ...(source.variable ? { variationAxes: { wght: axis } } : {}),
      });
      validateWoff2(bytes);
      assertSubsetCoverage(shard.points, create(bytes).characterSet, all);
      const file = `${source.id}-${source.style}-${weight.replace(" ", "-")}-${shard.id}.woff2`;
      const face: FontAsset = { file, source: source.id, family: source.family, style: source.style, weight,
        unicodeRange: unicodeRange(shard.points), byteLength: bytes.length, sha256: digest(bytes) };
      await writeFile(join(directory, file), bytes);
      result.push(face);
    }
    assertExactCoverage(all, partitions.flatMap((shard) => shard.points), `${source.id}/${weight}/complete`);
  }
  console.log(`${source.id}: ${all.length} codepoints, ${result.length} faces, ${result.reduce((sum, face) => sum + face.byteLength, 0)} bytes`);
  return result;
}

async function main(): Promise<void> {
  if (process.argv.includes("--check")) {
    const data: unknown = JSON.parse(await readFile(join(target, "manifest.json"), "utf8"));
    console.log(await verifyFontBundle(data, target, await readFile(stylesheet, "utf8")));
    const manifest = data as FontManifest;
    await verifyFontRecipe(manifest, root);
    if (JSON.stringify(manifest.sources) !== JSON.stringify(FONT_SOURCES.map(fontSourceReceipt))) throw new Error("Font source receipts differ from the pinned source catalog.");
    return;
  }
  if (process.argv.length > 2) throw new Error("Usage: node scripts/fonts/generate.ts [--check]");
  await mkdir(dirname(target), { recursive: true });
  const staging = await mkdtemp(join(dirname(target), ".font-staging-"));
  try {
    const faces: FontAsset[] = [];
    // Sequential source processing bounds WASM memory; each source is pinned and
    // verified before work begins. No browser/runtime request depends on GitHub.
    const repertoires = await applicationRepertoires(root);
    for (const source of FONT_SOURCES) faces.push(...await emitSource(source, staging, repertoires));
    const manifest: FontManifest = { version: 1, generator: "subset-font@2.9.0",
      sources: FONT_SOURCES.map(fontSourceReceipt), faces };
    const css = renderFontCss(faces);
    await writeFile(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await verifyFontBundle(manifest, staging, css);
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
    await writeFile(stylesheet, css);
    console.log(`Generated ${faces.length} first-party font faces. Commit fonts, licenses, manifest and CSS together.`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

await main();
