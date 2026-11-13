import { expect, type Page } from "@playwright/test";
import { test } from "./support/tag-stack.ts";
import { tagAuthor as author, tagNonce as nonce, type CreatedTag } from "./support/tag-author.ts";

async function noHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client + 1);
}

test("a reader discovers a Unicode tag, follows its published work and returns through the article tag link", async ({ page, request, tagStack }) => {
  const writer = await author(request, tagStack.apiBaseUrl);
  const name = `地方记忆${nonce()}`;
  const tag = await writer.tag(name);
  const publicTitle = `公开的记忆 ${nonce()}`;
  const privateTitle = `绝不可公开的草稿 ${nonce()}`;
  const published = await writer.work(publicTitle, tag);
  const draft = await writer.work(privateTitle, tag, false);
  // Privacy is enforced by the anonymous API, not by a client-side filter.
  const collection = await request.get(`${tagStack.apiBaseUrl}/api/v1/tags/${tag.slug}/articles?locale=zh-CN`);
  expect(collection.status()).toBe(200);
  const data = (await collection.json()).data as { slug: string }[];
  expect(data.map((item) => item.slug)).toEqual([published.slug]);
  const privateRead = await request.get(`${tagStack.apiBaseUrl}/api/v1/articles/${draft.slug}?locale=zh-CN`);
  expect(privateRead.status()).toBe(404);
  const count = await request.get(`${tagStack.apiBaseUrl}/api/v1/tags/${tag.slug}?locale=zh-CN`);
  expect((await count.json()).data.articleCount).toBe(1);

  await page.goto(tagStack.webBaseUrl);
  await page.getByRole("navigation", { name: "页尾导航" }).getByRole("link", { name: "标签", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("标签");
  await page.getByRole("searchbox", { name: "搜索标签", exact: true }).fill(`＃${name}`);
  await page.getByRole("search", { name: "搜索标签" }).getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.getByRole("searchbox", { name: "搜索标签", exact: true })).toHaveValue(name);
  await page.locator(`a[data-tag-slug="${tag.slug}"]`).click();
  await expect(page).toHaveURL(`${tagStack.webBaseUrl}/tags/${tag.slug}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`#${name}`);
  await expect(page.locator("main")).not.toContainText(privateTitle);
  await page.getByRole("link", { name: new RegExp(publicTitle) }).click();
  await expect(page).toHaveURL(`${tagStack.webBaseUrl}/articles/${published.slug}`);
  const reference = page.getByRole("navigation", { name: "作品标签" }).getByRole("link", { name: `#${name}`, exact: true });
  await expect(reference).toHaveAttribute("href", `/tags/${tag.slug}`);
  await expect(reference).toHaveAttribute("rel", "tag");
  await reference.click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`#${name}`);
});

test("directory pagination keeps a Unicode query, has no overlapping rows, and restores the URL on Back", async ({ page, request, tagStack }) => {
  const writer = await author(request, tagStack.apiBaseUrl);
  const prefix = `分页主题${nonce()}`;
  const created: CreatedTag[] = [];
  for (let i = 1; i <= 23; i++) created.push(await writer.tag(`${prefix}${String(i).padStart(2, "0")}`));
  await page.goto(`${tagStack.webBaseUrl}/tags?q=${encodeURIComponent(prefix)}`);
  const rows = page.locator("a[data-tag-slug]");
  await expect(rows).toHaveCount(20);
  const first = await rows.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-tag-slug")));
  await page.locator('main a[rel="next"]').click();
  await expect(page).toHaveURL(new RegExp("page=2"));
  expect(new URL(page.url()).searchParams.get("q")).toBe(prefix);
  await expect(page.getByRole("searchbox", { name: "搜索标签", exact: true })).toHaveValue(prefix);
  await expect(rows).toHaveCount(3);
  const second = await rows.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-tag-slug")));
  expect(new Set([...first, ...second]).size).toBe(23);
  expect([...first, ...second].sort()).toEqual(created.map((item) => item.slug).sort());
  await expect(page.locator('main a[rel="next"]')).toHaveCount(0);
  await expect(page.locator('main a[rel="prev"]')).toHaveAttribute("href", `/tags?q=${encodeURIComponent(prefix)}`);
  await page.goBack();
  await expect(rows).toHaveCount(20);
  await expect(page.getByRole("searchbox", { name: "搜索标签", exact: true })).toHaveValue(prefix);
  expect(new URL(page.url()).searchParams.has("page")).toBe(false);
});

test("long tag names and keyboard-only search remain usable on a narrow viewport", async ({ page, request, tagStack }) => {
  const writer = await author(request, tagStack.apiBaseUrl);
  const name = (`LongTag${nonce()}` + "A".repeat(50)).slice(0, 50);
  const tag = await writer.tag(name);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${tagStack.webBaseUrl}/tags`);
  const input = page.getByRole("searchbox", { name: "搜索标签", exact: true });
  await input.focus();
  await page.keyboard.type(name);
  await page.keyboard.press("Enter");
  await expect(input).toHaveValue(name);
  const row = page.locator(`a[data-tag-slug="${tag.slug}"]`);
  await expect(row).toBeVisible();
  await noHorizontalOverflow(page);
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`#${name}`);
  await expect(page.getByText("这个标签下还没有已发表的作品。", { exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  const heading = await page.getByRole("heading", { level: 1 }).boundingBox();
  expect(heading).not.toBeNull();
  expect(heading!.x).toBeGreaterThanOrEqual(0);
  expect(heading!.x + heading!.width).toBeLessThanOrEqual(390);
  const back = await page.getByRole("link", { name: "← 全部标签" }).boundingBox();
  expect(back?.height).toBeGreaterThanOrEqual(44);
});

test("tag search, detail and work links remain fully usable with JavaScript disabled", async ({ browser, request, tagStack }) => {
  const writer = await author(request, tagStack.apiBaseUrl);
  const tag = await writer.tag(`无需脚本${nonce()}`);
  const title = `服务端阅读 ${nonce()}`;
  const published = await writer.work(title, tag);
  const context = await browser.newContext({ javaScriptEnabled: false, reducedMotion: "reduce", baseURL: tagStack.webBaseUrl });
  try {
    const page = await context.newPage();
    await page.goto("/tags");
    await page.getByRole("searchbox", { name: "搜索标签", exact: true }).fill(tag.name);
    await page.getByRole("search", { name: "搜索标签" }).getByRole("button", { name: "搜索", exact: true }).click();
    await page.locator(`a[data-tag-slug="${tag.slug}"]`).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`#${tag.name}`);
    await page.getByRole("link", { name: new RegExp(title) }).click();
    await expect(page).toHaveURL(`${tagStack.webBaseUrl}/articles/${published.slug}`);
    await expect(page.getByRole("navigation", { name: "作品标签" }).getByRole("link", { name: `#${tag.name}` })).toBeVisible();
  } finally { await context.close(); }
});

test("language navigation reaches an English directory without inventing a tag translation", async ({ page, request, tagStack }) => {
  const writer = await author(request, tagStack.apiBaseUrl);
  const tag = await writer.tag(`仅有中文${nonce()}`);
  await page.goto(`${tagStack.webBaseUrl}/tags/${tag.slug}`);
  await page.locator('.nw-pill a[lang="en"]').click();
  await expect(page).toHaveURL(`${tagStack.webBaseUrl}/en/tags`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tags");
  await expect(page.getByRole("searchbox", { name: "Search tags", exact: true })).toBeVisible();
  await expect(page.getByText("There are no tags to browse yet.", { exact: true })).toBeVisible();
  const missingTranslation = await request.get(`${tagStack.webBaseUrl}/en/tags/${tag.slug}`);
  expect(missingTranslation.status()).toBe(404);
  await page.getByRole("searchbox", { name: "Search tags", exact: true }).fill("missing-tag-name");
  await page.getByRole("search", { name: "Search tags" }).getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("No tags match your search.", { exact: true })).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, follow");
  expect(new URL(await page.locator('link[rel="canonical"]').getAttribute("href") ?? "").searchParams.get("q")).toBe("missing-tag-name");
});
