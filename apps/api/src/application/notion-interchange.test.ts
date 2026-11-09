import assert from "node:assert/strict";
import test from "node:test";
import { normalizeArticleInput, validateArticleBlocks } from "../domain/article.ts";
import {
  DEFAULT_NOTION_PROPERTY_NAMES,
  articleBlocksToNotionBlocks,
  articleDraftFromNotionPage,
  notionBlocksToArticleBlocks,
  notionDateToInstant,
  notionPageFromArticleDraft,
  type NotionBlockLike,
  type NotionPageLike,
} from "./notion-interchange.ts";

/**
 * Fixtures are trimmed copies of the real database this feature was designed
 * against ("Bottom Think"), not invented shapes: the point of the suite is that
 * the author's actual payload survives the write contract.
 */
const text = (content: string, annotations: Record<string, boolean> = {}, href: string | null = null) => ({
  type: "text",
  plain_text: content,
  href,
  text: { content, link: href === null ? null : { url: href } },
  annotations: { bold: false, italic: false, underline: false, strikethrough: false, code: false, color: "default", ...annotations },
});

const paragraph = (content: string): NotionBlockLike => ({
  object: "block",
  id: "p",
  type: "paragraph",
  has_children: false,
  paragraph: { rich_text: content.length > 0 ? [text(content)] : [], color: "default" },
});

const wallPage: NotionPageLike = {
  id: "3c8315cb-0ec8-80bc-8574-e433a983d366",
  properties: {
    Page: { type: "title", title: [text("墙壁")] },
    Slug: { type: "rich_text", rich_text: [text("墙壁")] },
    Excerpt: { type: "rich_text", rich_text: [] },
    Date: { type: "date", date: { start: "2026-10-08", end: null } },
    Published: { type: "checkbox", checkbox: true },
    FeaturedImage: { type: "files", files: [] },
    Tags: { type: "multi_select", multi_select: [{ name: "诗歌" }] },
  },
};

const wallBlocks: NotionBlockLike[] = [
  paragraph("穿透层层墙壁，多重多重的缓冲"),
  paragraph("某种毫无目的的迟滞，阻拦"),
  paragraph(""),
  paragraph("还在更外层的额头。在外层，墙是洁白的"),
];

test("a real page becomes a draft the write contract accepts", () => {
  const result = articleDraftFromNotionPage({ page: wallPage, blocks: wallBlocks });
  assert.ok(result.draft, "the page has a title and a body");
  const draft = result.draft;

  assert.equal(draft.title, "墙壁");
  assert.equal(draft.summary, "");
  assert.equal(draft.locale, "zh-CN");
  assert.equal(draft.publish, true);
  assert.equal(draft.publishedAt, "2026-10-08T00:00:00.000Z", "a date-only value is UTC midnight");
  assert.equal(draft.workType, "poetry", "诗歌 is the site's own word for poetry");
  assert.deepEqual(draft.tags, ["诗歌"]);
  assert.equal(draft.contentBlocksVersion, 1);
  assert.equal(draft.contentBlocks.length, 3, "the empty spacer paragraph is dropped, not invented");

  // The strongest assertion in the file: the author's own payload is accepted by
  // the same validator a hand-written article goes through.
  const normalized = normalizeArticleInput({
    slug: draft.slug,
    title: draft.title,
    summary: draft.summary,
    locale: draft.locale,
    contentBlocks: draft.contentBlocks,
    contentBlocksVersion: draft.contentBlocksVersion,
    publish: draft.publish,
    workType: draft.workType,
  });
  assert.equal(normalized.contentBlocks.length, 3);
  assert.equal(normalized.slug, "qiangbi", "「墙壁」 has no ASCII form, so the title is transliterated");
});

test("the CJK slug property is replaced by a derived address, and said so", () => {
  const result = articleDraftFromNotionPage({ page: wallPage, blocks: wallBlocks });
  assert.ok(result.draft);
  assert.equal(result.draft.slug, "qiangbi");
  assert.deepEqual(
    result.issues.filter((issue) => issue.code === "slug-derived").map((issue) => issue.detail),
    ["墙壁 -> qiangbi"],
  );
});

test("an ASCII slug the author already chose is kept verbatim", () => {
  const page: NotionPageLike = {
    ...wallPage,
    properties: { ...wallPage.properties, Slug: { type: "rich_text", rich_text: [text("the-wall")] } },
  };
  const result = articleDraftFromNotionPage({ page, blocks: wallBlocks });
  assert.ok(result.draft);
  assert.equal(result.draft.slug, "the-wall");
  assert.equal(result.issues.some((issue) => issue.code === "slug-derived"), false);
});

test("a blank English edition is refused instead of invented", () => {
  // The linked "Aircraft" page: English title, no body, not published, no date.
  const page: NotionPageLike = {
    id: "410315cb-0ec8-80cb-bc30-e8bd101ad535",
    properties: {
      Page: { type: "title", title: [text("Aircraft")] },
      Slug: { type: "rich_text", rich_text: [] },
      Published: { type: "checkbox", checkbox: false },
      Date: { type: "date", date: null },
      Tags: { type: "multi_select", multi_select: [] },
    },
  };
  const result = articleDraftFromNotionPage({ page, blocks: [], options: { locale: "en" } });
  assert.equal(result.draft, null);
  assert.deepEqual(result.issues.map((issue) => issue.code), ["empty-body"]);
});

test("headings shift by one and list rows become one list", () => {
  const { blocks, issues } = notionBlocksToArticleBlocks([
    { id: "1", type: "heading_1", heading_1: { rich_text: [text("一")] } },
    { id: "2", type: "heading_2", heading_2: { rich_text: [text("二")] } },
    { id: "3", type: "heading_3", heading_3: { rich_text: [text("三")] } },
    { id: "4", type: "bulleted_list_item", bulleted_list_item: { rich_text: [text("甲")] } },
    { id: "5", type: "bulleted_list_item", bulleted_list_item: { rich_text: [text("乙")] } },
    { id: "6", type: "numbered_list_item", numbered_list_item: { rich_text: [text("丙")] } },
  ]);
  assert.deepEqual(issues, []);
  assert.deepEqual(blocks.map((block) => block.type), ["heading", "heading", "heading", "list", "list"]);
  assert.deepEqual(blocks.map((block) => block.level), [2, 3, 4, undefined, undefined]);
  assert.deepEqual(blocks[3]?.items, ["甲", "乙"]);
  assert.equal(blocks[3]?.ordered, false);
  assert.deepEqual(blocks[4]?.items, ["丙"]);
  assert.equal(blocks[4]?.ordered, true, "a different kind of list is a different block");
  for (const block of blocks) validateArticleBlocks([block], 1);
});

test("inline marks and links survive as runs whose text matches the block text", () => {
  const { blocks } = notionBlocksToArticleBlocks([
    {
      id: "q",
      type: "paragraph",
      paragraph: {
        rich_text: [
          text("加粗", { bold: true }),
          text("与斜体", { italic: true, code: true }),
          text("链接", {}, "https://example.com/a"),
        ],
      },
    },
  ]);
  const block = blocks[0]!;
  assert.equal(block.text, "加粗与斜体链接");
  assert.deepEqual(block.inlines, [
    { text: "加粗", marks: ["bold"] },
    { text: "与斜体", marks: ["italic", "code"] },
    { text: "链接", href: "https://example.com/a" },
  ]);
  validateArticleBlocks([block], 1);
});

test("blocks with no equivalent keep their text or are reported, never silently lost", () => {
  const signed = "https://prod-files-secure.s3.amazonaws.com/x/y.jpeg?X-Amz-Expires=3600";
  const { blocks, issues } = notionBlocksToArticleBlocks([
    { id: "c", type: "callout", callout: { rich_text: [text("提示")] } },
    { id: "t", type: "toggle", toggle: { rich_text: [text("展开")] } },
    { id: "d", type: "to_do", to_do: { rich_text: [text("待办")], checked: true } },
    { id: "b", type: "bookmark", bookmark: { url: "https://example.com/read" } },
    { id: "e", type: "equation", equation: { expression: "e=mc^2" } },
    { id: "i", type: "image", image: { type: "file", file: { url: signed }, caption: [text("图注")] } },
    { id: "tbl", type: "table", table: { table_width: 2 } },
    { id: "ch", type: "child_page", child_page: { title: "子页面" } },
    { id: "hr", type: "divider", divider: {} },
  ]);

  assert.deepEqual(blocks.map((block) => block.type), ["paragraph", "paragraph", "paragraph", "paragraph", "paragraph", "image"]);
  assert.equal(blocks[3]?.text, "https://example.com/read", "a bookmark stays readable");
  assert.deepEqual(blocks[3]?.inlines, [{ text: "https://example.com/read", href: "https://example.com/read" }]);
  assert.equal(blocks[4]?.text, "e=mc^2");
  assert.deepEqual(blocks[5], { id: "block-6", type: "image", src: signed, alt: "图注", caption: "图注" });

  const codes = issues.map((issue) => issue.code).sort();
  assert.deepEqual(codes, [
    "callout-flattened",
    "checkbox-state-dropped",
    "equation-flattened",
    "expiring-image-url",
    "link-block-flattened",
    "table-block-dropped",
    "toggle-flattened",
    "unsupported-block",
  ]);
  // The signed URL is called out: storing it verbatim would 403 within the hour.
  assert.equal(issues.find((issue) => issue.code === "expiring-image-url")?.detail, signed);
  for (const block of blocks) validateArticleBlocks([block], 1);
});

test("a page with only unsupported blocks is an empty body, not an empty article", () => {
  const page: NotionPageLike = { id: "x", properties: { Page: { type: "title", title: [text("只有表格")] } } };
  const result = articleDraftFromNotionPage({
    page,
    blocks: [{ id: "t", type: "table", table: { table_width: 2 } }],
  });
  assert.equal(result.draft, null);
  assert.deepEqual(result.issues.map((issue) => issue.code), ["table-block-dropped", "empty-body"]);
});

test("the 200-block limit truncates instead of failing", () => {
  const blocks = Array.from({ length: 205 }, (_, index) => paragraph(`第${index}段`));
  const { blocks: converted, issues } = notionBlocksToArticleBlocks(blocks);
  assert.equal(converted.length, 200);
  assert.equal(issues.filter((issue) => issue.code === "block-limit-reached").length, 1);
});

test("a published page with no date is dated by the injected clock", () => {
  const page: NotionPageLike = {
    ...wallPage,
    properties: { ...wallPage.properties, Date: { type: "date", date: null } },
  };
  const result = articleDraftFromNotionPage({
    page,
    blocks: wallBlocks,
    options: { now: () => new Date("2026-11-03T04:05:06.789Z") },
  });
  assert.ok(result.draft);
  assert.equal(result.draft.publishedAt, "2026-11-03T04:05:06.789Z");
});

test("an unpublished undated draft keeps a null instant", () => {
  const page: NotionPageLike = {
    ...wallPage,
    properties: {
      ...wallPage.properties,
      Published: { type: "checkbox", checkbox: false },
      Date: { type: "date", date: null },
    },
  };
  const result = articleDraftFromNotionPage({ page, blocks: wallBlocks });
  assert.ok(result.draft);
  assert.equal(result.draft.publish, false);
  assert.equal(result.draft.publishedAt, null);
});

test("property names are options, because the next database is not this one", () => {
  const page: NotionPageLike = {
    id: "custom",
    properties: {
      Name: { type: "title", title: [text("Custom")] },
      Handle: { type: "rich_text", rich_text: [text("custom-handle")] },
      Abstract: { type: "rich_text", rich_text: [text("一段摘要")] },
      Kind: { type: "multi_select", multi_select: [{ name: "散文" }] },
    },
  };
  const result = articleDraftFromNotionPage({
    page,
    blocks: [paragraph("正文")],
    options: { propertyNames: { slug: "Handle", summary: "Abstract", tags: "Kind" } },
  });
  assert.ok(result.draft);
  assert.equal(result.draft.slug, "custom-handle");
  assert.equal(result.draft.summary, "一段摘要");
  assert.equal(result.draft.workType, "essay");
});

test("an untagged or unknown-tagged work falls back to a stated default", () => {
  const page: NotionPageLike = {
    ...wallPage,
    properties: { ...wallPage.properties, Tags: { type: "multi_select", multi_select: [{ name: "随笔集" }] } },
  };
  const result = articleDraftFromNotionPage({ page, blocks: wallBlocks });
  assert.ok(result.draft);
  assert.equal(result.draft.workType, "other");
  assert.deepEqual(result.issues.filter((issue) => issue.code === "work-type-fallback").map((issue) => issue.detail), ["随笔集"]);
});

test("a featured image is reported, because an article has no cover field", () => {
  const page: NotionPageLike = {
    ...wallPage,
    properties: {
      ...wallPage.properties,
      FeaturedImage: { type: "files", files: [{ name: "a.jpeg", type: "file", file: { url: "https://s3.example.com/a.jpeg?X-Amz-Expires=3600" } }] },
    },
  };
  const result = articleDraftFromNotionPage({ page, blocks: wallBlocks });
  assert.ok(result.draft);
  assert.deepEqual(
    result.issues.filter((issue) => issue.code === "featured-image-not-carried").map((issue) => issue.detail),
    ["1 file(s) (signed URL, expires)"],
  );
});

test("dates read as UTC, whether they carry a zone or only a calendar day", () => {
  assert.equal(notionDateToInstant({ start: "2026-10-08" }), "2026-10-08T00:00:00.000Z");
  assert.equal(notionDateToInstant({ start: "2026-10-08T09:30:00.000Z" }), "2026-10-08T09:30:00.000Z");
  assert.equal(notionDateToInstant({ start: "2026-10-08T09:30:00+08:00" }), "2026-10-08T01:30:00.000Z");
  assert.equal(notionDateToInstant({ start: "2026-10-08T09:30:00" }), "2026-10-08T09:30:00.000Z");
  assert.equal(notionDateToInstant({ start: null }), null);
  assert.equal(notionDateToInstant(null), null);
});

test("export writes the properties the mapping owns and nothing it does not", () => {
  const result = articleDraftFromNotionPage({ page: wallPage, blocks: wallBlocks });
  assert.ok(result.draft);
  const exported = notionPageFromArticleDraft(result.draft);
  assert.deepEqual(exported.properties.Page, {
    type: "title",
    title: [text("墙壁")],
  });
  assert.equal((exported.properties[DEFAULT_NOTION_PROPERTY_NAMES.slug] as { rich_text: { plain_text: string }[] }).rich_text[0]?.plain_text, "qiangbi");
  assert.deepEqual(exported.properties[DEFAULT_NOTION_PROPERTY_NAMES.date], { type: "date", date: { start: "2026-10-08" } });
  assert.deepEqual(exported.properties[DEFAULT_NOTION_PROPERTY_NAMES.published], { type: "checkbox", checkbox: true });
  assert.deepEqual(exported.properties[DEFAULT_NOTION_PROPERTY_NAMES.tags], { type: "multi_select", multi_select: [{ name: "诗歌" }] });
  assert.equal(exported.children.length, 3);
  assert.equal(exported.children[0]?.type, "paragraph");
  assert.deepEqual(exported.issues, []);
});

test("a round trip through Notion returns the same content", () => {
  const source = articleDraftFromNotionPage({ page: wallPage, blocks: wallBlocks });
  assert.ok(source.draft);

  const exported = notionPageFromArticleDraft(source.draft);
  // Notion would return the page it stored; feed the same shape back in.
  const reimported = articleDraftFromNotionPage({
    page: { id: wallPage.id, properties: exported.properties as NotionPageLike["properties"] },
    blocks: exported.children,
  });
  assert.ok(reimported.draft);
  assert.equal(reimported.draft.title, source.draft.title);
  assert.equal(reimported.draft.summary, source.draft.summary);
  assert.equal(reimported.draft.publishedAt, source.draft.publishedAt);
  assert.equal(reimported.draft.publish, source.draft.publish);
  assert.deepEqual(reimported.draft.tags, source.draft.tags);
  assert.equal(reimported.draft.workType, source.draft.workType);
  // Block ids are regenerated by design (they are addresses inside one document),
  // so the comparison is on what a reader would see.
  const shape = (blocks: Record<string, unknown>[]) =>
    blocks.map((block) => ({ type: block.type, text: block.text, level: block.level, inlines: block.inlines }));
  assert.deepEqual(shape(reimported.draft.contentBlocks), shape(source.draft.contentBlocks));
});

test("lists, code and images survive the round trip too", () => {
  const { blocks } = notionBlocksToArticleBlocks([
    { id: "h", type: "heading_2", heading_2: { rich_text: [text("小标题")] } },
    { id: "l1", type: "bulleted_list_item", bulleted_list_item: { rich_text: [text("一", { bold: true })] } },
    { id: "l2", type: "bulleted_list_item", bulleted_list_item: { rich_text: [text("二")] } },
    { id: "code", type: "code", code: { rich_text: [text("const a = 1;")], language: "typescript" } },
    { id: "img", type: "image", image: { type: "external", external: { url: "https://example.com/a.png" }, caption: [] } },
  ]);
  const exported = articleBlocksToNotionBlocks(blocks);
  // heading_2 is the site's level 3, so it leaves as heading_2 again.
  assert.deepEqual(exported.blocks.map((block) => block.type), ["heading_2", "bulleted_list_item", "bulleted_list_item", "code", "image"]);
  assert.equal((exported.blocks[1]!.bulleted_list_item as { rich_text: { annotations: { bold: boolean } }[] }).rich_text[0]!.annotations.bold, true);
  assert.equal((exported.blocks[3]!.code as { language: string }).language, "typescript");

  const back = notionBlocksToArticleBlocks(exported.blocks);
  assert.deepEqual(back.blocks.map((block) => block.type), ["heading", "list", "code", "image"]);
  assert.deepEqual(back.blocks[1]?.items, ["一", "二"]);
  assert.deepEqual(back.blocks[1]?.itemInlines?.[0], [{ text: "一", marks: ["bold"] }]);
  assert.deepEqual(back.issues, []);
});
