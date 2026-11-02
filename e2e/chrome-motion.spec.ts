import { expect, test } from "@playwright/test";

/**
 * The reduced-motion default in playwright.config.ts is a test harness choice,
 * not the only way the product has to work. Form routes must also keep native
 * scrolling with animation enabled, so a click after scrolling cannot be lost.
 */
test.use({ reducedMotion: "no-preference" });

test("form routes keep native scrolling and clicks under normal motion", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/");
  await expect(page.locator("html")).toHaveClass(/nw-smooth/);

  await page.goto("/sign-in");
  await expect(page.locator("html")).not.toHaveClass(/nw-smooth/);

  const toggle = page.getByRole("button", { name: "没有账户？创建账户" });
  await toggle.scrollIntoViewIfNeeded();
  await toggle.click();
  await expect(page.getByRole("button", { name: "已有账户？登录" })).toBeVisible();
  expect(pageErrors, `native form-route clicks must not throw:\n${pageErrors.join("\n")}`).toEqual([]);
});
