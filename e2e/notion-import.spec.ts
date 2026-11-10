import { randomUUID } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { expect, test } from "@playwright/test";
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

  // The dry run's answer, before anything is written.
  await expect(page.getByText(/计划：新建 1 件、更新 0 件、跳过 0 页/)).toBeVisible();
  await expect(page.getByText(/确认之前不会写入任何内容/)).toBeVisible();
  await expect(page.getByText(TITLE)).toBeVisible();

  // Nothing has been written yet: the desk does not have the work.
  await page.goto("/write");
  await expect(page.getByText(TITLE)).toHaveCount(0);

  await page.goto("/write/notion");
  await page.setInputFiles("#notion-bundle-file", file);
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
  await expect(page.getByText(/计划：新建 1 件、更新 0 件、跳过 0 页/)).toBeVisible();
  await page.getByRole("button", { name: /确认导入/ }).click();
  await expect(page.getByText(/已导入：新建 1 件/)).toBeVisible();

  await page.setInputFiles("#notion-bundle-file", file);
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
  await expect(page.getByText(/计划：新建 1 件/)).toBeVisible();
  await expect(page.getByText("压缩文章")).toBeVisible();
  await page.getByRole("button", { name: /确认导入/ }).click();
  await expect(page.getByText(/已导入：新建 1 件/)).toBeVisible();
});
