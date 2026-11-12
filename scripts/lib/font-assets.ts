import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const FONT_FAMILIES = ["Instrument Serif", "Inter Tight", "Noto Sans SC", "Noto Serif SC"] as const;
export type FontFamily = typeof FONT_FAMILIES[number];
export type FontAsset = {
  file: string;
  source: string;
  family: FontFamily;
  style: "normal" | "italic";
  weight: "400" | "400 700" | "500 700";
  unicodeRange: string;
  byteLength: number;
  sha256: string;
};
export type FontSourceReceipt = {
  id: string;
  blob: string;
  sha256: string;
  license: string;
  licenseSha256: string;
  family: FontFamily;
  style: "normal" | "italic";
  weights: FontAsset["weight"][];
  characterCount: number;
  coverageSha256: string;
};
export type FontManifest = {
  version: 1;
  generator: "subset-font@2.9.0";
  sources: FontSourceReceipt[];
  faces: FontAsset[];
};

const MAX_FACE_POINTS = 65_536;
const MAX_FONT_BYTES = 2 * 1024 * 1024;
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function scalars(values: readonly number[]): number[] {
  if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff))) {
    throw new Error("Invalid Unicode scalar in font repertoire.");
  }
  return [...new Set(values)].sort((a, b) => a - b);
}

export function codepoints(text: string): number[] {
  return scalars([...text].map((character) => character.codePointAt(0)!));
}

/** Compact exact ranges, never a wildcard that would also claim absent glyphs. */
export function unicodeRange(values: readonly number[]): string {
  const points = scalars(values);
  if (!points.length) throw new Error("An empty font range cannot be emitted.");
  const result: string[] = [];
  for (let index = 0; index < points.length; index++) {
    const first = points[index]!;
    let last = first;
    while (points[index + 1] === last + 1) last = points[++index]!;
    result.push(`U+${first.toString(16).toUpperCase()}${last === first ? "" : `-${last.toString(16).toUpperCase()}`}`);
  }
  return result.join(",");
}

export function expandUnicodeRange(value: string): number[] {
  if (!value || value.length > 262_144) throw new Error("Invalid font range length.");
  const result: number[] = [];
  for (const token of value.split(",")) {
    const match = /^U\+([0-9a-f]{1,6})(?:-([0-9a-f]{1,6}))?$/i.exec(token);
    if (!match) throw new Error("Invalid font range syntax.");
    const first = Number.parseInt(match[1]!, 16);
    const last = Number.parseInt(match[2] ?? match[1]!, 16);
    if (last < first || result.length + last - first + 1 > MAX_FACE_POINTS) throw new Error("Invalid font range or point limit.");
    for (let point = first; point <= last; point++) result.push(point);
  }
  return scalars(result);
}

/** Common chrome/auth glyphs are shared; less common scripts load in small shards. */
export function partitionCharacters(all: readonly number[], common: readonly number[], size = 128,
  options: { reading?: readonly number[]; readingId?: "reading" | "interface"; priority?: readonly number[] } = {}): { id: string; points: number[] }[] {
  if (!Number.isInteger(size) || size < 1 || size > 4096) throw new Error("Invalid font shard size.");
  const repertoire = scalars(all);
  const preferred = new Set(scalars(common));
  const first = repertoire.filter((point) => preferred.has(point));
  const readingSet = new Set(scalars(options.reading ?? []));
  const reading = repertoire.filter((point) => !preferred.has(point) && readingSet.has(point));
  const priority = options.priority ?? [];
  scalars(priority); // Validate while preserving the public priority order.
  const ranks = new Map([...new Set(priority)].map((point, index) => [point, index]));
  const rest = repertoire.filter((point) => !preferred.has(point) && !readingSet.has(point))
    .sort((a, b) => (ranks.get(a) ?? Infinity) - (ranks.get(b) ?? Infinity) || a - b);
  const result = first.length ? [{ id: "common", points: first }] : [];
  if (reading.length) result.push({ id: options.readingId ?? "reading", points: reading });
  for (let index = 0; index < rest.length; index += size) {
    result.push({ id: String(index / size).padStart(4, "0"), points: rest.slice(index, index + size).sort((a, b) => a - b) });
  }
  return result;
}

/**
 * HarfBuzz retains shaping closure (e.g. a mirrored math operator), which can
 * add an original cmap entry. Never drop that feature just to make counts
 * equal: require every requested scalar and reject anything absent upstream.
 * CSS still advertises only the disjoint requested ranges.
 */
export function assertSubsetCoverage(requested: readonly number[], actual: readonly number[], original: readonly number[]): void {
  const upstream = new Set(scalars(original));
  const encoded = new Set(scalars(actual));
  if (scalars(requested).some((point) => !encoded.has(point)) || [...encoded].some((point) => !upstream.has(point))) {
    throw new Error("Changed font subset glyph coverage.");
  }
}

/** A cheap offline integrity boundary; glyph validity is additionally checked by the generator. */
export function validateWoff2(bytes: Uint8Array): void {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 48 || buffer.length > MAX_FONT_BYTES || buffer.toString("ascii", 0, 4) !== "wOF2" ||
      buffer.readUInt32BE(8) !== buffer.length || buffer.readUInt16BE(12) === 0 || buffer.readUInt16BE(14) !== 0 ||
      buffer.readUInt32BE(16) === 0 || buffer.readUInt32BE(20) > buffer.length - 48) {
    throw new Error("Invalid WOFF2 signature, length or directory.");
  }
}

function assertAsset(value: unknown): asserts value is FontAsset {
  if (!record(value) || typeof value.file !== "string" || !/^[a-z][a-z0-9-]*\.woff2$/.test(value.file) ||
      typeof value.source !== "string" || !/^[a-z][a-z-]*$/.test(value.source) ||
      !FONT_FAMILIES.includes(value.family as FontFamily) || !["normal", "italic"].includes(String(value.style)) ||
      !["400", "400 700", "500 700"].includes(String(value.weight)) || typeof value.unicodeRange !== "string" ||
      !Number.isInteger(value.byteLength) || Number(value.byteLength) < 48 || Number(value.byteLength) > MAX_FONT_BYTES ||
      typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new Error("Invalid font asset metadata or filename.");
  }
  const points = expandUnicodeRange(value.unicodeRange);
  if (unicodeRange(points) !== value.unicodeRange) throw new Error("Non-canonical font range.");
}

export function renderFontCss(faces: readonly FontAsset[]): string {
  const declarations = faces.map((face) => {
    assertAsset(face);
    return `@font-face {\n  font-family: "${face.family}";\n  font-style: ${face.style};\n  font-weight: ${face.weight};\n  font-display: swap;\n  src: url("./fonts/${face.file}") format("woff2");\n  unicode-range: ${face.unicodeRange};\n}`;
  });
  // The path is relative to src/styles/fonts.css, beside the generated directory.
  return `/* Generated by pnpm fonts:generate. See docs/architecture/first-party-fonts.md. */\n${declarations.join("\n\n")}\n`;
}

function parseManifest(value: unknown): FontManifest {
  if (!record(value) || value.version !== 1 || value.generator !== "subset-font@2.9.0" ||
      !Array.isArray(value.sources) || !value.sources.length || value.sources.length > 8 ||
      !Array.isArray(value.faces) || !value.faces.length || value.faces.length > 4096) throw new Error("Invalid font manifest.");
  const sourceIds = new Set<string>();
  for (const source of value.sources) {
    if (!record(source) || typeof source.id !== "string" || !/^[a-z][a-z-]*$/.test(source.id) || sourceIds.has(source.id) ||
        typeof source.blob !== "string" || !/^[a-f0-9]{40}$/.test(source.blob) ||
        typeof source.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.sha256) ||
        typeof source.license !== "string" || !/^[a-z][a-z-]*-OFL\.txt$/.test(source.license) ||
        typeof source.licenseSha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.licenseSha256) ||
        !FONT_FAMILIES.includes(source.family as FontFamily) || !["normal", "italic"].includes(String(source.style)) ||
        !Array.isArray(source.weights) || !source.weights.length || source.weights.length > 3 ||
        source.weights.some((weight) => !["400", "400 700", "500 700"].includes(String(weight))) ||
        new Set(source.weights).size !== source.weights.length || !Number.isInteger(source.characterCount) ||
        Number(source.characterCount) < 1 || Number(source.characterCount) > MAX_FACE_POINTS ||
        typeof source.coverageSha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.coverageSha256)) throw new Error("Invalid font source or license receipt.");
    sourceIds.add(source.id);
  }
  const files = new Set<string>();
  const coverage = new Map<string, Set<number>>();
  for (const face of value.faces) {
    assertAsset(face);
    if (files.has(face.file)) throw new Error("Duplicate font asset.");
    if (!sourceIds.has(face.source)) throw new Error("Unregistered font source.");
    const source = value.sources.find((candidate: FontSourceReceipt) => candidate.id === face.source) as FontSourceReceipt;
    if (face.family !== source.family || face.style !== source.style || !source.weights.includes(face.weight)) throw new Error("Font style or weight differs from its source receipt.");
    const key = `${face.source}:${face.weight}`;
    const seen = coverage.get(key) ?? new Set<number>();
    for (const point of expandUnicodeRange(face.unicodeRange)) {
      if (seen.has(point)) throw new Error("Overlapping font shards for one style and weight.");
      seen.add(point);
    }
    coverage.set(key, seen);
    files.add(face.file);
  }
  for (const source of value.sources as FontSourceReceipt[]) {
    for (const weight of source.weights) {
      const points = [...(coverage.get(`${source.id}:${weight}`) ?? [])].sort((a, b) => a - b);
      if (points.length !== source.characterCount || digest(points.join(",")) !== source.coverageSha256) throw new Error("Incomplete or changed font glyph coverage.");
    }
  }
  // All fields that reach disk/CSS are validated above, not accepted on a cast alone.
  return value as FontManifest;
}

/** No network, browser or regeneration: every checked-in byte must match its receipt. */
export async function verifyFontBundle(value: unknown, directory: string | URL, css: string): Promise<{ faces: number; bytes: number; families: string[] }> {
  const data = parseManifest(value);
  const path = directory instanceof URL ? fileURLToPath(directory) : directory;
  const expected = new Set(data.faces.map((face) => face.file));
  const actual = (await readdir(path)).filter((file) => file.endsWith(".woff2"));
  if (actual.length !== expected.size || actual.some((file) => !expected.has(file))) throw new Error("Missing or unowned font assets in the generated directory.");
  let total = 0;
  for (const face of data.faces) {
    const bytes = await readFile(join(path, face.file));
    validateWoff2(bytes);
    if (bytes.length !== face.byteLength || digest(bytes) !== face.sha256) throw new Error(`Changed font asset: ${face.file}`);
    total += bytes.length;
  }
  for (const source of data.sources) {
    const license = await readFile(join(path, source.license));
    if (digest(license) !== source.licenseSha256 || !/SIL OPEN FONT LICENSE/i.test(license.toString("utf8"))) throw new Error(`Changed font license: ${source.license}`);
  }
  if (css !== renderFontCss(data.faces)) throw new Error("Generated font stylesheet is stale; run pnpm fonts:generate.");
  return { faces: data.faces.length, bytes: total, families: [...new Set(data.faces.map((face) => face.family))].sort() };
}
