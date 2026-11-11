import { expect, test } from "@playwright/test";
import { registerThroughForm, uniqueEmail } from "./support/accounts.ts";

test("private pages reserve the first screen and keep CLS below 0.1 across five loads", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await registerThroughForm(page, uniqueEmail("private-cls"));
  await page.addInitScript(() => {
    // CLS is the maximum session window, not the sum over the whole page life.
    let start = 0, last = 0, windowValue = 0, max = 0;
    Object.assign(window, { readTestCls: () => max });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
        if (entry.hadRecentInput) continue;
        if (entry.startTime - last > 1000 || entry.startTime - start > 5000) {
          start = entry.startTime;
          windowValue = 0;
        }
        last = entry.startTime;
        windowValue += entry.value;
        max = Math.max(max, windowValue);
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  // Deliberately hold authentication to inspect the actual SSR/loading shell.
  await page.route("**/api/authoring/session", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 700));
    await route.continue();
  });
  for (const path of ["/write", "/account"]) {
    for (let run = 1; run <= 5; run++) {
      await page.goto(path, { waitUntil: "domcontentloaded" });
      const footerTop = await page.locator(".nw-footer").evaluate((el) => el.getBoundingClientRect().top);
      expect(footerTop, `${path} loading shell`).toBeGreaterThanOrEqual(720);
      if (path === "/write") await expect(page.getByRole("heading", { name: /写作台/ })).toBeVisible();
      else await expect(page.locator("[data-account-email]")).toBeVisible();
      await page.waitForTimeout(1000);
      const cls = await page.evaluate(() => (window as unknown as { readTestCls: () => number }).readTestCls());
      expect(cls, `${path} run ${run}`).toBeLessThan(0.1);
    }
  }
});
