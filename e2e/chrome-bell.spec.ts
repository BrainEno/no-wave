import { expect, test } from "@playwright/test";

const baseUrl = process.env.E2E_WEB_URL ?? "http://127.0.0.1:3000";
const marker = String(Math.floor(Date.now() / 1000) + 3600);
const notice = {
  type: "article.deleted",
  articleId: "11111111-1111-4111-8111-111111111111",
  purgesAt: "2999-01-01T00:00:00.000Z",
};
const notification = {
  id: "22222222-2222-4222-8222-222222222222",
  eventKey: "article.deleted",
  payload: JSON.stringify(notice),
  createdAt: "2026-01-01T00:00:00.000Z",
  readAt: null,
};

function pathIs(path: string) {
  return (url: URL) => url.pathname === path;
}

/**
 * The shared chrome used to hard-code `unread = 0` and always say "go sign in".
 * These checks stand in for the API with route interception so the browser
 * proves the badge, the panel and both read actions without needing a real
 * notification row in the E2E database.
 */
test("a signed-in bell shows the real unread count and can mark notices read", async ({ page }) => {
  await page.context().addCookies([{ name: "nw_session", value: marker, url: baseUrl }]);
  let read = false;

  await page.route(pathIs("/api/authoring/notifications/unread-count"), async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: read ? 0 : 100 }) });
  });
  await page.route(pathIs("/api/authoring/notifications"), async (route) => {
    const item = read ? { ...notification, readAt: "2026-01-02T00:00:00.000Z" } : notification;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [item] }) });
  });
  await page.route(pathIs("/api/authoring/notifications/read-all"), async (route) => {
    read = true;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: 1 }) });
  });
  await page.route((url) => url.pathname.startsWith("/api/authoring/notifications/") && url.pathname.endsWith("/read"), async (route) => {
    read = true;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: notification }) });
  });

  await page.goto("/");
  await expect(page.locator(".nw-bdg")).toHaveText("99+");

  await page.getByRole("button", { name: /通知/ }).click();
  const panel = page.getByRole("dialog", { name: "通知" });
  await expect(panel).toContainText("你评论过的一篇作品已被作者删除");
  await expect(panel.getByRole("button", { name: "标记已读" })).toBeVisible();

  await panel.getByRole("button", { name: "全部标为已读" }).click();
  await expect(page.locator(".nw-bdg")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "标记已读" })).toHaveCount(0);
});

test("a signed-out bell keeps the sign-in prompt", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "通知" }).click();
  const panel = page.getByRole("dialog", { name: "通知" });
  await expect(panel).toContainText("暂无通知");
  await expect(panel.getByRole("link", { name: /登录/ })).toBeVisible();
});

test("the English chrome translates the writing entry", async ({ page }) => {
  await page.goto("/en");
  await expect(page.locator('.nw-pill a[href="/write"]')).toHaveText("Write");
  await expect(page.locator('#nw-menu a[href="/write"]')).toHaveText("Write");
});
