import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTION_LABEL,
  NOTION_BUNDLE_MAX_BYTES,
  NOTION_BUNDLE_MAX_PAGES,
  asImportReport,
  describeImport,
  issueCounts,
  importDetail,
  readBundleFile,
  indicesWithActions,
  invertSelection,
  mergeReports,
  pageKey,
  planImportBatches,
  selectBundlePages,
  reportCsv,
  reportRowMatches,
  type NotionImportAction,
  type NotionImportPage,
  type NotionImportReport,
} from "./notion-import.ts";

/**
 * The import panel's decisions, without a browser.
 *
 * Two kinds of mistake are worth a test here. The first is the one that costs an
 * author work: a file check that lets through something the API will refuse, or —
 * worse — a report that is read as "nothing to do" when the plan would write, or
 * as a plan when it already wrote. The second is the one that costs eight
 * megabytes: a file that obviously is not a bundle, sent anyway.
 *
 * What is deliberately *not* tested here is the mapping. That is the API's
 * (`notion-import.test.ts`), and this layer's job is only to say which question
 * it asked.
 */

const PAGE = { id: "page-1", properties: {}, blocks: [] };

function bundleOf(pages: unknown[]): string {
  return JSON.stringify({ version: 1, database: { id: "db-1", title: "草稿" }, pages });
}

function reportOf(overrides: Partial<NotionImportReport> = {}): NotionImportReport {
  return {
    applied: false,
    planToken: "test-preview-token",
    database: { id: "db-1", title: "草稿" },
    summary: { create: 0, update: 0, skip: 0, refused: 0, failed: 0 },
    pages: [],
    ...overrides,
  };
}

function page(action: NotionImportReport["pages"][number]["action"], issues: { code: string; detail: string }[] = []) {
  return {
    externalId: `page-${action}`,
    title: "墙",
    locale: "zh-CN",
    action,
    slug: "qiang",
    articleId: null,
    detail: `detail for ${action}`,
    issues,
  };
}

test("a bundle the API would accept is read in the browser and counted", () => {
  const read = readBundleFile({ text: bundleOf([PAGE, { ...PAGE, id: "page-2" }]), byteLength: 512 });
  if (read.ok === false) assert.fail(read.message);
  assert.equal(read.pages, 2);
  assert.equal(read.bundle.version, 1);
});

test("a bundle with no pages is a bundle: the API answers it with an empty plan", () => {
  // A local rule stricter than the endpoint's would be this file having an
  // opinion the server does not — and the page can say "nothing here" truthfully.
  const read = readBundleFile({ text: bundleOf([]), byteLength: 32 });
  if (read.ok === false) assert.fail(read.message);
  assert.equal(read.pages, 0);
});

test("a byte-order mark does not make a bundle unreadable", () => {
  const read = readBundleFile({ text: `\uFEFF${bundleOf([PAGE])}`, byteLength: 512 });
  assert.equal(read.ok, true);
});

test("a file that is not a bundle is named for what it actually is", () => {
  const cases: [string, { text: string; byteLength: number }, RegExp][] = [
    ["not JSON", { text: "{", byteLength: 1 }, /不是有效的 JSON/],
    ["not an object", { text: "[]", byteLength: 2 }, /必须是一个 JSON 对象/],
    // The easy mistake: saving the endpoint's answer instead of its bundle. It
    // parses, it is an object, and the message says which value to pick.
    [
      "a saved response",
      { text: JSON.stringify({ data: { bundle: JSON.parse(bundleOf([PAGE])) } }), byteLength: 512 },
      /导入接口的响应/,
    ],
    ["no version", { text: JSON.stringify({ pages: [PAGE] }), byteLength: 64 }, /version/],
    ["a version that is not 1", { text: JSON.stringify({ version: 2, pages: [PAGE] }), byteLength: 64 }, /version/],
    ["no pages", { text: JSON.stringify({ version: 1 }), byteLength: 64 }, /pages/],
    ["a page that is not an object", { text: bundleOf([1]), byteLength: 32 }, /pages\[0\]/],
    ["a page without an id", { text: bundleOf([{ properties: {}, blocks: [] }]), byteLength: 64 }, /pages\[0\] 缺少页面 id/],
    [
      "a page without properties",
      { text: bundleOf([{ id: "p", blocks: [] }]), byteLength: 64 },
      /pages\[0\] 缺少 properties/,
    ],
    [
      "a page without blocks",
      { text: bundleOf([{ id: "p", properties: {} }]), byteLength: 64 },
      /pages\[0\] 缺少 blocks/,
    ],
  ];
  for (const [name, input, expected] of cases) {
    const read = readBundleFile(input);
    if (read.ok) assert.fail(`${name}: the file must be refused, not read`);
    assert.match(read.message, expected, name);
  }
});

test("the second page's mistake is reported as the second page's", () => {
  const read = readBundleFile({ text: bundleOf([PAGE, { id: "page-2" }]), byteLength: 512 });
  if (read.ok) assert.fail("a page without properties must be refused");
  assert.match(read.message, /pages\[1\] 缺少 properties/);
});

test("a bundle too large or too long is refused before it is sent", () => {
  const tooLarge = readBundleFile({ text: bundleOf([PAGE]), byteLength: NOTION_BUNDLE_MAX_BYTES + 1 });
  if (tooLarge.ok) assert.fail("a bundle over the byte ceiling must be refused");
  assert.match(tooLarge.message, /8 MB/);

  const pages = Array.from({ length: NOTION_BUNDLE_MAX_PAGES + 1 }, (_, index) => ({ ...PAGE, id: `page-${index}` }));
  const tooMany = readBundleFile({ text: bundleOf(pages), byteLength: 1024 });
  if (tooMany.ok) assert.fail("a bundle over the page ceiling must be refused");
  assert.match(tooMany.message, /200 页/);
  assert.match(tooMany.message, new RegExp(String(NOTION_BUNDLE_MAX_PAGES + 1)));

  // Exactly at both ceilings is a bundle to try, not one to refuse.
  const atLimit = Array.from({ length: NOTION_BUNDLE_MAX_PAGES }, (_, index) => ({ ...PAGE, id: `page-${index}` }));
  assert.equal(readBundleFile({ text: bundleOf(atLimit), byteLength: NOTION_BUNDLE_MAX_BYTES }).ok, true);
});

test("a response that is not a report is refused rather than half-rendered", () => {
  for (const value of [null, {}, { data: {} }, { applied: "no", pages: [] }, { applied: false }, []]) {
    assert.equal(asImportReport(value), null, JSON.stringify(value));
  }
});

test("a report is read as written, and a page it cannot read is dropped", () => {
  const parsed = asImportReport({
    applied: false,
    database: { id: "db-1", title: "草稿" },
    summary: { create: 1, update: 0, skip: 0, refused: 0, failed: 0 },
    pages: [
      { ...page("create"), issues: [{ code: "media-image-not-carried", detail: "an image would break" }] },
      // Not an action the contract names: dropped rather than shown as a blank row.
      { ...page("create"), action: "exploded" },
      { ...page("create"), externalId: 42 },
    ],
  });
  assert.ok(parsed);
  assert.equal(parsed.pages.length, 1, "the two pages the contract cannot describe are dropped");
  assert.equal(parsed.pages[0]?.issues[0]?.code, "media-image-not-carried");
});

test("the summary is the API's when it is a count, and the pages' when it is not", () => {
  const fromPages = asImportReport({
    applied: false,
    database: { id: "db-1", title: null },
    pages: [page("create"), page("create"), page("skip")],
  });
  assert.ok(fromPages);
  assert.deepEqual(fromPages.summary, { create: 2, update: 0, skip: 1, refused: 0, failed: 0 });
  assert.equal(fromPages.database.title, null);

  const fromApi = asImportReport({
    applied: true,
    summary: { create: 7, update: 1, skip: 0, refused: 0, failed: 0 },
    pages: [page("create")],
  });
  assert.ok(fromApi);
  assert.equal(fromApi.summary.create, 7);
});

test("a plan that would write offers the write, and one that would not does not", () => {
  // The summary is what `describeImport` reads: it is the API's count, and the
  // page list is the detail behind it.
  const plan = describeImport(reportOf({
    summary: { create: 1, update: 1, skip: 1, refused: 0, failed: 0 },
    pages: [page("create"), page("update"), page("skip")],
  }));
  assert.equal(plan.applied, false);
  assert.equal(plan.writable, 2);
  assert.equal(plan.canApply, true);
  assert.match(plan.headline, /新建 1 件/);
  assert.match(plan.headline, /更新 1 件/);
  assert.match(plan.headline, /跳过 1 页/);
  // The sentence that has to be true: a dry run writes nothing.
  assert.match(plan.headline, /确认之前不会写入任何内容/);

  // The second import of an unchanged database: not a failure, and not a button.
  const nothing = describeImport(reportOf({ summary: { create: 0, update: 0, skip: 4, refused: 0, failed: 0 } }));
  assert.equal(nothing.canApply, false);
  assert.equal(nothing.writable, 0);
  assert.match(nothing.headline, /没有任何需要写入的内容/);
  assert.doesNotMatch(nothing.headline, /确认之前/);

  // A refusal is not a write, and it is not silent either.
  const refused = describeImport(
    reportOf({ summary: { create: 0, update: 0, skip: 0, refused: 2, failed: 1 } }),
  );
  assert.equal(refused.canApply, false);
  assert.equal(refused.attention, 3);
  assert.match(refused.headline, /拒绝 2 页/);
  assert.match(refused.headline, /失败 1 页/);
});

test("an applied report never offers the write again", () => {
  const applied = describeImport(
    reportOf({ applied: true, summary: { create: 2, update: 0, skip: 1, refused: 0, failed: 0 } }),
  );
  assert.equal(applied.applied, true);
  assert.equal(applied.canApply, false, "the same bundle imported twice is a second write of nothing");
  assert.match(applied.headline, /^已导入：新建 2 件/);
});

test("issue codes are counted once each, most frequent first", () => {
  const counts = issueCounts(reportOf({
    pages: [
      page("create", [{ code: "work-type-not-carried", detail: "" }, { code: "tag-not-carried", detail: "" }]),
      page("create", [{ code: "tag-not-carried", detail: "" }]),
      page("refused", [{ code: "provenance-conflict", detail: "" }]),
    ],
  }));
  assert.deepEqual(counts, [
    { code: "tag-not-carried", count: 2 },
    { code: "provenance-conflict", count: 1 },
    { code: "work-type-not-carried", count: 1 },
  ]);
  assert.deepEqual(issueCounts(reportOf()), []);
});

test("every action the API can report has a Chinese label", () => {
  // A page would otherwise render an empty badge for an action added to the
  // contract and forgotten here.
  assert.deepEqual(Object.keys(ACTION_LABEL).sort(), ["create", "failed", "refused", "skip", "update"]);
  for (const label of Object.values(ACTION_LABEL)) assert.ok(label !== "");
});

test("source selection keeps only checked pages, regardless of report identities", async () => {
  const { bundleSelectionPages, selectBundlePages } = await import("./notion-import.ts");
  const first = { id: "markdown-file:a.md", properties: { Name: { type: "title", title: [{ plain_text: "第一篇" }] } }, blocks: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "正文" }] } }] };
  const second = { id: "second", properties: {}, blocks: [] };
  const bundle = { version: 1, database: { id: "db" }, pages: [first, second] };
  assert.deepEqual(bundleSelectionPages(bundle), [{ index: 0, title: "第一篇", preview: "正文" }, { index: 1, title: "第 2 页", preview: "" }]);
  assert.deepEqual(selectBundlePages(bundle, new Set([1])), { ...bundle, pages: [second] });
  assert.deepEqual(selectBundlePages(bundle, new Set()), { ...bundle, pages: [] });
  assert.equal(bundle.pages.length, 2);
});


test("a preview without its authenticated token cannot be applied", () => {
  const report = asImportReport({ ...reportOf({ summary: { create: 1, update: 0, skip: 0, refused: 0, failed: 0 } }), planToken: undefined });
  assert.ok(report);
  assert.equal(describeImport(report).canApply, false);
  const bound = asImportReport({ ...report, planToken: "authentic-token", planExpiresAt: "2026-11-12T12:15:00.000Z" });
  assert.equal(bound?.planToken, "authentic-token");
  assert.equal(bound?.planExpiresAt, "2026-11-12T12:15:00.000Z");
  assert.equal(describeImport(bound!).canApply, true);
});

test("a wholly rejected apply never claims success, and partial success is explicit", () => {
  assert.match(describeImport(reportOf({ applied: true, summary: { create: 0, update: 0, skip: 0, refused: 1, failed: 0 } })).headline, /^未写入：.*重新试跑/);
  assert.match(describeImport(reportOf({ applied: true, summary: { create: 1, update: 0, skip: 0, refused: 1, failed: 0 } })).headline, /^部分导入：/);
});

test("ownership conflicts explain cross-locale refusal and retain unused-media guidance in Chinese", () => {
  const conflict = "This Notion page is already owned by another account. Nothing in this work was written; preview again.";
  assert.match(importDetail(conflict), /其他账号.*不能跨语言重新认领.*均未写入/);
  assert.match(importDetail(conflict + " Prepared images may remain in your media library; review and remove unused images."), /媒体库.*删除未使用/);
  assert.match(importDetail("The Notion page is already linked to another work or account. Nothing in this work was written; preview again."), /其他作品或账号.*均未写入/);
  assert.match(importDetail("The work or its import provenance changed. Nothing in this work was written; preview again."), /试跑后已变化.*重新试跑/);
  assert.equal(importDetail("unrecognized safe report detail"), "unrecognized safe report detail");
});

test("report rows are filtered by what they would write and what needs reading", () => {
  const row = (action: NotionImportAction, issues: { code: string; detail: string }[] = []): NotionImportPage =>
    ({ externalId: action, title: action, locale: "zh", action, slug: "", articleId: null, detail: "", issues });
  const rows = [row("create"), row("update"), row("skip"), row("skip", [{ code: "expiring-image-url", detail: "" }]), row("refused"), row("failed")];
  assert.deepEqual(rows.filter((r) => reportRowMatches(r, "changes")).map((r) => r.action), ["create", "update"]);
  assert.deepEqual(rows.filter((r) => reportRowMatches(r, "attention")).map((r) => r.action), ["skip", "refused", "failed"]);
  assert.equal(rows.filter((r) => reportRowMatches(r, "all")).length, rows.length);
});

test("report rows choose bundle indices by normalised id, never by report order", () => {
  const bundle = { pages: [{ id: "AAAA-1" }, { id: "bbbb2" }, { id: "cccc3" }, {}] };
  const report = asImportReport({ applied: false, pages: [
    { externalId: "cccc3", action: "update" }, { externalId: "aaaa1", action: "create" }, { externalId: "bbbb2", action: "skip" },
  ] })!;
  assert.deepEqual([...indicesWithActions(bundle, report, ["create", "update"])].sort(), [0, 2]);
  assert.deepEqual([...indicesWithActions(bundle, report, ["skip"])], [1]);
  assert.equal(pageKey("CE90817D-48BC-4108-9028-08C6C7BDE306"), "ce90817d48bc4108902808c6c7bde306");
});

test("invert toggles only the visible pages", () => {
  assert.deepEqual([...invertSelection(new Set([0, 1, 5]), [1, 2, 3])].sort(), [0, 2, 3, 5]);
});

test("the report CSV has one escaped row per page and cannot inject a formula", () => {
  const report = asImportReport({ applied: false, pages: [
    { externalId: "p1", title: "墙壁, 其一", locale: "zh", action: "update", slug: "wall", articleId: "a-1", detail: "", issues: [{ code: "featured-image-not-carried", detail: "1 file(s)" }] },
    { externalId: "p2", title: "=HYPERLINK(\"x\")", locale: "en", action: "refused", slug: "", articleId: null, detail: "Select all pages referenced by English before importing this work", issues: [{ code: "missing-translation-page", detail: "" }] },
  ] })!;
  const csv = reportCsv(report);
  assert.ok(csv.startsWith("\uFEFFaction,title,locale,slug,articleId,issues,detail\r\n"));
  const lines = csv.slice(1).trimEnd().split("\r\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[1], "update,\"墙壁, 其一\",zh,wall,a-1,featured-image-not-carried,1 file(s)");
  assert.ok(lines[2]!.startsWith("refused,\"'=HYPERLINK(\"\"x\"\")\",en,,,missing-translation-page,请选择 English 关联的所有页面后重新试跑。"));
});

// --- planImportBatches: the API's per-request ceilings, and translation pairs kept together ---

const pageWith = (id: string, extra: Record<string, unknown> = {}, blocks: unknown[] = []) => ({ id, properties: { Name: { type: "title", title: [{ plain_text: id }] }, ...extra }, blocks });
const notionImage = (url: string) => ({ type: "image", image: { type: "file", file: { url } } });
const all = (n: number) => new Set(Array.from({ length: n }, (_, index) => index));

test("200 pages are one batch and page 201 starts a second", () => {
  const pages = (n: number) => ({ version: 1, database: { id: "", title: null }, pages: Array.from({ length: n }, (_, i) => pageWith(`p${i}`)) });
  assert.deepEqual(planImportBatches(pages(200), all(200)).batches.map((b) => b.length), [200]);
  assert.deepEqual(planImportBatches(pages(201), all(201)).batches.map((b) => b.length), [200, 1]);
});

test("the serialised request may reach the byte ceiling exactly, but not exceed it", () => {
  const bundle = { version: 1, database: { id: "", title: null }, pages: [pageWith("a"), pageWith("b")] };
  const exact = new TextEncoder().encode(JSON.stringify({ bundle, apply: true })).length;
  assert.deepEqual(planImportBatches(bundle, all(2), { bytes: exact, pages: 200, images: 8 }).batches, [[0, 1]]);
  assert.deepEqual(planImportBatches(bundle, all(2), { bytes: exact - 1, pages: 200, images: 8 }).batches, [[0], [1]]);
  // The default ceiling is the API's own: 8 MiB of `{ bundle, apply }`.
  const big = (id: string) => pageWith(id, { Excerpt: { type: "rich_text", rich_text: [{ plain_text: "x".repeat(3 * 1024 * 1024) }] } });
  const heavy = { version: 1, database: { id: "", title: null }, pages: [big("a"), big("b"), big("c")] };
  const plan = planImportBatches(heavy, all(3));
  assert.deepEqual(plan.batches, [[0, 1], [2]]);
  for (const batch of plan.batches) assert.ok(new TextEncoder().encode(JSON.stringify({ bundle: selectBundlePages(heavy, new Set(batch)), apply: true })).length <= NOTION_BUNDLE_MAX_BYTES);
});

test("at most 8 distinct Notion images per batch; a repeated image counts once", () => {
  const pages = Array.from({ length: 9 }, (_, i) => pageWith(`p${i}`, {}, [notionImage(`https://prod-files-secure.s3.us-west-2.amazonaws.com/${i}.png`)]));
  pages.push(pageWith("again", {}, [notionImage("https://prod-files-secure.s3.us-west-2.amazonaws.com/0.png"), { type: "image", image: { type: "external", external: { url: "https://example.com/x.png" } } }]));
  const plan = planImportBatches({ version: 1, database: { id: "", title: null }, pages }, all(10));
  assert.deepEqual(plan.batches, [[0, 1, 2, 3, 4, 5, 6, 7], [8, 9]]);
});

test("a work with more than 8 images is sent alone, with a note rather than silently", () => {
  const many = pageWith("many", {}, Array.from({ length: 10 }, (_, i) => notionImage(`https://prod-files-secure.s3.amazonaws.com/${i}`)));
  const plan = planImportBatches({ version: 1, database: { id: "", title: null }, pages: [pageWith("a"), many, pageWith("b")] }, all(3));
  assert.deepEqual(plan.batches, [[0], [1], [2]]);
  assert.match(plan.notes[0]!, /10 张 Notion 图片/);
});

test("pages linked by English always share a batch, even across the page ceiling", () => {
  const zh = "11111111-1111-1111-1111-111111111111"; const en = "22222222222222222222222222222222";
  const pages = [pageWith(zh, { English: { type: "relation", relation: [{ id: en }] } }), pageWith("solo"), pageWith(en)];
  const plan = planImportBatches({ version: 1, database: { id: "", title: null }, pages }, all(3), { bytes: NOTION_BUNDLE_MAX_BYTES, pages: 2, images: 8 });
  assert.deepEqual(plan.batches, [[0, 2], [1]]);
  // Only selected pages are planned; an unselected partner is not pulled in here.
  assert.deepEqual(planImportBatches({ version: 1, database: { id: "", title: null }, pages }, new Set([0, 1])).batches, [[0, 1]]);
});

test("a work too large for any request is reported, not dropped or sent", () => {
  const pages = [pageWith("ok"), pageWith("huge", { Excerpt: { type: "rich_text", rich_text: [{ plain_text: "x".repeat(2000) }] } })];
  const plan = planImportBatches({ version: 1, database: { id: "", title: null }, pages }, all(2), { bytes: 1000, pages: 200, images: 8 });
  assert.deepEqual(plan.batches, [[0]]);
  assert.deepEqual(plan.tooLarge, [1]);
});

test("batch reports merge into one report; applied only when every batch was", () => {
  const one = asImportReport({ applied: true, summary: { create: 1, update: 0, skip: 0, refused: 0, failed: 0 }, pages: [{ externalId: "a", action: "create" }] })!;
  const two = asImportReport({ applied: false, planToken: "t", summary: { create: 0, update: 1, skip: 1, refused: 0, failed: 0 }, pages: [{ externalId: "b", action: "update" }, { externalId: "c", action: "skip" }] })!;
  const merged = mergeReports([one, two])!;
  assert.equal(merged.applied, false);
  assert.equal(merged.planToken, undefined);
  assert.deepEqual(merged.summary, { create: 1, update: 1, skip: 1, refused: 0, failed: 0 });
  assert.deepEqual(merged.pages.map((p) => p.externalId), ["a", "b", "c"]);
  assert.equal(mergeReports([]), null);
});
