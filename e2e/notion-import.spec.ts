import { randomUUID } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { expect, test, type Page } from "@playwright/test";
import { registerThroughForm, uniqueEmail } from "./support/accounts.ts";

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
  await page.getByRole("button", { name: "全选", exact: true }).click();
  await page.getByRole("button", { name: "试跑所选文章" }).click();
}

test("an anonymous visitor is sent to sign in, and pointed back afterwards", async ({ page }) => {
  await page.goto("/write/notion");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fwrite%2Fnotion/);
  await expect(page.getByLabel("邮箱")).toBeVisible();
});

test("the writing desk links to the import", async ({ page }) => {
  await registerThroughForm(page, uniqueEmail("notion-desk"), "/write");
  await page.getByRole("link", { name: "从 Notion 导入" }).click();
  await expect(page).toHaveURL(/\/write\/notion$/);
  await expect(page.getByRole("heading", { name: /从 Notion 导入/ })).toBeVisible();
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

  // And the work is the author's, in the desk they already use.
  await page.getByRole("link", { name: "去看写作台" }).click();
  await expect(page).toHaveURL(/\/write$/);
  await expect(page.getByText(TITLE)).toBeVisible();
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
  await expect(page.getByText("第一篇", { exact: true })).toBeVisible();
  await expect(page.getByText("第二篇", { exact: true })).toBeVisible();
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
  await expect(page.getByRole("button", { name: "试跑所选文章" })).toBeDisabled();
  await expect(page.getByText(/Rank 没有对应字段/)).toHaveCount(0);
  await page.getByLabel("保留甲", { exact: true }).check();
  await page.getByLabel("不导入", { exact: true }).check();
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
  await expect(page.getByText("保留甲", { exact: true })).toBeVisible();
  await expect(page.getByText("保留乙", { exact: true })).toBeVisible();
  await expect(page.getByText("不导入", { exact: true })).toHaveCount(0);
});

function assertSelectedPages(request: { bundle: { pages: { id: string }[] } } | undefined, ids: string[]) {
  expect(request).toBeDefined();
  expect(request!.bundle.pages.map((page) => page.id.replaceAll("-", "")).sort()).toEqual([...ids].sort());
}
