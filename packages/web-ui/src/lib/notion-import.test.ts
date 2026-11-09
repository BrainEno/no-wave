import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTION_LABEL,
  NOTION_BUNDLE_MAX_BYTES,
  NOTION_BUNDLE_MAX_PAGES,
  asImportReport,
  describeImport,
  issueCounts,
  readBundleFile,
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
