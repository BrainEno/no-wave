import { expect, test, type Page } from "@playwright/test";

/**
 * Authoring journey, end to end in a real browser.
 *
 * Why this exists: the save button was broken for most real documents and every
 * cheaper layer was green — the unit tests, the API contract tests, the types.
 * The failure lived between the Lexical editor, the REST body and the adapter,
 * and only a browser that types into the editor and clicks 保存草稿 can see it.
 * These are the assertions that would have caught it.
 *
 * Selectors follow the accessibility tree (labels, roles) rather than CSS, so
 * styling changes do not break the suite.
 */

const PASSWORD = "e2e-browser-password";

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

/** Register a fresh account through the sign-in form and land on /write. */
async function registerWriter(page: Page): Promise<void> {
  await page.goto("/sign-in?next=%2Fwrite");
  await page.getByRole("button", { name: "没有账户？创建账户" }).click();
  await page.getByLabel("邮箱").fill(uniqueEmail("writer"));
  await page.getByLabel("密码").fill(PASSWORD);
  await page.getByRole("button", { name: "创建账户并继续" }).click();
  await page.waitForURL("**/write");
  await expect(page.getByRole("heading", { name: /写作台/ })).toBeVisible();
}

/** Type a title and a body into the editor, then save. Returns the saved slug. */
async function writeAndSave(page: Page, title: string, publish: boolean): Promise<string> {
  await page.getByLabel("标题").fill(title);
  await page.getByLabel("作品正文").click();
  await page.keyboard.type("无浪是一只没有波浪的文学站点，第一段用来验证保存链路。");
  await page.keyboard.press("Enter");
  await page.keyboard.type("第二段用来验证摘要会取正文开头，而不是把整篇文章塞进去。");
  await page.getByRole("button", { name: publish ? "发布作品" : "保存草稿" }).click();

  const status = page.getByRole("status");
  await expect(status).toContainText(publish ? "作品已发布。" : "草稿已保存。");
  await expect(status).toContainText("作品地址：/articles/");
  const message = (await status.textContent()) ?? "";
  const slug = (message.split("/articles/")[1] ?? "").trim();
  expect(slug, `the editor must report the generated address: ${message}`).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  return slug;
}

test("saving a draft creates the article, generates its address, and survives a reload", async ({ page }) => {
  await registerWriter(page);
  const title = `浏览器验证草稿 ${Date.now().toString(36)}`;
  const slug = await writeAndSave(page, title, false);

  // The address is derived from the title, never typed by the author.
  expect(slug.length).toBeGreaterThan(0);

  // A reload re-reads the author's article list from the API: the draft is real.
  await page.reload();
  await expect(page.getByRole("button", { name: new RegExp(title) })).toBeVisible();
  await expect(page.getByRole("status")).toContainText(`/articles/${slug}`);
});

test("publishing an article makes it readable at its generated address with a generated summary", async ({ page }) => {
  await registerWriter(page);
  const title = `浏览器验证发布 ${Date.now().toString(36)}`;
  const slug = await writeAndSave(page, title, true);

  await page.goto(`/articles/${slug}`);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await expect(page.getByText("无浪是一只没有波浪的文学站点")).toBeVisible();

  // The summary was left blank in the editor, so the API derived it from the
  // body: the page description must be the beginning of the prose, not empty.
  const description = (await page.locator('meta[name="description"]').getAttribute("content")) ?? "";
  expect(description.length).toBeGreaterThan(0);
  expect(description.startsWith("无浪是一只没有波浪的文学站点")).toBe(true);
  expect(description.length).toBeLessThanOrEqual(111);
});

test("an article with no body is refused with a readable message instead of a silent failure", async ({ page }) => {
  await registerWriter(page);
  await page.getByLabel("标题").fill(`浏览器验证空正文 ${Date.now().toString(36)}`);
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("alert")).toContainText("请先输入正文内容。");
});
