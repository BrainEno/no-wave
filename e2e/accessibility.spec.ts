import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "./support/csp-fixture.ts";
import { registerThroughForm, uniqueEmail } from "./support/accounts.ts";
import { publishWork } from "./support/works.ts";

/** Exercise a full document, with no exclusions or disabled axe rules. */
async function assertNoSeriousAxeViolations(page: Page, description: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
  const detail = serious.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    description: violation.description,
    nodes: violation.nodes.map((node) => ({ target: node.target, failure: node.failureSummary })),
  }));
  expect(detail, `${description}: axe serious/critical violations`).toEqual([]);
}

async function assertTargetSize(locator: Locator, label: string): Promise<void> {
  await expect(locator.first(), `${label}: at least one visible target`).toBeVisible();
  const count = await locator.count();
  expect(count, `${label}: at least one target`).toBeGreaterThan(0);
  for (let index = 0; index < count; index++) {
    const target = locator.nth(index);
    if (!(await target.isVisible())) continue;
    const box = await target.boundingBox();
    expect(box, `${label} ${index} has a box`).not.toBeNull();
    expect(box!.width, `${label} ${index} width`).toBeGreaterThanOrEqual(44);
    expect(box!.height, `${label} ${index} height`).toBeGreaterThanOrEqual(44);
  }
}

async function assertSkip(page: Page, label: string): Promise<void> {
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: label, exact: true });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
  await expect(page.locator("main")).toHaveAttribute("id", "top");
}

test.use({ colorScheme: "light" });

test("the first keyboard stop skips navigation to main on home, article and writing desk", async ({ page, request }) => {
  const { slug } = await publishWork(request, `键盘阅读 ${Date.now().toString(36)}`, ["无障碍正文。"]);
  await page.goto("/");
  await assertSkip(page, "跳到正文");
  await page.goto(`/articles/${slug}`);
  await assertSkip(page, "跳到正文");
  await page.goto("/en");
  await assertSkip(page, "Skip to main content");
  await registerThroughForm(page, uniqueEmail("skip-link"), "/write");
  await page.reload();
  await expect(page.getByRole("heading", { name: /写作台/ })).toBeVisible();
  await assertSkip(page, "跳到正文");
});

test("navigation and reader controls have 44 pixel touch targets at desktop and mobile widths", async ({ page, request }) => {
  const { slug } = await publishWork(request, `触控阅读 ${Date.now().toString(36)}`, ["无障碍正文。"]);
  await registerThroughForm(page, uniqueEmail("reader-size"), "/account");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/articles/${slug}`);
    await assertTargetSize(page.locator(".nw-pill a:visible, .nw-pill button:visible"), `navigation ${width}`);
    await assertTargetSize(page.locator(".nw-rs button"), `reader settings ${width}`);
    await assertTargetSize(page.getByRole("link", { name: "无浪作者", exact: true }).first(), `author link ${width}`);
    await assertTargetSize(page.locator(".nw-comment-toolbar button"), `comment toolbar ${width}`);
    if (width === 390) {
      await page.getByRole("button", { name: "选单", exact: true }).click();
      await assertTargetSize(page.locator(".nw-menu a, .nw-menu button"), "mobile menu");
      await page.getByRole("dialog", { name: "选单" }).getByRole("button", { name: "关闭" }).click();
    }
  }
  const author = page.getByRole("link", { name: "无浪作者", exact: true }).first();
  await author.click();
  await assertTargetSize(page.locator(".nw-follow-btn"), "follow control");
});

test("the writing toolbar has 44 pixel targets", async ({ page }) => {
  await registerThroughForm(page, uniqueEmail("toolbar-size"), "/write");
  await expect(page.getByRole("heading", { name: /写作台/ })).toBeVisible();
  await expect(page.getByLabel("作品正文")).toBeVisible();
  await assertTargetSize(page.locator(".nw-lexical-toolbar button"), "writing toolbar");
});

test("axe finds no serious or critical violations on home, article and writing desk", async ({ page, request }) => {
  const { slug } = await publishWork(request, `无障碍扫描 ${Date.now().toString(36)}`, ["用于自动检查的正文。"]);
  await page.goto("/");
  await expect(page.locator("main")).toBeVisible();
  await assertNoSeriousAxeViolations(page, "home");
  await registerThroughForm(page, uniqueEmail("axe-reader"), "/account");
  await page.goto(`/articles/${slug}`);
  await expect(page.getByRole("heading", { name: /无障碍扫描/ })).toBeVisible();
  await expect(page.getByLabel("评论内容")).toBeVisible();
  await expect(page.getByRole("button", { name: "A− 减小字号", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "A+ 增大字号", exact: true })).toBeVisible();
  await assertNoSeriousAxeViolations(page, "article");
  await page.goto("/write");
  await expect(page.getByLabel("作品正文")).toBeVisible();
  await assertNoSeriousAxeViolations(page, "writing desk");
});


test("the brand rail's accessible name contains its visible text in both locales", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const [path, visible, destination] of [
    ["/", "无浪潮 · No Wave — 独立文学出版", "首页"],
    ["/en", "NO WAVE — INDEPENDENT LITERARY PUBLISHING", "home"],
  ] as const) {
    await page.goto(path);
    const rail = page.locator(".nw-rail");
    await expect(rail).toHaveText(visible);
    await expect(rail).toHaveAccessibleName(`${visible} — ${path === "/" ? "无浪潮 No Wave 首页" : "No Wave home"}`);
    await expect(rail).toHaveAttribute("href", path);
    await expect(rail).toHaveAccessibleName(new RegExp(destination));
    await assertNoSeriousAxeViolations(page, `brand rail ${path}`);
  }
});
