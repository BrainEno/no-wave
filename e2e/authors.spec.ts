import { expect, test } from "@playwright/test";
import { publishWork } from "./support/works.ts";

/**
 * The author directory, end to end (ADR 0024).
 *
 * What this file can see that the cheaper layers cannot: that a writer who
 * publishes appears in a page a reader can reach at `/authors`, that searching
 * their name finds them, and that a name nobody has is an empty directory rather
 * than a broken one.
 *
 * The endpoint is covered in the API tests, and the ordering rule — relevance
 * before reach — is a property of the store, covered by the persistence
 * contract. What is left for a browser is the journey: publish, appear, be found.
 *
 * The assertions are deliberately tolerant of company: the e2e stack is shared,
 * so the directory may hold authors other tests created. What must be true is
 * that *this* author is in it, not that they are alone.
 */
const DISPLAY_NAME = "无浪作者";

test("a writer who publishes is listed in the author directory, and can be found by name", async ({ page, request }) => {
  await publishWork(request, `作者目录 ${Date.now().toString(36)}`, [
    "渡口的船停了，作者在目录里等一个读者。",
  ]);

  await page.goto("/authors");
  // Level 1, not just the name: the empty state is a heading too, and a locator
  // that matches both is a strict-mode violation rather than a passing test.
  await expect(page.getByRole("heading", { level: 1, name: /作者/ })).toBeVisible();
  const row = page.locator("a.nw-ar-list", { hasText: DISPLAY_NAME }).first();
  await expect(row).toBeVisible();
  // The row says how much of their work is here, which is the reason to click it.
  await expect(row).toContainText(/篇作品/);
  await row.click();
  await expect(page).toHaveURL(/\/authors\/[0-9a-f-]{36}$/);

  // Searching the name is the whole point of the directory.
  await page.goto(`/authors?q=${encodeURIComponent("无浪")}`);
  await expect(page.locator("a.nw-ar-list", { hasText: DISPLAY_NAME }).first()).toBeVisible();
});

test("a name nobody has is an empty directory, not an error", async ({ page, request }) => {
  await publishWork(request, `作者目录 ${Date.now().toString(36)}`, [
    "这一篇只是为了让目录不是空的。",
  ]);
  await page.goto("/authors?q=zzz-没有这个作者");
  await expect(page.getByRole("heading", { level: 1, name: /作者/ })).toBeVisible();
  await expect(page.getByText("没有符合搜索条件的作者。")).toBeVisible();
  await expect(page.locator("a.nw-ar-list")).toHaveCount(0);
});
