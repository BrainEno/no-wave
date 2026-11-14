import { expect } from "@playwright/test";
import { test } from "./support/csp-fixture.ts";
import { publishWork } from "./support/works.ts";

// Exercise scroll-triggered off-screen rows, not just the reduced-motion branch.
test.use({ reducedMotion: "no-preference" });

test("reading pages and navigation fit mobile viewports with motion enabled", async ({ page, request }) => {
  const { slug } = await publishWork(request, `移动版布局 ${Date.now().toString(36)}`, ["中文正文与移动端阅读。"]);
  await publishWork(request, `第二篇文章 ${Date.now().toString(36)}`, ["另一篇真实发表的作品。"]);
  await page.addInitScript(() => { try { sessionStorage.setItem("nw-loaded", "1"); } catch { /* unavailable */ } });
  for (const width of [360, 375, 390, 414]) {
    await page.setViewportSize({ width, height: 844 });
    for (const path of ["/", "/articles", `/articles/${slug}`]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(200);
      // Wait for hydration and the effect that installs row reveal transforms.
      await expect(page.locator("html")).toHaveClass(/nw-smooth/);
      await page.waitForTimeout(300);
      const dimensions = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
      expect(dimensions.scroll, `${path} at ${width}px`).toBe(dimensions.client);
      const menu = page.getByRole("button", { name: "选单", exact: true });
      await expect(menu).toBeVisible();
      const box = await menu.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      await menu.click();
      const close = page.getByRole("dialog", { name: "选单" }).getByRole("button", { name: "关闭", exact: true });
      await expect(close).toBeVisible();
      const closeBox = await close.boundingBox();
      expect(closeBox).not.toBeNull();
      expect(closeBox!.x).toBeGreaterThanOrEqual(0);
      expect(closeBox!.x + closeBox!.width).toBeLessThanOrEqual(width);
      await close.click();
    }
  }
});
