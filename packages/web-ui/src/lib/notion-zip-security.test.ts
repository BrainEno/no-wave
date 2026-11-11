import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import { NOTION_BUNDLE_MAX_BYTES, NOTION_BUNDLE_MAX_PAGES } from "./notion-import.ts";
import { markdownEntriesToBundle, readMarkdownZip } from "./notion-markdown.ts";

/** Start with a valid archive and mutate a copy, never an uploaded file. */
function archive(entries: Record<string, Uint8Array> = { "essay.md": strToU8("# 标题\n\n正文") }): Uint8Array {
  return zipSync(entries);
}

/** fflate writes an EOCD without a comment; all integer fields are little endian. */
function eocd(bytes: Uint8Array): { copy: Uint8Array; view: DataView; end: number } {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  const end = copy.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  return { copy, view, end };
}

function withEntries(count: number, extension = ".md"): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (let index = 0; index < count; index++) files[`page-${index}${extension}`] = strToU8(`# Title ${index}\n\nText`);
  return archive(files);
}

test("ordinary compressed Markdown continues to import after the fflate update", () => {
  const zip = archive({
    "中 文.md": strToU8("# 标题\n\n第一段。"),
    "nested/essay.md": strToU8("# Essay\n\nSecond paragraph."),
    "picture.png": new Uint8Array([0, 1, 2]),
  });
  const entries = readMarkdownZip(zip);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((item) => item.text).sort(), ["# Essay\n\nSecond paragraph.", "# 标题\n\n第一段。"].sort());
  assert.equal(markdownEntriesToBundle(entries).pages, 2);
});

test("the archive byte ceiling is enforced before parsing or decompressing", () => {
  const oversized = new Uint8Array(NOTION_BUNDLE_MAX_BYTES + 1);
  assert.throws(() => readMarkdownZip(oversized), /超过 8 MB/);
});

test("a highly compressed Markdown payload cannot exceed the decompressed byte ceiling", () => {
  const content = strToU8("# Title\n\n" + "A".repeat(NOTION_BUNDLE_MAX_BYTES));
  const zip = archive({ "bomb.md": content });
  assert.ok(zip.byteLength < NOTION_BUNDLE_MAX_BYTES, "the compressed archive fits the upload limit");
  assert.throws(() => readMarkdownZip(zip), /解压后的 Markdown 超过 8 MB/);
});

test("the decompressed ceiling applies to the sum across entries", () => {
  const part = strToU8("# Page\n\n" + "B".repeat(Math.floor(NOTION_BUNDLE_MAX_BYTES / 2)));
  const zip = archive({ "one.md": part, "two.md": part });
  assert.ok(zip.length < NOTION_BUNDLE_MAX_BYTES);
  assert.throws(() => readMarkdownZip(zip), /解压后的 Markdown 超过 8 MB/);
});

test("200 Markdown pages are allowed but page 201 fails instead of dropping content", () => {
  const maximum = readMarkdownZip(withEntries(NOTION_BUNDLE_MAX_PAGES));
  assert.equal(maximum.length, NOTION_BUNDLE_MAX_PAGES);
  assert.throws(() => readMarkdownZip(withEntries(NOTION_BUNDLE_MAX_PAGES + 1)), /最多导入 200/);
});

test("non-Markdown entries also count toward the archive entry ceiling", () => {
  assert.deepEqual(readMarkdownZip(withEntries(2000, ".txt")), []);
  assert.throws(() => readMarkdownZip(withEntries(2001, ".txt")), /文件数量过多/);
});

test("unsupported ZIP64 sentinel fields fail before invoking the decompressor", () => {
  const original = archive();
  for (const field of ["entries", "size", "offset"] as const) {
    const { copy, view, end } = eocd(original);
    if (field === "entries") { view.setUint16(end + 8, 0xffff, true); view.setUint16(end + 10, 0xffff, true); }
    if (field === "size") view.setUint32(end + 12, 0xffffffff, true);
    if (field === "offset") view.setUint32(end + 16, 0xffffffff, true);
    assert.throws(() => readMarkdownZip(copy), /ZIP 不完整或格式不受支持/, field);
  }
});

test("multi-volume and inconsistent central directory counts are refused", () => {
  const original = archive();
  for (const offset of [4, 6, 8]) {
    const { copy, view, end } = eocd(original);
    view.setUint16(end + offset, 2, true);
    assert.throws(() => readMarkdownZip(copy), /ZIP 不完整或格式不受支持/, `field ${offset}`);
  }
});

test("directory size and offset tampering is rejected", () => {
  for (const offset of [12, 16]) {
    const { copy, view, end } = eocd(archive());
    view.setUint32(end + offset, view.getUint32(end + offset, true) + 1, true);
    assert.throws(() => readMarkdownZip(copy), /ZIP 不完整或格式不受支持/);
  }
});

test("a declared entry count inconsistent with actual local records is refused", () => {
  const { copy, view, end } = eocd(archive());
  view.setUint16(end + 8, 2, true);
  view.setUint16(end + 10, 2, true);
  assert.throws(() => readMarkdownZip(copy), /ZIP 文件目录不完整/);
});

test("trailing bytes and truncation cannot turn an incomplete ZIP into a partial import", () => {
  const original = archive({ "one.md": strToU8("# One"), "two.md": strToU8("# Two") });
  for (const cut of [1, 2, 5, 10, 21, 22, Math.floor(original.length / 2)]) {
    assert.throws(() => readMarkdownZip(original.subarray(0, original.length - cut)), /ZIP/);
  }
  const extra = new Uint8Array(original.length + 1);
  extra.set(original);
  assert.throws(() => readMarkdownZip(extra), /ZIP/);
});

test("invalid UTF-8 in Markdown is not silently replaced or imported", () => {
  const zip = archive({ "invalid.md": new Uint8Array([0x23, 0x20, 0xc3, 0x28]) });
  assert.throws(() => readMarkdownZip(zip), /encoded data|encoding|UTF-8/i);
});

test("non-Markdown and macOS metadata are not presented as importable pages", () => {
  const zip = archive({
    "__MACOSX/._essay.md": strToU8("# Metadata"),
    "__MACOSX/nested/other.md": strToU8("# Metadata"),
    "essay.MD": strToU8("# Essay"),
    "readme.txt": strToU8("# Not Markdown"),
  });
  const entries = readMarkdownZip(zip);
  assert.deepEqual(entries.map((entry) => entry.name), ["essay.MD"]);
});

test("hostile ZIP64 markers fail promptly in a separate process", () => {
  // The upstream advisory concerns an infinite loop on malformed ZIP64. Run a
  // representative malformed header in an isolated child with a hard timeout so
  // a future regression cannot hang the whole test process indefinitely.
  const { copy, view, end } = eocd(archive());
  view.setUint16(end + 8, 0xffff, true);
  view.setUint16(end + 10, 0xffff, true);
  const module = new URL("./notion-markdown.ts", import.meta.url).href;
  const code = `import { readMarkdownZip } from ${JSON.stringify(module)};\n` +
    `try { readMarkdownZip(Buffer.from(${JSON.stringify(Buffer.from(copy).toString("base64"))}, "base64")); process.exit(2); }\n` +
    `catch (error) { if (!String(error).includes("ZIP")) process.exit(3); }`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 5000 });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
});

test("the decompressed size ceiling is inclusive, not one byte too strict", () => {
  const header = "# Page\n\n";
  const text = header + "x".repeat(NOTION_BUNDLE_MAX_BYTES - header.length);
  const entries = readMarkdownZip(archive({ "at-limit.md": strToU8(text) }));
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.text.length, NOTION_BUNDLE_MAX_BYTES);
});

test("an empty, structurally valid ZIP is not confused with a truncated archive", () => {
  assert.deepEqual(readMarkdownZip(archive({})), []);
});
