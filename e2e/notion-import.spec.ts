import { randomUUID } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { expect, type Page } from "@playwright/test";
import { test } from "./support/csp-fixture.ts";
import type { NotionImportReport } from "../packages/web-ui/src/lib/notion-import.ts";
import { registerThroughForm, uniqueEmail } from "./support/accounts.ts";
import { mockNotionImport, titleOf } from "./support/notion-import-mock.ts";

/**
 * Importing a Notion bundle from the desk (ADR 0036, phase 4).
 *
 * What this file can see that the cheaper layers cannot: that the page exists at
 * the URL the desk links to, that a visitor who is not signed in is sent to sign
 * in *and pointed back*, and — the journey worth having — that choosing a file
 * reads it in the browser, asks the API for a plan, shows that plan, and only
 * writes after a second, explicit press. The proxy tests prove the request, the
 * API tests prove the mapping; neither can see that the two are wired to a file
 * input and a button.
 *
 * The bundle is inline rather than a fixture file: it is the smallest document
 * the mapping accepts (one page, one title, one block), and a test that has to
 * open a directory to know what it imported is harder to read than one that says
 * so here.
 */

const TITLE = "从 Notion 来的作品";
const BODY = "第一段正文，来自 bundle。";

function richText(content: string) {
  return {
    type: "text",
    plain_text: content,
    href: null,
    text: { content, link: null },
    annotations: { bold: false, italic: false, underline: false, strikethrough: false, code: false, color: "default" },
  };
}

const BUNDLE = {
  version: 1,
  database: { id: "e2e-database", title: "E2E 草稿库" },
  pages: [
    {
      id: "e2e-page-1",
      properties: {
        // The title property is found by type, not by name — every Notion
        // database names it differently and this one is called `Page`.
        Page: { type: "title", title: [richText(TITLE)] },
        // A draft: this test is about the import, not about publishing.
        Published: { type: "checkbox", checkbox: false },
      },
      blocks: [
        {
          object: "block",
          id: "e2e-block-1",
          type: "paragraph",
          has_children: false,
          paragraph: { rich_text: [richText(BODY)], color: "default" },
        },
      ],
    },
  ],
};

function bundleFile() {
  // External page IDs are globally owned, not scoped to a test account. Give
  // each journey (and retry) its own identity, but reuse the returned file when
  // checking that a second import of the same page is skipped.
  const bundle = { ...BUNDLE, pages: BUNDLE.pages.map((page) => ({ ...page, id: randomUUID() })) };
  return {
    name: "notion-bundle.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(bundle), "utf8"),
  };
}

async function selectAllAndPreview(page: Page) {
  // Every page starts selected; the plan is still shown before anything is written.
  await expect(page.getByRole("button", { name: "全选", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "试跑所选文章" }).click();
}

test("an anonymous visitor is sent to sign in, and pointed back afterwards", async ({ page }) => {
  await page.goto("/write/notion");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fwrite%2Fnotion/);
  await expect(page.getByLabel("邮箱")).toBeVisible();
});

test("the writing desk links to the import", async ({ page }) => {
  await registerThroughForm(page, uniqueEmail("notion-desk"), "/write");
  // A new account has no works, so the empty list offers the same destination.
  await expect(page.getByRole("link", { name: /从 Notion 导入第一批/ })).toHaveAttribute("href", "/write/notion");
  // The header entry reads "导入文章" first and keeps the source as its sub-label.
  const entry = page.getByRole("navigation", { name: "写作台去处" }).getByRole("link", { name: "从 Notion 导入" });
  await expect(entry).toContainText("导入文章");
  await entry.click();
  await expect(page).toHaveURL(/\/write\/notion$/);
  await expect(page.getByRole("heading", { name: /从 Notion 导入/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "回到写作台" })).toBeVisible();
});

test("choosing a bundle shows the plan, and only the confirm button writes it", async ({ page }) => {
  const file = bundleFile();
  await registerThroughForm(page, uniqueEmail("notion-import"), "/write/notion");

  // The panel is client-rendered: this is the empty state, after hydration.
  await expect(page.getByText("还没有选择文件")).toBeVisible();
  await page.setInputFiles("#notion-bundle-file", file);
  await selectAllAndPreview(page);

  // The dry run's answer, before anything is written.
  await expect(page.getByText(/计划：新建 1 件、更新 0 件、跳过 0 页/)).toBeVisible();
  await expect(page.getByText(/确认之前不会写入任何内容/)).toBeVisible();
  await expect(page.locator(".nw-import-report").getByText(TITLE, { exact: true })).toBeVisible();

  // Nothing has been written yet: the desk does not have the work.
  await page.goto("/write");
  await expect(page.getByText(TITLE)).toHaveCount(0);

  await page.goto("/write/notion");
  await page.setInputFiles("#notion-bundle-file", file);
  await selectAllAndPreview(page);
  await expect(page.getByText(/计划：新建 1 件/)).toBeVisible();
  await page.getByRole("button", { name: /确认导入（写入 1 件作品）/ }).click();

  // The same page list, now saying what happened.
  await expect(page.getByText(/已导入：新建 1 件/)).toBeVisible();
  await expect(page.getByRole("button", { name: /确认导入/ })).toHaveCount(0);

  // The URL can change before the outgoing report unmounts. Only the desk's
  // persisted work list and reopening its content prove the import committed.
  await page.getByRole("link", { name: "去看写作台" }).click();
  await expect(page).toHaveURL(/\/write$/);
  const works = page.getByRole("complementary", { name: "我的作品", exact: true });
  const imported = works.getByRole("button", { name: new RegExp(`^${TITLE} 草稿`) });
  await expect(imported).toHaveCount(1);
  await imported.click();
  await expect(page.getByRole("textbox", { name: "标题", exact: true })).toHaveValue(TITLE);
  await expect(page.getByRole("textbox", { name: "作品正文", exact: true })).toContainText(BODY);
});

test("importing the same file twice writes nothing the second time", async ({ page }) => {
  const file = bundleFile();
  await registerThroughForm(page, uniqueEmail("notion-twice"), "/write/notion");

  await page.setInputFiles("#notion-bundle-file", file);
  await selectAllAndPreview(page);
  await expect(page.getByText(/计划：新建 1 件、更新 0 件、跳过 0 页/)).toBeVisible();
  await page.getByRole("button", { name: /确认导入/ }).click();
  await expect(page.getByText(/已导入：新建 1 件/)).toBeVisible();

  await page.setInputFiles("#notion-bundle-file", file);
  await selectAllAndPreview(page);
  // The server remembers the digest of what it imported, so the second plan is
  // "nothing to do" rather than a second copy of the same work.
  await expect(page.getByText(/计划：新建 0 件、更新 0 件、跳过 1 页/)).toBeVisible();
  await expect(page.getByText(/没有任何需要写入的内容/)).toBeVisible();
  await expect(page.getByRole("button", { name: /确认导入/ })).toHaveCount(0);
});

test("multiple Notion Markdown files are previewed before import", async ({ page }) => {
  await registerThroughForm(page, uniqueEmail("notion-md"), "/write/notion");
  const id1 = randomUUID().replaceAll("-", "");
  const id2 = randomUUID().replaceAll("-", "");
  await page.setInputFiles("#notion-bundle-file", [
    { name: `第一篇 ${id1}.md`, mimeType: "text/markdown", buffer: Buffer.from("# 第一篇\n\nPublished: No\nTags: 诗歌\n\n第一篇正文") },
    { name: `第二篇 ${id2}.md`, mimeType: "text/markdown", buffer: Buffer.from("# 第二篇\n\n第二篇正文") },
  ]);
  await selectAllAndPreview(page);
  await expect(page.getByText(/计划：新建 2 件/)).toBeVisible();
  await page.getByRole("button", { name: /确认导入/ }).click();
  await expect(page.getByText(/已导入：新建 2 件/)).toBeVisible();
  await page.getByRole("link", { name: "去看写作台" }).click();
  await expect(page).toHaveURL(/\/write$/);
  // A client-side URL change may overlap the outgoing import report. Only
  // persisted entries in the desk's own work list prove this import succeeded.
  const works = page.getByRole("complementary", { name: "我的作品", exact: true });
  await expect(works.getByRole("button", { name: /^第一篇 草稿/ })).toBeVisible();
  await expect(works.getByRole("button", { name: /^第二篇 草稿/ })).toBeVisible();
  await expect(works.getByRole("button", { name: /^(第一篇|第二篇) 草稿/ })).toHaveCount(2);
});


test("a ZIP export discovers Markdown articles", async ({ page }) => {
  await registerThroughForm(page, uniqueEmail("notion-zip"), "/write/notion");
  const id = randomUUID().replaceAll("-", "");
  const archive = zipSync({ [`export/压缩文章 ${id}.md`]: strToU8("# 压缩文章\n\n正文来自 ZIP"), "export/readme.txt": strToU8("ignored") });
  await page.setInputFiles("#notion-bundle-file", { name: "export.zip", mimeType: "application/zip", buffer: Buffer.from(archive) });
  await selectAllAndPreview(page);
  await expect(page.getByText(/计划：新建 1 件/)).toBeVisible();
  await expect(page.locator(".nw-import-report").getByText("压缩文章", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /确认导入/ }).click();
  await expect(page.getByText(/已导入：新建 1 件/)).toBeVisible();
});

test("properties from the database CSV in a ZIP export are carried into the import", async ({ page }) => {
  await registerThroughForm(page, uniqueEmail("notion-csv"), "/write/notion");
  // Client-side journey: the endpoint is stood in for (see support/notion-import-mock.ts);
  // what the server does with these properties is the planner's, tested there.
  const writes = await mockNotionImport(page);
  // Notion's "Markdown & CSV" export: the page files often carry no property
  // lines at all, and the database's properties live in "X_all.csv" (every
  // column) beside "X.csv" (the view's visible columns only).
  const db = randomUUID().replaceAll("-", "");
  const id = randomUUID().replaceAll("-", "");
  const zip = zipSync({
    [`导出/作品库 ${db}.csv`]: strToU8("Name,Tags\nCSV 属性作品,诗歌"),
    [`导出/作品库 ${db}_all.csv`]: strToU8(`\uFEFFName,Date,Excerpt,Published,Slug,Tags\r\nCSV 属性作品,2026年10月8日,"来自 CSV 的摘要, 含逗号",是,csv-work,"诗歌, 实验"\r\n`),
    [`导出/作品库/CSV 属性作品 ${id}.md`]: strToU8("# CSV 属性作品\n\n正文只在 Markdown 里。"),
  });
  await page.setInputFiles("#notion-bundle-file", { name: "export.zip", mimeType: "application/zip", buffer: Buffer.from(zip) });
  await expect(page.getByText(/《CSV 属性作品》：已从 作品库\.csv 补 5 列属性.*请核对/)).toBeVisible();
  await selectAllAndPreview(page);
  await expect(page.getByText(/计划：新建 1 件/)).toBeVisible();
  await page.getByRole("button", { name: /确认导入/ }).click();
  await expect(page.getByText(/已导入：新建 1 件/)).toBeVisible();
  const expected = {
    Date: { date: { start: "2026-10-08T00:00:00.000Z" } },
    Excerpt: { rich_text: [{ plain_text: "来自 CSV 的摘要, 含逗号" }] },
    Published: { checkbox: true },
    Slug: { rich_text: [{ plain_text: "csv-work" }] },
    Tags: { multi_select: [{ name: "诗歌" }, { name: "实验" }] },
  };
  // The dry run and the confirmed write carry the same filled properties.
  expect(writes.map((request) => request.apply === true)).toEqual([false, true]);
  for (const request of writes) expect(request.bundle.pages[0]?.properties).toMatchObject(expected);
});

test("ZIP selection previews and writes only checked pages, and changing it invalidates the plan", async ({ page }) => {
  await registerThroughForm(page, uniqueEmail("notion-zip-pick"), "/write/notion");
  const ids = Array.from({ length: 3 }, () => randomUUID().replaceAll("-", ""));
  const zip = zipSync({
    [`export/保留甲 ${ids[0]}.md`]: strToU8("# 保留甲\n\nRank: 1\n\n正文甲"),
    [`export/不导入 ${ids[1]}.md`]: strToU8("# 不导入\n\n不想导入的正文"),
    [`export/保留乙 ${ids[2]}.md`]: strToU8("# 保留乙\n\n正文乙"),
  });
  const writes: { bundle: { pages: { id: string }[] }; apply?: boolean }[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/authoring/notion-import") && request.method() === "POST") writes.push(request.postDataJSON());
  });
  await page.setInputFiles("#notion-bundle-file", { name: "export.zip", mimeType: "application/zip", buffer: Buffer.from(zip) });
  // Every page starts checked; unchecking is how a page is left out.
  for (const title of ["保留甲", "不导入", "保留乙"]) await expect(page.getByLabel(title, { exact: true })).toBeChecked();
  await expect(page.getByText("已选 3 / 3 页", { exact: false })).toBeVisible();
  await expect(page.getByText(/Rank 没有对应字段/)).toHaveCount(0);
  await page.getByLabel("保留乙", { exact: true }).uncheck();
  await page.getByRole("button", { name: "试跑所选文章" }).click();
  await expect(page.getByText(/计划：新建 2 件/)).toBeVisible();
  await page.getByLabel("不导入", { exact: true }).uncheck();
  await expect(page.getByRole("button", { name: /确认导入/ })).toHaveCount(0);
  await page.getByLabel("保留乙", { exact: true }).check();
  await page.getByRole("button", { name: "试跑所选文章" }).click();
  await expect(page.getByText(/计划：新建 2 件/)).toBeVisible();
  await page.getByRole("button", { name: /确认导入/ }).click();
  await expect(page.getByText(/已导入：新建 2 件/)).toBeVisible();
  const applied = writes.find((request) => request.apply === true);
  assertSelectedPages(applied, [ids[0]!, ids[2]!]);
  await page.getByRole("link", { name: "去看写作台" }).click();
  await expect(page).toHaveURL(/\/write$/);
  await expect(page.locator(".nw-import-report")).toHaveCount(0);
  await expect(page.getByText("保留甲", { exact: true })).toBeVisible();
  await expect(page.getByText("保留乙", { exact: true })).toBeVisible();
  await expect(page.getByText("不导入", { exact: true })).toHaveCount(0);
});

test("selection tools, report filters, one-click reselection, the report CSV and another batch", async ({ page }) => {
  await registerThroughForm(page, uniqueEmail("notion-tools"), "/write/notion");
  const ids = Array.from({ length: 4 }, () => randomUUID());
  const [fresh, changed, same, refused] = ids as [string, string, string, string];
  // The stand-in answers like the API would for an export that was imported
  // before: one new page, one changed, one unchanged, one refused.
  const writes = await mockNotionImport(page, (request) => request.bundle.pages.map((source) => {
    const key = source.id;
    const base = { externalId: key, title: titleOf(source), locale: "zh-CN", detail: "", issues: [] as { code: string; detail: string }[], articleId: null as string | null, slug: "" };
    if (key === changed) return { ...base, action: "update" as const, articleId: "work-1", slug: "old-slug" };
    if (key === same) return { ...base, action: "skip" as const, articleId: "work-2", slug: "same" };
    if (key === refused) return { ...base, action: "refused" as const, issues: [{ code: "missing-translation-page", detail: "Select all pages referenced by English before importing this work" }] };
    return { ...base, action: "create" as const, slug: "fresh" };
  }));
  const titles = ["新的一篇", "改过的一篇", "没变的一篇", "缺译文的一篇"];
  await page.setInputFiles("#notion-bundle-file", ids.map((id, index) => ({
    name: `${titles[index]} ${id.replaceAll("-", "")}.md`, mimeType: "text/markdown", buffer: Buffer.from(`# ${titles[index]}\n\n正文 ${index}`),
  })));
  await expect(page.getByText("已选 4 / 4 页", { exact: false })).toBeVisible();
  // Title search narrows the list, and the bulk buttons act on what is shown.
  await page.getByLabel("按标题筛选").fill("一篇");
  await page.getByLabel("按标题筛选").fill("改过");
  await expect(page.getByText(/筛选出 1 页/)).toBeVisible();
  await page.getByRole("button", { name: "清空", exact: true }).click();
  await expect(page.getByText("已选 3 / 4 页", { exact: false })).toBeVisible();
  await page.getByLabel("按标题筛选").fill("");
  await page.getByRole("button", { name: "反选", exact: true }).click();
  await expect(page.getByText("已选 1 / 4 页", { exact: false })).toBeVisible();
  await expect(page.getByLabel("改过的一篇", { exact: true })).toBeChecked();
  await page.getByRole("button", { name: "全选", exact: true }).click();
  await expect(page.getByText("已选 4 / 4 页", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "试跑所选文章" }).click();
  await expect(page.getByText(/计划：新建 1 件、更新 1 件、跳过 1 页、拒绝 1 页/)).toBeVisible();
  const report = page.locator(".nw-import-report");
  await expect(report.getByText("将更新：已有作品 · /old-slug")).toBeVisible();
  await report.getByRole("button", { name: /^需要确认/ }).click();
  await expect(report.locator(".nw-import-page")).toHaveCount(1);
  await expect(report.getByText("缺译文的一篇", { exact: true })).toBeVisible();
  await report.getByRole("button", { name: /^新增\/有变化/ }).click();
  await expect(report.locator(".nw-import-page")).toHaveCount(2);

  const download = page.waitForEvent("download");
  await report.getByRole("button", { name: "下载报告 CSV" }).click();
  const csv = await (await download).createReadStream().then(async (stream) => {
    const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(chunk as Buffer); return Buffer.concat(chunks).toString("utf8");
  });
  expect(csv.replace(/^\uFEFF/, "").split("\r\n")[0]).toBe("action,title,locale,slug,articleId,issues,detail");
  expect(csv).toContain("refused,缺译文的一篇,zh-CN,,,missing-translation-page,请选择 English 关联的所有页面后重新试跑。");

  // One click narrows the selection to what would be written and plans it again.
  await page.getByRole("button", { name: "只导入会新建或更新的（2 页）" }).click();
  await expect(page.getByText(/计划：新建 1 件、更新 1 件、跳过 0 页/)).toBeVisible();
  expect(writes.at(-1)!.bundle.pages.map((source) => source.id).sort()).toEqual([fresh, changed].sort());
  await expect(page.getByRole("button", { name: "全选（含无变化的）" })).toBeVisible();
  await page.getByRole("button", { name: /确认导入（写入 2 件作品）/ }).click();
  await expect(page.getByText(/已导入：新建 1 件、更新 1 件/)).toBeVisible();
  expect(writes.map((request) => request.apply === true)).toEqual([false, false, true]);
  await expect(page.getByRole("link", { name: "去看写作台" })).toBeVisible();
  // "Another batch" leaves this result behind and offers the file picker again.
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "再导入一批" }).click();
  await chooser;
  await expect(page.locator(".nw-import-report")).toHaveCount(0);
  await expect(page.getByText("还没有选择文件")).toBeVisible();
});

function assertSelectedPages(request: { bundle: { pages: { id: string }[] } } | undefined, ids: string[]) {
  expect(request).toBeDefined();
  expect(request!.bundle.pages.map((page) => page.id.replaceAll("-", "")).sort()).toEqual([...ids].sort());
}

test("a selected page with a missing English relation is refused before writing", async ({ page }) => {
  await registerThroughForm(page, uniqueEmail("notion-related-pick"), "/write/notion");
  const zh = randomUUID().replaceAll("-", "");
  const en = randomUUID().replaceAll("-", "");
  await page.setInputFiles("#notion-bundle-file", [
    { name: `关联原文 ${zh}.md`, mimeType: "text/markdown", buffer: Buffer.from(`# 关联原文\n\nEnglish: English (English%20${en}.md)\n\n中文正文`) },
    { name: `English ${en}.md`, mimeType: "text/markdown", buffer: Buffer.from("# English\n\nEnglish text") },
  ]);
  // Choosing a page brings its English counterpart along, and says so.
  await page.getByRole("button", { name: "清空", exact: true }).click();
  await page.getByLabel("关联原文", { exact: true }).check();
  await expect(page.getByText("已自动为你勾上对照的英文页：《English》。")).toBeVisible();
  await expect(page.getByLabel("English", { exact: true })).toBeChecked();
  // Unchecking it on purpose is respected; the row warns, and the API still refuses the work.
  await page.getByLabel("English", { exact: true }).uncheck();
  await expect(page.getByText("对照的英文页《English》未勾选：试跑时这件作品会被拒绝。")).toBeVisible();
  await page.getByRole("button", { name: "试跑所选文章" }).click();
  await expect(page.locator(".nw-import-report").getByText("missing-translation-page", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /确认导入/ })).toHaveCount(0);
  await page.getByRole("button", { name: "一并勾上《English》" }).click();
  await expect(page.getByLabel("English", { exact: true })).toBeChecked();
  await page.getByRole("button", { name: "试跑所选文章" }).click();
  await expect(page.getByRole("button", { name: /确认导入/ })).toBeVisible();
});


test("a page whose English counterpart is not in the export is marked before anything is sent", async ({ page }) => {
  await registerThroughForm(page, uniqueEmail("notion-needs-en"), "/write/notion");
  const writes = await mockNotionImport(page);
  const zh = randomUUID().replaceAll("-", "");
  const absent = randomUUID().replaceAll("-", "");
  await page.setInputFiles("#notion-bundle-file", [
    { name: `缺英文 ${zh}.md`, mimeType: "text/markdown", buffer: Buffer.from(`# 缺英文\n\nEnglish: Missing (Missing%20${absent}.md)\n\n中文正文`) },
  ]);
  const row = page.locator(".nw-import-selection-list li").filter({ hasText: "缺英文" });
  await expect(row.getByText("需先补齐英文版")).toBeVisible();
  await expect(page.getByText(/有 1 页标注了「需先补齐英文版」.*包含子页面/)).toBeVisible();
  expect(writes).toHaveLength(0);
});

test("an edit after preview is preserved and the import asks to preview again", async ({ page }) => {
  const file = bundleFile();
  await registerThroughForm(page, uniqueEmail("notion-conflict"), "/write/notion");
  await page.setInputFiles("#notion-bundle-file", file);
  await selectAllAndPreview(page);
  await expect(page.getByRole("button", { name: /确认导入/ })).toBeVisible();
  await page.getByRole("button", { name: /确认导入/ }).click();
  await expect(page.getByText(/已导入：新建 1 件/)).toBeVisible();

  const changed = JSON.parse(file.buffer.toString("utf8")) as typeof BUNDLE;
  changed.pages[0]!.properties.Page.title = [richText("Notion 中的更新")];
  await page.setInputFiles("#notion-bundle-file", { ...file, buffer: Buffer.from(JSON.stringify(changed)) });
  await selectAllAndPreview(page);
  await expect(page.getByText(/计划：新建 0 件、更新 1 件/)).toBeVisible();

  const list = await page.request.get("/api/authoring/articles?allLocales=true");
  expect(list.ok()).toBe(true);
  const article = (await list.json()).data.find((item: { title: string }) => item.title === TITLE);
  expect(typeof article.revision).toBe("string");
  const edit = await page.request.put(`/api/authoring/articles/${article.id}`, {
    headers: { origin: new URL(page.url()).origin },
    data: { slug: article.slug, title: "另一个窗口的修改", locale: article.locale, publish: false,
      expectedRevision: article.revision, contentBlocks: [{ id: "p", type: "paragraph", text: "不要覆盖这次编辑。" }] },
  });
  expect(edit.ok()).toBe(true);
  await page.getByRole("button", { name: /确认导入/ }).click();
  await expect(page.getByText(/^未写入：/)).toBeVisible();
  await expect(page.getByText(/本作品的文章、标签和来源链接均未写入，请重新试跑/)).toBeVisible();
  await expect(page.getByRole("button", { name: /确认导入/ })).toHaveCount(0);
  const kept = (await (await page.request.get("/api/authoring/articles?allLocales=true")).json()).data.find((item: { id: string }) => item.id === article.id);
  expect(kept.title).toBe("另一个窗口的修改");
  expect(JSON.stringify(kept.contentBlocks)).toContain("不要覆盖这次编辑。");
});


test("an invalidated plan is planned again once, and only a second confirm submits the new token", async ({ page }) => {
  await registerThroughForm(page, uniqueEmail("notion-expired"), "/write/notion");
  const file = bundleFile();
  const source = JSON.parse(file.buffer.toString("utf8")) as typeof BUNDLE;
  const attempts: unknown[] = [];
  let previews = 0;
  // This browser contract test controls both opaque tokens and the rejection so
  // it can prove that recovery discards the old token. Real expiry/authentication
  // and successful writes stay in the API suite and real-stack journeys above.
  // Keeping this response sequence controlled also preserves the unchanged
  // 20/IP import budget when the complete browser shard shares one database.
  const report = (applied: boolean): NotionImportReport => ({
    applied, database: source.database,
    summary: { create: 1, update: 0, skip: 0, refused: 0, failed: 0 },
    pages: [{ externalId: source.pages[0]!.id, title: TITLE, locale: "zh-CN", action: "create",
      slug: "controlled-preview", articleId: applied ? "controlled-work" : null,
      detail: applied ? "created" : "would create", issues: [] }],
    ...(!applied ? { planToken: `controlled-preview-${previews}`, planExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString() } : {}),
  });
  await page.route("**/api/authoring/notion-import", async (route) => {
    const body = route.request().postDataJSON() as { bundle: unknown; apply?: boolean; planToken?: unknown };
    expect(body.bundle).toEqual(source);
    if (body.apply === true) {
      attempts.push(body.planToken);
      if (attempts.length === 1) {
        await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "IMPORT_PLAN_INVALID" } }) });
        return;
      }
    } else previews += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: report(body.apply === true) }) });
  });
  await page.setInputFiles("#notion-bundle-file", file);
  await selectAllAndPreview(page);
  await page.getByRole("button", { name: /确认导入/ }).click();
  await expect(page.getByRole("alert")).toContainText("试跑计划已失效或与当前选择不符");
  await expect(page.getByRole("alert")).toContainText("已自动重新试跑");
  await expect(page.getByRole("checkbox")).toBeChecked();
  // The automatic re-run is a dry run: nothing more is written until the author confirms again.
  await expect(page.getByRole("button", { name: /确认导入/ })).toBeVisible();
  expect(previews).toBe(2);
  expect(attempts).toEqual(["controlled-preview-1"]);
  await page.getByRole("button", { name: /确认导入/ }).click();
  await expect(page.getByText(/已导入：新建 1 件/)).toBeVisible();
  expect(previews).toBe(2);
  expect(attempts).toEqual(["controlled-preview-1", "controlled-preview-2"]);
});

/** Nine Markdown pages, each with its own Notion-hosted image: more than one request may copy. */
function imagePages(prefix: string) {
  return Array.from({ length: 9 }, (_, index) => {
    const id = randomUUID().replaceAll("-", "");
    return { name: `${prefix}${index + 1} ${id}.md`, mimeType: "text/markdown",
      buffer: Buffer.from(`# ${prefix}${index + 1}\n\n正文 ${index + 1}\n\n![图 ${index + 1}](https://prod-files-secure.s3.us-west-2.amazonaws.com/e2e/${id}.png)`) };
  });
}

test("a selection over one request's limits is planned in batches, waits out a 429 and is confirmed once", async ({ page }) => {
  await registerThroughForm(page, uniqueEmail("notion-batches"), "/write/notion");
  let throttled = false;
  const writes = await mockNotionImport(page, (request, call) => {
    // The second batch's dry run is throttled once; the page must wait and continue by itself.
    if (call === 2 && !throttled) { throttled = true; return { status: 429, headers: { "retry-after": "2" }, body: { error: { code: "RATE_LIMITED", message: "Too many requests" } } }; }
    return null;
  });
  await page.setInputFiles("#notion-bundle-file", imagePages("分批"));
  await selectAllAndPreview(page);
  await expect(page.getByText(/第 2\/2 批将在 \d 秒后自动继续/)).toBeVisible();
  await expect(page.getByText(/计划：新建 9 件/)).toBeVisible();
  await expect(page.getByText(/已自动分成 2 批提交/)).toBeVisible();
  // 8 distinct Notion images per request: 8 pages, then 1, the dry run of batch 2 sent twice.
  expect(writes.map((request) => [request.apply === true, request.bundle.pages.length])).toEqual([[false, 8], [false, 1], [false, 1]]);
  await page.getByRole("button", { name: "确认导入（写入 9 件作品，分 2 批）" }).click();
  await expect(page.getByText(/已导入：新建 9 件/)).toBeVisible();
  const applies = writes.filter((request) => request.apply === true);
  // Each batch is written with its own plan token, never another batch's.
  expect(applies.map((request) => [request.planToken, request.bundle.pages.length])).toEqual([["mock-plan-1", 8], ["mock-plan-3", 1]]);
  await expect(page.getByRole("link", { name: "去看写作台" })).toBeVisible();
});

test("a failed batch does not stop the others, and the merged report names it", async ({ page }) => {
  await registerThroughForm(page, uniqueEmail("notion-batch-fail"), "/write/notion");
  const writes = await mockNotionImport(page, (request) => request.apply === true && request.bundle.pages.length === 8
    ? { status: 500, body: { error: { code: "INTERNAL", message: "服务器暂时无法完成写入。" } } }
    : null);
  await page.setInputFiles("#notion-bundle-file", imagePages("失败"));
  await selectAllAndPreview(page);
  await page.getByRole("button", { name: /确认导入（写入 9 件作品，分 2 批）/ }).click();
  await expect(page.getByRole("alert")).toContainText("第 1 批：写入失败：服务器暂时无法完成写入。");
  await expect(page.getByText(/部分批次已写入：1 \/ 2 批（新建 1 件、更新 0 件）/)).toBeVisible();
  expect(writes.filter((request) => request.apply === true).map((request) => request.bundle.pages.length)).toEqual([8, 1]);
  // The failed batch is not offered for a blind retry: it must be planned again.
  await expect(page.getByRole("button", { name: /确认导入/ })).toHaveCount(0);
});
