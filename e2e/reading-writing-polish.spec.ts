import { expect, test, type Locator, type Page } from "@playwright/test";
import { registerThroughForm, uniqueEmail } from "./support/accounts.ts";
import { editorState, publishWork, WORK_PASSWORD } from "./support/works.ts";

const api = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:4000";

async function visibleAboveFold(locator: Locator, page: Page, minimumHeight: number) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  const intersection = Math.min(box!.y + box!.height, viewport!.height) - Math.max(box!.y, 0);
  expect(intersection, `visible height of ${await locator.getAttribute("aria-label") ?? "control"}`).toBeGreaterThanOrEqual(minimumHeight);
}

test("the writing desk prioritizes title and body without hiding account, profile or inbox", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await registerThroughForm(page, uniqueEmail("desk-layout"), "/write");
  await expect(page.getByRole("heading", { name: /写作台/ })).toBeVisible();
  await expect(page.getByLabel("作品正文")).toBeVisible();
  // Registration and hydration can leave focus lower down; a fresh load is the
  // real above-the-fold experience this acceptance check is concerned with.
  await page.reload();
  await expect(page.getByLabel("作品正文")).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await visibleAboveFold(page.getByLabel("标题", { exact: true }), page, 44);
  await visibleAboveFold(page.getByLabel("作品正文"), page, 100);
  await expect(page.getByRole("button", { name: "发送验证邮件" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /作者资料/ })).toBeVisible();
  await expect(page.getByRole("region", { name: "通知" })).toBeVisible();
  await expect(page.getByLabel("作品语言")).toBeVisible();
  await expect(page.getByLabel("作品类型")).toBeVisible();
  await expect(page.getByLabel("摘要", { exact: true })).toBeVisible();
});

test("a generated excerpt is not repeated, while an authored standfirst remains visible", async ({ page, request }) => {
  const title = `摘要检查 ${Date.now().toString(36)}`;
  const opening = "这段开头只应在正文出现一次。";
  const work = await publishWork(request, title, [opening]);
  await page.goto(`/articles/${work.slug}`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.locator(".nw-rh .nw-ep")).toHaveCount(0);
  await expect(page.locator(".nw-rd")).toContainText(opening);
  await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", opening);

  // Create a second article as the same author with an intentional summary.
  const login = await request.post(`${api}/api/v1/auth/login`, { data: { email: work.email, password: WORK_PASSWORD } });
  expect(login.status(), await login.text()).toBe(200);
  const token = (await login.json()).data.accessToken as string;
  const summary = "这是一段作者特意撰写的引言。";
  const created = await request.post(`${api}/api/v1/articles`, {
    headers: { authorization: `Bearer ${token}`, origin: api },
    data: { title: `${title} 独立摘要`, summary, editorState: editorState([opening]), contentBlocksVersion: 1, publish: true },
  });
  expect(created.status(), await created.text()).toBe(201);
  const slug = (await created.json()).data.slug as string;
  await page.goto(`/articles/${slug}`);
  await expect(page.locator(".nw-rh .nw-ep")).toHaveText(summary);
  await expect(page.locator(".nw-rd")).toContainText(opening);
  await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", summary);
});

test("the missing-page boundary has reader-facing text and clears the fixed navigation", async ({ page }) => {
  const response = await page.goto("/articles/this-work-does-not-exist-7821");
  expect(response?.status()).toBe(404);
  const main = page.locator('main[data-error-boundary="404"]');
  await expect(main.getByRole("heading", { name: "这一页不存在" })).toBeVisible();
  await expect(main).toContainText("链接可能已失效");
  const nav = await page.locator(".nw-pill").boundingBox();
  const heading = await main.getByRole("heading").boundingBox();
  expect(nav).not.toBeNull();
  expect(heading).not.toBeNull();
  expect(heading!.y).toBeGreaterThanOrEqual(nav!.y + nav!.height);
  await expect(main.getByRole("link", { name: "返回首页" })).toBeVisible();
});

test("the editor stays usable on a narrow screen after supporting panels move below it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await registerThroughForm(page, uniqueEmail("mobile-desk"), "/write");
  await expect(page.getByLabel("标题", { exact: true })).toBeVisible();
  await page.getByLabel("标题", { exact: true }).fill("窄屏草稿");
  await page.getByLabel("作品正文").fill("这段正文可以在移动设备上编辑。");
  await expect(page.getByLabel("标题", { exact: true })).toHaveValue("窄屏草稿");
  await expect(page.getByLabel("作品正文")).toContainText("移动设备");
  await expect(page.getByLabel("作品语言")).toHaveValue("zh-CN");
  await page.getByLabel("摘要", { exact: true }).fill("这是一段独立摘要。");
  await expect(page.getByLabel("作品正文")).toContainText("移动设备");
  await expect(page.getByLabel("标题", { exact: true })).toHaveValue("窄屏草稿");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(page.getByRole("heading", { name: /作者资料/ })).toBeVisible();
  await expect(page.getByRole("region", { name: "通知" })).toBeVisible();
});
