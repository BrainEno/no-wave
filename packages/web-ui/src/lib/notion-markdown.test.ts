import assert from "node:assert/strict";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";
import { markdownEntriesToBundle, readMarkdownZip } from "./notion-markdown.ts";
import { parseNotionBundle, groupNotionWorks, planNotionSeed, emptyNotionSeedState } from "../../../../apps/api/src/application/notion-bundle.ts";

const id = "ce90817d48bc4108902808c6c7bde306";
const sample = "# 十字星\n\nPublished: Yes\nRank: 1\nSlug: 十字星\nTags: 诗歌\n\n第一行\n\n第二行";
test("Notion Markdown maps into the real import planner", () => {
  const result = markdownEntriesToBundle([{ name: `十字星 ${id}.md`, text: sample }]);
  assert.equal(result.pages, 1);
  assert.ok(!result.warnings.some((w) => w.includes("Rank")));
  const parsed = parseNotionBundle(result.bundle);
  const plan = planNotionSeed({ works: groupNotionWorks(parsed.pages).works, state: emptyNotionSeedState(), options: { now: () => new Date("2024-01-01T00:00:00Z") } });
  const draft = plan.works[0]!.primary.draft;
  assert.equal(draft.title, "十字星");
  assert.equal(draft.publish, true);
  assert.equal(draft.workType, "poetry");
  assert.deepEqual(draft.contentBlocks.map((b) => b.text), ["第一行", "第二行"]);
});
test("ZIP selects Markdown safely and preserves relationships", () => {
  const linked = "410315cb0ec880cbbc30e8bd101ad535";
  const zip = zipSync({ [`folder/十字星 ${id}.md`]: strToU8(sample), [`folder/Aircraft ${linked}.md`]: strToU8(`# Aircraft\n\nEnglish: 十字星 (%E5%8D%81%E5%AD%97%E6%98%9F%20${id}.md)\nPublished: No\n\nSome text.`), "folder/ignored.txt": strToU8("x") });
  const entries = readMarkdownZip(zip);
  const result = markdownEntriesToBundle(entries);
  assert.equal(result.pages, 2);
  assert.equal(groupNotionWorks(parseNotionBundle(result.bundle).pages).works.length, 1);
});
test("reject duplicates, nonmatching files, and zip bombs", () => {
  const file = { name: `title ${id}.md`, text: sample };
  assert.throws(() => markdownEntriesToBundle([file, file]), /重复/);
  assert.throws(() => markdownEntriesToBundle([{ name: "readme.md", text: "no title" }]), /未找到/);
  assert.equal(markdownEntriesToBundle([{ name: "readme.md", text: "# readme\ntext" }]).pages, 1);
  const zip = zipSync({ [`title ${id}.md`]: new Uint8Array(8 * 1024 * 1024 + 1) });
  assert.throws(() => readMarkdownZip(zip), /超过|解压失败/);
});
test("local images and unsupported metadata are not silently retained", () => {
  const result = markdownEntriesToBundle([{ name: `title ${id}.md`, text: "# Title\n\n![alt](local.png)\n\ntext" }]);
  assert.ok(result.warnings.some((w) => w.includes("本地图片")));
  assert.equal(parseNotionBundle(result.bundle).pages[0]!.blocks.length, 1);
});
test("published pages without a source date have a stable digest across retries", () => {
  const bundle = parseNotionBundle(markdownEntriesToBundle([{ name: `title ${id}.md`, text: sample }]).bundle);
  const works = groupNotionWorks(bundle.pages).works;
  const make = (date: string) => planNotionSeed({ works, state: emptyNotionSeedState(), options: { now: () => new Date(date) } }).works[0]!.primary.digest;
  assert.equal(make("2024-01-01T00:00:00Z"), make("2025-01-01T00:00:00Z"));
});

test("metadata, rich text and signed image handling are reported accurately", () => {
  const src = `# 摘录\n\nDate: July 27, 2024\nExcerpt: 概要\nFeaturedImage: https://example.com/cover.jpg\nUnknown: some value\nPublished: Yes\nTags: 其他\n\n正文 **加粗** [链接](https://example.com)。\n\n![图片](https://prod-files-secure.s3.us-west-2.amazonaws.com/image?X-Amz-Signature=secret)\n\n![其他](https://example.com/image?X-Amz-Signature=secret)`;
  const result = markdownEntriesToBundle([{ name: `摘录 ${id}.md`, text: src }]);
  assert.ok(result.warnings.some((w) => w.includes("Unknown")));
  assert.ok(result.warnings.some((w) => w.includes("签名图片")));
  const page = parseNotionBundle(result.bundle).pages[0]!;
  assert.equal(page.properties.Date?.date?.start, "2024-07-27T00:00:00.000Z");
  assert.equal(page.properties.Published?.checkbox, true);
  const plan = planNotionSeed({ works: groupNotionWorks([page]).works, state: emptyNotionSeedState() });
  const edition = plan.works[0]!.primary;
  assert.equal(edition.draft.summary, "概要");
  assert.ok(edition.issues.some((issue) => issue.code === "featured-image-not-carried"));
  assert.ok(edition.issues.some((issue) => issue.code === "expiring-image-url"));
  assert.match(JSON.stringify(edition.draft.contentBlocks), /bold/);
  assert.equal(edition.draft.contentBlocks.filter((b) => b.type === "image").length, 1);
});

test("truncated ZIP is rejected instead of silently importing a partial archive", () => {
  const zip = zipSync({ [`title ${id}.md`]: strToU8(sample) });
  assert.throws(() => readMarkdownZip(zip.subarray(0, zip.length - 5)), /ZIP/);
});
