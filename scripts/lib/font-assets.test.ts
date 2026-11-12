import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fontPartitions, literalCjkText, verifyFontRecipe, type Repertoires } from "../fonts/repertoires.ts";
import { FONT_SOURCES, fontSourceReceipt } from "../fonts/font-sources.ts";
import {
  assertSubsetCoverage,
  codepoints,
  expandUnicodeRange,
  partitionCharacters,
  renderFontCss,
  unicodeRange,
  validateWoff2,
  verifyFontBundle,
  type FontAsset,
  type FontManifest,
} from "./font-assets.ts";

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

function woff2(): Buffer {
  const bytes = Buffer.alloc(52);
  bytes.write("wOF2");
  bytes.writeUInt32BE(0x00010000, 4);
  bytes.writeUInt32BE(bytes.length, 8);
  bytes.writeUInt16BE(1, 12);
  bytes.writeUInt32BE(100, 16);
  bytes.writeUInt32BE(4, 20);
  return bytes;
}

function asset(bytes = woff2()): FontAsset {
  return { file: "inter-tight-normal-common.woff2", source: "inter-tight", family: "Inter Tight",
    style: "normal", weight: "400 700", unicodeRange: "U+20-7E", byteLength: bytes.length, sha256: sha256(bytes) };
}

function manifest(face = asset()): FontManifest {
  return { version: 1, generator: "subset-font@2.9.0", sources: [{ id: "inter-tight",
    blob: "7d64212163dc15e7f3de5487672668dbde589365", sha256: "a".repeat(64),
    license: "inter-tight-OFL.txt", licenseSha256: sha256("SIL OPEN FONT LICENSE Version 1.1\nCopyright test"),
    family: "Inter Tight", style: "normal", weights: ["400 700"], characterCount: 95,
    coverageSha256: sha256(Array.from({ length: 95 }, (_, index) => index + 32).join(",")) }],
    faces: [face] };
}

async function fixture(work: (directory: string, data: FontManifest) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "no-wave-font-check-"));
  const data = manifest();
  try {
    await writeFile(join(directory, data.faces[0]!.file), woff2());
    await writeFile(join(directory, data.sources[0]!.license), "SIL OPEN FONT LICENSE Version 1.1\nCopyright test");
    await work(directory, data);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("font ranges are canonical, sorted, deduplicated and preserve supplementary scalars", () => {
  const input = [0x4e00, 0x21, 0x20, 0x23, 0x22, 0x20000, 0x4e00, 0x20001];
  assert.equal(unicodeRange(input), "U+20-23,U+4E00,U+20000-20001");
  assert.deepEqual(expandUnicodeRange(unicodeRange(input)), [0x20, 0x21, 0x22, 0x23, 0x4e00, 0x20000, 0x20001]);
  assert.deepEqual(codepoints("无浪潮无𠀀"), [0x65e0, 0x6d6a, 0x6f6e, 0x20000]);
});

test("invalid font scalars, empty ranges and malformed CSS are refused", () => {
  for (const invalid of [-1, 1.2, NaN, Infinity, 0xd800, 0xdfff, 0x110000]) {
    assert.throws(() => unicodeRange([invalid]), /scalar/);
  }
  assert.throws(() => unicodeRange([]), /empty/);
  for (const invalid of ["", "U+", "20-7E", "U+22-20", "U+110000", "U+D800", "U+20;src:url(https://evil.test)", "U+4???", "U+0-10FFFF"]) {
    assert.throws(() => expandUnicodeRange(invalid), /range|scalar|limit/);
  }
});

test("font partitioning creates one shared common shard and disjoint lazy remainder", () => {
  const all = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const shards = partitionCharacters(all, [2, 4, 4, 100], 3);
  assert.deepEqual(shards, [
    { id: "common", points: [2, 4] },
    { id: "0000", points: [1, 3, 5] },
    { id: "0001", points: [6, 7, 8] },
    { id: "0002", points: [9] },
  ]);
  assert.deepEqual(shards.flatMap((shard) => shard.points).sort((a, b) => a - b), all);
  assert.equal(new Set(shards.flatMap((shard) => shard.points)).size, all.length);
  assert.deepEqual(partitionCharacters([2, 4], [2, 4], 2), [{ id: "common", points: [2, 4] }]);
  assert.deepEqual(partitionCharacters([1], [], 2), [{ id: "0000", points: [1] }]);
  assert.deepEqual(partitionCharacters([], [], 2), []);
});

test("partitioning rejects unbounded work and is independent of input ordering", () => {
  for (const size of [0, -1, 1.5, NaN, 4097]) assert.throws(() => partitionCharacters([1], [], size), /size/);
  const points = Array.from({ length: 2049 }, (_, index) => index + 32);
  const first = partitionCharacters(points, [35, 40, 200], 128);
  const second = partitionCharacters([...points].reverse(), [200, 40, 35], 128);
  assert.deepEqual(first, second);
  assert.ok(first.slice(1).every((shard) => shard.points.length <= 128));
  for (const shard of first) assert.deepEqual(expandUnicodeRange(unicodeRange(shard.points)), shard.points);
});

test("WOFF2 checks reject truncation, wrong format, reserved bits and size corruption", () => {
  assert.doesNotThrow(() => validateWoff2(woff2()));
  for (const length of [0, 4, 47]) assert.throws(() => validateWoff2(woff2().subarray(0, length)), /WOFF2/);
  const modifications: ((bytes: Buffer) => void)[] = [
    (bytes) => bytes.write("wOFF"),
    (bytes) => bytes.writeUInt32BE(99, 8),
    (bytes) => bytes.writeUInt16BE(0, 12),
    (bytes) => bytes.writeUInt16BE(1, 14),
    (bytes) => bytes.writeUInt32BE(0, 16),
    (bytes) => bytes.writeUInt32BE(bytes.length, 20),
  ];
  for (const modify of modifications) {
    const bytes = woff2(); modify(bytes);
    assert.throws(() => validateWoff2(bytes), /WOFF2/);
  }
});

test("the font CSS preserves the existing families, weights, italic and swap without a network dependency", () => {
  const data = manifest();
  data.faces.push({ ...asset(), file: "instrument-serif-italic-common.woff2", source: "instrument-serif-italic",
    family: "Instrument Serif", weight: "400", style: "italic" });
  const css = renderFontCss(data.faces);
  assert.match(css, /font-family: "Inter Tight"/);
  assert.match(css, /font-family: "Instrument Serif"/);
  assert.match(css, /font-style: italic/);
  assert.match(css, /font-weight: 400 700/);
  assert.equal((css.match(/font-display: swap/g) ?? []).length, 2);
  assert.equal((css.match(/unicode-range: U\+20-7E/g) ?? []).length, 2);
  assert.match(css, /url\("\.\/fonts\/inter-tight-normal-common\.woff2"\) format\("woff2"\)/);
  assert.doesNotMatch(css, /https?:|local\(|data:|@import/);
  assert.equal(renderFontCss(data.faces), css, "generation is byte-for-byte deterministic");
});

test("unsafe font filenames and unrecognized metadata cannot escape into CSS", () => {
  for (const file of ["../outside.woff2", "/tmp/out.woff2", "evil\\font.woff2", "font.woff2?tracking=1", 'font\");src:url(https://evil.test)']) {
    assert.throws(() => renderFontCss([{ ...asset(), file }]), /font/);
  }
  for (const change of [{ family: "Arial" }, { weight: "inherit" }, { style: "oblique" }, { unicodeRange: "U+20; color:red" }]) {
    assert.throws(() => renderFontCss([{ ...asset(), ...change } as FontAsset]), /font|range/);
  }
});

test("an offline bundle verification authenticates bytes, metadata, licenses and generated CSS", async () => {
  await fixture(async (directory, data) => {
    const result = await verifyFontBundle(data, directory, renderFontCss(data.faces));
    assert.deepEqual(result, { faces: 1, bytes: 52, families: ["Inter Tight"] });
  });
});

test("a changed font, wrong size, missing file or extra unowned font blocks verification", async () => {
  for (const mode of ["changed", "size", "missing", "extra"] as const) {
    await fixture(async (directory, data) => {
      if (mode === "changed") { const bytes = woff2(); bytes[51] = 9; await writeFile(join(directory, data.faces[0]!.file), bytes); }
      if (mode === "size") data.faces[0]!.byteLength++;
      if (mode === "missing") await rm(join(directory, data.faces[0]!.file));
      if (mode === "extra") await writeFile(join(directory, "not-in-manifest.woff2"), woff2());
      await assert.rejects(verifyFontBundle(data, directory, renderFontCss(data.faces)), /font|ENOENT/);
    });
  }
});

test("license deletion, changed copyright and stale generated styles cannot silently ship", async () => {
  for (const mode of ["missing", "changed", "css"] as const) {
    await fixture(async (directory, data) => {
      const license = join(directory, data.sources[0]!.license);
      if (mode === "missing") await rm(license);
      if (mode === "changed") await writeFile(license, "replacement without attribution");
      const css = renderFontCss(data.faces) + (mode === "css" ? "/* drift */" : "");
      await assert.rejects(verifyFontBundle(data, directory, css), /font|license|stylesheet|ENOENT/);
    });
  }
});

test("duplicate assets, overlapping shards and undeclared sources fail before publication", async () => {
  for (const mode of ["duplicate", "overlap", "source", "license-path"] as const) {
    await fixture(async (directory, data) => {
      if (mode === "duplicate") data.faces.push({ ...data.faces[0]! });
      if (mode === "overlap") data.faces.push({ ...data.faces[0]!, file: "inter-tight-normal-overlap.woff2" });
      if (mode === "source") data.faces[0]!.source = "unregistered";
      if (mode === "license-path") data.sources[0]!.license = "../outside-OFL.txt";
      await assert.rejects(verifyFontBundle(data, directory, renderFontCss(data.faces)), /font|source|overlap|duplicate|license/);
    });
  }
});

test("the checked-in first-party fonts are verified offline and root does not reference Google Fonts", async () => {
  const data = JSON.parse(await readFile(new URL("../../packages/web-ui/src/styles/fonts/manifest.json", import.meta.url), "utf8")) as FontManifest;
  const css = await readFile(new URL("../../packages/web-ui/src/styles/fonts.css", import.meta.url), "utf8");
  const result = await verifyFontBundle(data, new URL("../../packages/web-ui/src/styles/fonts/", import.meta.url), css);
  assert.deepEqual(data.sources, FONT_SOURCES.map(fontSourceReceipt));
  await verifyFontRecipe(data, new URL("../..", import.meta.url).pathname);
  assert.deepEqual(result.families, ["Instrument Serif", "Inter Tight", "Noto Sans SC", "Noto Serif SC"]);
  assert.ok(result.faces > 10, "Chinese and extended scripts have lazy Unicode shards");
  assert.ok(result.bytes < 64 * 1024 * 1024, "the complete font bundle has a bounded repository footprint");
  const root = await readFile(new URL("../../apps/web-rr/app/root.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(root, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
  assert.match(root, /styles\/fonts\.css\?url/);
});


test("reading and public usage priorities reduce glyph overfetch without losing or duplicating coverage", () => {
  const all = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const result = partitionCharacters(all, [9, 1], 2, { reading: [1, 2, 8, 99], priority: [5, 4, 5, 6] });
  assert.deepEqual(result, [
    { id: "common", points: [1, 9] },
    { id: "reading", points: [2, 8] },
    { id: "0000", points: [4, 5] },
    { id: "0001", points: [3, 6] },
    { id: "0002", points: [7] },
  ]);
  assert.deepEqual(result.flatMap((shard) => shard.points).sort((a, b) => a - b), all);
  assert.throws(() => partitionCharacters(all, [], 2, { priority: [0xd800] }), /scalar/);
  assert.throws(() => partitionCharacters(all, [], 2, { reading: [Infinity] }), /scalar/);
});

test("UI repertoire extraction parses real TSX literals and templates instead of mining comments", () => {
  const source = `
    // 注释不应加入核心字形
    const 变量名 = "正文\\u4e00";
    const label = \`模板\${变量名}结尾\`;
    export const view = <p aria-label="标题">阅读<span>中文</span>{label}</p>;
  `;
  const text = literalCjkText(source);
  for (const character of "正文一模板结尾标题阅读中文") assert.ok(text.includes(character), character);
  for (const character of "注释不应加入核心字形变量名") assert.equal(text.includes(character), false, character);
  assert.throws(() => literalCjkText("const broken = <p>"), /Unterminated|Unexpected/);
});

test("missing glyphs, omitted weights and source-style drift cannot pass the offline verifier", async () => {
  for (const mode of ["glyph", "count", "weight", "style", "family"] as const) {
    await fixture(async (directory, data) => {
      if (mode === "glyph") data.faces[0]!.unicodeRange = "U+20-7D";
      if (mode === "count") data.sources[0]!.characterCount--;
      if (mode === "weight") data.sources[0]!.weights.push("400");
      if (mode === "style") data.faces[0]!.style = "italic";
      if (mode === "family") data.faces[0]!.family = "Noto Sans SC";
      await assert.rejects(verifyFontBundle(data, directory, renderFontCss(data.faces)), /coverage|style|weight|font/i);
    });
  }
});


test("shaping closure may retain original mirror mappings, but missing or invented glyphs fail", () => {
  assert.doesNotThrow(() => assertSubsetCoverage([0x2208], [0x2208, 0x220b], [0x2208, 0x220b]));
  assert.throws(() => assertSubsetCoverage([0x2208, 0x220b], [0x2208], [0x2208, 0x220b]), /coverage/);
  assert.throws(() => assertSubsetCoverage([0x2208], [0x2208, 0x220c], [0x2208, 0x220b]), /coverage/);
});

test("font roles keep reader UI out of auth and avoid a second reading shard for display weights", () => {
  const all = codepoints("A无浪潮阅读登录");
  const repertoire: Repertoires = { sans: codepoints("A登录"), readerUi: codepoints("登录阅读"),
    serif: codepoints("A登录"), upper: codepoints("无浪潮"), reading: codepoints("无浪潮阅读"), priority: [] };
  const sans = FONT_SOURCES.find((source) => source.id === "noto-sans-sc")!;
  const serif = FONT_SOURCES.find((source) => source.id === "noto-serif-sc")!;
  const ui = fontPartitions(all, sans, "400 700", repertoire);
  assert.deepEqual(ui.find((shard) => shard.id === "common")!.points, codepoints("A登录"));
  assert.deepEqual(ui.find((shard) => shard.id === "interface")!.points, codepoints("阅读"));
  const body = fontPartitions(all, serif, "400", repertoire);
  const display = fontPartitions(all, serif, "500 700", repertoire);
  assert.deepEqual(body.find((shard) => shard.id === "reading")!.points, codepoints("无浪潮阅读"));
  assert.deepEqual(display.find((shard) => shard.id === "common")!.points, codepoints("无浪潮"));
  assert.equal(display.some((shard) => shard.id === "reading"), false);
  for (const shards of [ui, body, display]) {
    assert.deepEqual(shards.flatMap((shard) => shard.points).sort((a, b) => a - b), all);
  }
});

test("an old recipe cannot pass by preserving only its combined glyph coverage", async () => {
  const data = JSON.parse(await readFile(new URL("../../packages/web-ui/src/styles/fonts/manifest.json", import.meta.url), "utf8")) as FontManifest;
  const first = data.faces.find((face) => face.source === "noto-sans-sc" && face.file.endsWith("common.woff2"))!;
  const second = data.faces.find((face) => face.source === "noto-sans-sc" && face.file.endsWith("interface.woff2"))!;
  [first.unicodeRange, second.unicodeRange] = [second.unicodeRange, first.unicodeRange];
  await assert.rejects(verifyFontRecipe(data, new URL("../..", import.meta.url).pathname), /Stale font recipe/);
});
