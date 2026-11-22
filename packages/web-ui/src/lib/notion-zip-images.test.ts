import assert from "node:assert/strict";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";
import { markdownEntriesToBundle, readMarkdownZip } from "./notion-markdown.ts";
import {
  LOCAL_IMAGE_UPLOADS_PER_RUN,
  extractZipImages,
  imageContentType,
  localImageCandidates,
  resolveLocalImage,
  uploadLocalImages,
  zipImageEntries,
  type UploadMemory,
} from "./notion-zip-images.ts";

/**
 * Local images from a Notion export, sent to the media library on the author's
 * click: what is found, what is sent, and every reason something is not.
 */

const PNG = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, n, n]);
const GIF = strToU8("GIF89a-not-accepted");
const pageId = "ce90817d48bc4108902808c6c7bde306";
const dir = `墙壁 ${pageId}`;

function exportZip(images: Record<string, Uint8Array>, markdown: string) {
  return zipSync({ [`导出/墙壁 ${pageId}.md`]: strToU8(markdown), ...Object.fromEntries(Object.entries(images).map(([name, bytes]) => [`导出/${name}`, bytes])) });
}

test("relative links resolve inside the archive; anything else does not", () => {
  assert.equal(resolveLocalImage("导出/墙壁.md", "%E5%A2%99%E5%A3%81/image%201.png"), "导出/墙壁/image 1.png");
  assert.equal(resolveLocalImage("a/b/page.md", "../img/x.png"), "a/img/x.png");
  assert.equal(resolveLocalImage("page.md", "./x.png"), "x.png");
  for (const href of ["../x.png", "/etc/x.png", "//evil/x.png", "data:image/png;base64,AA", "file:///x.png", "javascript:x", ""]) {
    assert.equal(resolveLocalImage("page.md", href), null, href);
  }
});

test("image entries are listed from the central directory with their fingerprint fields", () => {
  const zip = exportZip({ [`${dir}/a.png`]: PNG(1), [`${dir}/b.gif`]: GIF, "notes.txt": strToU8("x") }, "# 墙壁");
  const found = zipImageEntries(zip);
  assert.deepEqual([...found.keys()].sort(), [`导出/${dir}/a.png`, `导出/${dir}/b.gif`]);
  assert.equal(found.get(`导出/${dir}/a.png`)!.size, 11);
  assert.equal(typeof found.get(`导出/${dir}/a.png`)!.crc, "number");
});

test("only the wanted images are inflated, each cut off at 8 MiB", () => {
  const zip = exportZip({ [`${dir}/a.png`]: PNG(1), [`${dir}/big.png`]: new Uint8Array(9 * 1024 * 1024), [`${dir}/c.png`]: PNG(3) }, "# 墙壁");
  const out = extractZipImages(zip, new Set([`导出/${dir}/a.png`, `导出/${dir}/big.png`, "导出/missing.png"]));
  assert.deepEqual(out.get(`导出/${dir}/a.png`), PNG(1));
  assert.equal(out.get(`导出/${dir}/big.png`), "too-large");
  assert.equal(out.get("导出/missing.png"), "unreadable");
  assert.equal(out.has(`导出/${dir}/c.png`), false);
});

test("the real bytes decide the type sent", () => {
  assert.equal(imageContentType(PNG(0)), "image/png");
  assert.equal(imageContentType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(imageContentType(strToU8("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ")), "image/webp");
  assert.equal(imageContentType(GIF), null);
});

test("an uploaded copy is linked by its media address; one that is not stays removed and named", () => {
  const markdown = `# 墙壁\n\n![第一张](${encodeURIComponent(dir)}/a.png)\n\n![第二张](${encodeURIComponent(dir)}/b.png)\n\n正文`;
  const zip = exportZip({ [`${dir}/a.png`]: PNG(1), [`${dir}/b.png`]: PNG(2) }, markdown);
  const entries = readMarkdownZip(zip);
  const before = markdownEntriesToBundle(entries);
  assert.deepEqual(before.localImages, [{ path: `导出/${dir}/a.png`, uploaded: false }, { path: `导出/${dir}/b.png`, uploaded: false }]);
  assert.equal(before.warnings.filter((w) => w.includes("本地图片")).length, 2);

  const src = "/api/media/00000000-0000-4000-8000-000000000001";
  const after = markdownEntriesToBundle(entries, { uploadedImages: new Map([[`导出/${dir}/a.png`, src]]) });
  const blocks = (after.bundle.pages as { blocks: { type: string; image?: unknown }[] }[])[0]!.blocks;
  assert.deepEqual(blocks.filter((b) => b.type === "image").map((b) => b.image), [{ type: "external", external: { url: src }, caption: [{ plain_text: "第一张" }] }]);
  assert.deepEqual(after.warnings.filter((w) => w.includes("本地图片")), [`导出/墙壁 ${pageId}.md：本地图片 第二张 未导入。`]);
  assert.deepEqual(after.localImages.map((i) => i.uploaded), [true, false]);
});

test("candidates exclude what the upload would refuse anyway, each with its reason", () => {
  const zip = exportZip({ [`${dir}/a.png`]: PNG(1), [`${dir}/b.gif`]: GIF }, "# 墙壁");
  const { candidates, unusable } = localImageCandidates([`导出/${dir}/a.png`, `导出/${dir}/a.png`, `导出/${dir}/b.gif`, "导出/gone.png", null], [zipImageEntries(zip)]);
  assert.deepEqual(candidates.map((c) => c.path), [`导出/${dir}/a.png`]);
  assert.deepEqual(unusable, [{ path: `导出/${dir}/b.gif`, reason: "只支持 JPEG、PNG、WebP 格式" }, { path: "导出/gone.png", reason: "所选文件里没有这张图片" }]);
});

/* ------------------------------ the upload loop ----------------------------- */

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function memory(): UploadMemory & { all: Map<string, string> } {
  const all = new Map<string, string>();
  return { all, get: (key) => all.get(key), set: (key, src) => { all.set(key, src); } };
}
function server(answer: (call: number, init?: RequestInit) => { status: number; body?: unknown }, library: string[] = []) {
  const posts: RequestInit[] = []; const gets: string[] = [];
  return {
    posts, gets,
    fetch: async (input: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") { gets.push(input); return new Response(JSON.stringify({ data: { items: library.map((asset) => ({ id: asset })), nextCursor: null } }), { status: 200 }); }
      posts.push(init!);
      const { status, body } = answer(posts.length, init);
      return new Response(JSON.stringify(body ?? {}), { status });
    },
  };
}
const created = (call: number) => ({ status: 201, body: { data: { src: `/api/media/${id(call)}` } } });

function many(n: number, extra: Record<string, Uint8Array> = {}) {
  const images: Record<string, Uint8Array> = { ...extra };
  for (let i = 1; i <= n; i++) images[`${dir}/${String(i).padStart(2, "0")}.png`] = PNG(i);
  const zip = exportZip(images, "# 墙壁");
  const entries = zipImageEntries(zip);
  return { zip, candidates: localImageCandidates([...entries.keys()].sort(), [entries]).candidates };
}

test("one click sends at most ten uploads and counts the rest", async () => {
  const { zip, candidates } = many(12);
  const api = server(created);
  const result = await uploadLocalImages([zip], candidates, { fetch: api.fetch, memory: memory() });
  assert.equal(api.posts.length, LOCAL_IMAGE_UPLOADS_PER_RUN);
  assert.equal(result.newly, 10);
  assert.equal(result.uploaded.size, 10);
  assert.deepEqual(result.left, candidates.slice(10).map((c) => c.path));
  assert.equal(result.stop, null);
  assert.deepEqual(api.posts.map((init) => (init.headers as Record<string, string>)["content-type"]), Array(10).fill("image/png"));
});

test("the first 429 stops the run without waiting; nothing after it is sent", async () => {
  const { zip, candidates } = many(5);
  const api = server((call) => (call === 3 ? { status: 429 } : created(call)));
  const result = await uploadLocalImages([zip], candidates, { fetch: api.fetch, memory: memory() });
  assert.equal(api.posts.length, 3);
  assert.equal(result.stop, "rate-limited");
  assert.equal(result.newly, 2);
  assert.equal(result.left.length, 3);
});

test("a later visit reuses the author's earlier uploads and continues past them", async () => {
  const { zip, candidates } = many(12);
  const remembered = memory();
  const first = await uploadLocalImages([zip], candidates, { fetch: server(created).fetch, memory: remembered });
  assert.equal(remembered.all.size, 10);
  // Fingerprints are hashes: no path or title is kept in the browser.
  assert.ok([...remembered.all.keys()].every((key) => /^[0-9a-f]{64}$/.test(key)));

  // One of the ten was deleted from the library since.
  const library = [...first.uploaded.values()].map((src) => src.slice("/api/media/".length)).slice(1);
  const api = server((call) => created(100 + call), library);
  const second = await uploadLocalImages([zip], candidates, { fetch: api.fetch, memory: remembered });
  assert.equal(second.reused, 9);
  assert.equal(second.newly, 3);
  assert.equal(second.uploaded.size, 12);
  assert.equal(api.posts.length, 3);
  assert.equal(api.gets.length, 1);
});

test("a file that is not an accepted image costs no request; a refusal is named and the rest continue", async () => {
  const { zip, candidates } = many(2, { [`${dir}/00-fake.png`]: GIF });
  const api = server((call) => (call === 1 ? { status: 400, body: { error: { message: "The image could not be decoded." } } } : created(call)));
  const result = await uploadLocalImages([zip], candidates, { fetch: api.fetch, memory: memory() });
  assert.equal(api.posts.length, 2);
  assert.deepEqual(result.failed, [
    { path: `导出/${dir}/00-fake.png`, reason: "文件内容不是 JPEG、PNG 或 WebP 图片" },
    { path: `导出/${dir}/01.png`, reason: "上传被拒绝：The image could not be decoded." },
  ]);
  assert.equal(result.newly, 1);
});

test("a signed-out session or missing media storage stops the run, and an invalid answer is not linked", async () => {
  const { zip, candidates } = many(3);
  const signedOut = await uploadLocalImages([zip], candidates, { fetch: server(() => ({ status: 401 })).fetch, memory: memory() });
  assert.equal(signedOut.stop, "session");
  assert.equal(signedOut.left.length, 3);
  const noStorage = await uploadLocalImages([zip], candidates, { fetch: server(() => ({ status: 503 })).fetch, memory: memory() });
  assert.equal(noStorage.stop, "unconfigured");
  const odd = await uploadLocalImages([zip], candidates, { fetch: server(() => ({ status: 201, body: { data: { src: "https://evil.example/x.png" } } })).fetch, memory: memory() });
  assert.equal(odd.uploaded.size, 0);
  assert.equal(odd.failed.length, 3);
});
