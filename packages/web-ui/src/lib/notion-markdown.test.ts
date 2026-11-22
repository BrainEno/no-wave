import assert from "node:assert/strict";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";
import { markdownEntriesToBundle, notionBoolean, notionDateStart, parseCsv, readMarkdownZip, tablesOf } from "./notion-markdown.ts";
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
  // Without a "# title" the file name is the title — said, not silent; with
  // neither the page cannot be named and nothing is importable.
  const untitled = markdownEntriesToBundle([{ name: "readme.md", text: "no title" }]);
  assert.equal(untitled.pages, 1);
  assert.ok(untitled.warnings.some((w) => w.includes("已用文件名「readme」作标题")));
  assert.throws(() => markdownEntriesToBundle([{ name: ".md", text: "no title" }]), /未找到可导入的文章/);
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

// --- Database CSV beside the Markdown (Notion "Markdown & CSV" export) ---

const dbId = "0123456789abcdef0123456789abcdef";
const idA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const idB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
type Props = Record<string, { date?: { start: string }; checkbox?: boolean; rich_text?: { plain_text: string }[]; multi_select?: { name: string }[]; files?: unknown[]; title?: { plain_text: string }[] }>;
const propsOf = (bundle: Record<string, unknown>, index = 0) => ((bundle.pages as { properties: Props }[])[index]!.properties);

test("CSV parsing handles BOM, CRLF, quoted commas, doubled quotes and line breaks", () => {
  const rows = parseCsv('\uFEFFName,Excerpt\r\n"墙壁, 其一","他说：""好""\r\n第二行"\r\n\r\nPlain,x\n');
  assert.deepEqual(rows, [["Name", "Excerpt"], ["墙壁, 其一", '他说："好"\r\n第二行'], ["Plain", "x"]]);
});

test("_all.csv is preferred over the view CSV of the same database; a lone CSV is still read", () => {
  const both = tablesOf([
    { name: `export/作品库 ${dbId}.csv`, text: "Name,Tags\n甲,a" },
    { name: `export/作品库 ${dbId}_all.csv`, text: "Name,Tags,Date\n甲,a,2026-10-08" },
  ]);
  assert.equal(both.length, 1);
  assert.equal(both[0]!.name, "作品库.csv");
  assert.deepEqual(both[0]!.header, ["Name", "Tags", "Date"]);
  const lone = tablesOf([{ name: `作品库 ${dbId}.csv`, text: "Name,Tags\n甲,a" }]);
  assert.deepEqual(lone[0]!.header, ["Name", "Tags"]);
});

test("a CSV ZIP fills properties the Markdown lacks and the planner sees them", () => {
  const zip = zipSync({
    [`导出/作品库 ${dbId}.csv`]: strToU8("Name,Tags\n墙壁,诗歌"),
    [`导出/作品库 ${dbId}_all.csv`]: strToU8(`\uFEFFName,Date,Excerpt,FeaturedImage,Published,Slug,Tags,Rank\r\n墙壁,"October 8, 2026",一面墙的独白,https://example.com/wall.jpg,Yes,wall,"诗歌, 实验",3\r\n`),
    [`导出/作品库/墙壁 ${idA}.md`]: strToU8("# 墙壁\n\n第一行"),
  });
  const result = markdownEntriesToBundle(readMarkdownZip(zip));
  const props = propsOf(result.bundle);
  assert.equal(props.Date?.date?.start, "2026-10-08T00:00:00.000Z");
  assert.equal(props.Published?.checkbox, true);
  assert.equal(props.Slug?.rich_text?.[0]?.plain_text, "wall");
  assert.deepEqual(props.Tags?.multi_select?.map((t) => t.name), ["诗歌", "实验"]);
  assert.ok(result.warnings.some((w) => w.includes("《墙壁》：已从 作品库.csv 补 6 列属性") && w.includes("请核对")));
  assert.ok(!result.warnings.some((w) => w.includes("Rank")));
  const plan = planNotionSeed({ works: groupNotionWorks(parseNotionBundle(result.bundle).pages).works, state: emptyNotionSeedState() });
  const draft = plan.works[0]!.primary.draft;
  assert.equal(draft.publish, true);
  assert.equal(draft.summary, "一面墙的独白");
  assert.equal(draft.slug, "wall");
});

test("Chinese column names and values fill only empty fields and never overwrite the Markdown", () => {
  const result = markdownEntriesToBundle([
    { name: `作品库 ${dbId}.csv`, text: "名称,日期,摘要,已发布,别名,标签,心情\n雨夜,2026年10月8日,雨中独行,是,yu-ye,诗歌，散文,平静\n" },
    { name: `雨夜 ${idA}.md`, text: "# 雨夜\n\nSlug: kept-slug\n\n正文" },
  ]);
  const props = propsOf(result.bundle);
  assert.equal(props.Slug?.rich_text?.[0]?.plain_text, "kept-slug");
  assert.equal(props.Date?.date?.start, "2026-10-08T00:00:00.000Z");
  assert.equal(props.Published?.checkbox, true);
  assert.equal(props.Excerpt?.rich_text?.[0]?.plain_text, "雨中独行");
  assert.deepEqual(props.Tags?.multi_select?.map((t) => t.name), ["诗歌", "散文"]);
  assert.ok(result.warnings.some((w) => w.includes("补 4 列属性")));
  assert.ok(result.warnings.some((w) => w.includes("列 心情 没有对应字段")));
});

test("a page without a # title takes the file name and is matched to its row by it", () => {
  const result = markdownEntriesToBundle([
    { name: `作品库 ${dbId}_all.csv`, text: "Name,Date,Published\n无题之诗,2026/10/08,No\n" },
    { name: `作品库/无题之诗 ${idA}.md`, text: "第一段，没有标题行。" },
  ]);
  const props = propsOf(result.bundle);
  assert.equal(props.Name?.title?.[0]?.plain_text, "无题之诗");
  assert.equal(props.Date?.date?.start, "2026-10-08T00:00:00.000Z");
  assert.equal(props.Published?.checkbox, false);
  assert.ok(result.warnings.some((w) => w.includes("缺少首行 # 标题，已用文件名「无题之诗」")));
  assert.equal((result.bundle.pages as { blocks: unknown[] }[])[0]!.blocks.length, 1);
});

test("a Published column that is not wholly boolean is never read as a checkbox", () => {
  const result = markdownEntriesToBundle([
    { name: `作品库 ${dbId}.csv`, text: "Name,Published,Tags\n甲,Yes,a\n乙,Draft,b\n" },
    { name: `甲 ${idA}.md`, text: "# 甲\n\n正文" },
  ]);
  assert.equal(propsOf(result.bundle).Published, undefined);
  assert.ok(result.warnings.some((w) => w.includes("「Published」列不全是勾选值")));
  assert.ok(result.warnings.some((w) => w.includes("《甲》：已从 作品库.csv 补 1 列属性（Tags）")));
});

test("unmatched and ambiguous rows fill nothing and say so", () => {
  const result = markdownEntriesToBundle([
    { name: `作品库 ${dbId}.csv`, text: "Name,Tags\n重名,a\n重名,b\n" },
    { name: `孤本 ${idA}.md`, text: "# 孤本\n\n正文" },
    { name: `重名 ${idB}.md`, text: "# 重名\n\n正文" },
  ]);
  assert.ok(result.warnings.some((w) => w === "《孤本》：CSV 中没有匹配的行，属性未补齐。"));
  assert.ok(result.warnings.some((w) => w.includes("《重名》：CSV 中有 2 行同名")));
  assert.equal(propsOf(result.bundle, 1).Tags, undefined);
});

test("a local cover in the CSV is reported rather than linked", () => {
  const result = markdownEntriesToBundle([
    { name: `作品库 ${dbId}.csv`, text: "Name,FeaturedImage\n甲,作品库/甲/cover.png\n" },
    { name: `甲 ${idA}.md`, text: "# 甲\n\n正文" },
  ]);
  assert.equal(propsOf(result.bundle).FeaturedImage, undefined);
  assert.ok(result.warnings.some((w) => w.includes("封面是导出包内的本地文件，未导入")));
});

test("CSV alone is not an import", () => {
  assert.throws(() => markdownEntriesToBundle([{ name: "a.csv", text: "Name\nx" }]), /CSV 只提供属性/);
});

test("every supported date spelling is UTC midnight, independent of the local timezone", () => {
  for (const value of ["2026-10-08", "2026/10/08", "2026.10.08", "2026年10月8日", "October 8, 2026", "Oct 8, 2026", "october 8 2026"]) {
    assert.equal(notionDateStart(value)?.start, "2026-10-08T00:00:00.000Z", value);
  }
  assert.equal(notionDateStart("September 1 2026")?.start, "2026-09-01T00:00:00.000Z");
  assert.equal(notionDateStart("Sept 1, 2026")?.start, "2026-09-01T00:00:00.000Z");
  assert.deepEqual(notionDateStart("October 8, 2026 → October 10, 2026"), { start: "2026-10-08T00:00:00.000Z", range: true });
  assert.equal(notionDateStart("2026-10-08T09:30:00+08:00")?.start, "2026-10-08T01:30:00.000Z");
  assert.equal(notionDateStart("2026-10-08T09:30")?.start, "2026-10-08T09:30:00.000Z");
  for (const bad of ["2026-02-30", "Smarch 8, 2026", "10/08/2026", "明天", ""]) assert.equal(notionDateStart(bad), null, bad);
});

test("checkbox spellings", () => {
  for (const yes of ["Yes", "true", "Y", "__YES__", "是"]) assert.equal(notionBoolean(yes), true, yes);
  for (const no of ["no", "FALSE", "n", "__NO__", "否"]) assert.equal(notionBoolean(no), false, no);
  for (const other of ["Published", "Draft", "1", ""]) assert.equal(notionBoolean(other), null, other);
});

test("a Created column is kept per page for the date backfill, but fills no property and is not reported unknown", () => {
  const dbId = "0123456789abcdef0123456789abcdef";
  const result = markdownEntriesToBundle([
    { name: `墙壁 ${id}.md`, text: "# 墙壁\n\nPublished: Yes\n\n正文" },
    { name: `无题 ${dbId}.md`, text: "# 无题\n\nPublished: Yes\nDate: 某天\n\n正文" },
    { name: `作品库 ${dbId}_all.csv`, text: "Name,创建时间,Published\n墙壁,2024年5月1日 15:04,Yes\n无题,2024年5月2日 09:00,Yes\n" },
  ]);
  assert.deepEqual(result.created, { "ce90817d-48bc-4108-9028-08c6c7bde306": "2024年5月1日 15:04" });
  const page = (result.bundle.pages as { properties: Record<string, unknown> }[])[0]!;
  assert.equal(page.properties.Date, undefined);
  assert.ok(!result.warnings.some((w) => w.includes("没有对应字段")), result.warnings.join("\n"));
  // The page whose own Date was written but unreadable is said so, and is not offered for the backfill.
  assert.ok(result.warnings.some((w) => w.includes("日期无法识别")));
});
