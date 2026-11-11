import { expect, test } from "@playwright/test";
import { registerThroughForm, uniqueEmail } from "./support/accounts.ts";

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
    const payloads = [notice, { type: "article.commented", slug: "sample-work" },
      { type: "article.comment_replied", slug: "sample-work" }, { type: "article.liked", slug: "sample-work" },
      { type: "user.followed", followerId: "author-123" }, { type: "message.created", conversationId: "thread-123" },
      { type: "future.type" }];
    const items = payloads.map((payload, index) => ({ ...notification, id: `notice-${index}`, payload: JSON.stringify(payload), readAt: read ? "2026-01-02T00:00:00.000Z" : null }));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: items }) });
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
  for (const text of ["有人评论了你的作品", "有人回复了你的评论", "有人喜欢了你的作品", "有人关注了你", "你收到一条新私信", "你收到一条通知"]) await expect(panel).toContainText(text);
  await expect(panel.locator('a[href="/messages/thread-123"]')).toBeVisible();
  await expect(panel.getByRole("button", { name: "标记已读" })).toHaveCount(7);

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


test("the writing desk displays multiple kinds of notifications and marks all read", async ({ page }) => {
  await registerThroughForm(page, uniqueEmail("notices"), "/write");
  let read = false;
  const payloads = [{ type: "article.commented", slug: "sample-work" }, { type: "user.followed", followerId: "writer-1" },
    { type: "message.created", conversationId: "thread-1" }, { type: "future.event" }];
  await page.route(pathIs("/api/authoring/notifications/unread-count"), (route) => route.fulfill({ json: { data: read ? 0 : 4 } }));
  await page.route(pathIs("/api/authoring/notifications"), (route) => route.fulfill({ json: { data: payloads.map((payload, i) => ({ ...notification, id: `item-${i}`, payload: JSON.stringify(payload), readAt: read ? "2026-01-02T00:00:00.000Z" : null })) } }));
  await page.route(pathIs("/api/authoring/notifications/read-all"), (route) => { read = true; return route.fulfill({ json: { data: 4 } }); });
  await page.reload();
  const inbox = page.getByRole("region", { name: "通知" });
  await expect(inbox).toContainText("4 未读");
  for (const text of ["有人评论了你的作品", "有人关注了你", "你收到一条新私信", "你收到一条通知"]) await expect(inbox).toContainText(text);
  await expect(inbox.locator('a[href="/authors/writer-1"]')).toBeVisible();
  await inbox.getByRole("button", { name: "全部标为已读" }).click();
  await expect(inbox).not.toContainText("4 未读");
  await expect(inbox.getByRole("button", { name: "标记已读" })).toHaveCount(0);
});

/** A paginated API fixture: timestamps deliberately tie, so the UUID is needed. */
function manyNotifications(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `00000000-0000-4000-8000-${(count - index).toString(16).padStart(12, "0")}`,
    eventKey: `event-${index}`,
    payload: JSON.stringify({ type: index === count - 1 ? "message.created" : "article.commented", slug: "sample-work", conversationId: "last-thread" }),
    createdAt: "2026-01-01T00:00:00.000Z",
    readAt: null as string | null,
  }));
}

test("bell loads older notifications with keysets, retries errors and reads items beyond page one", async ({ page }) => {
  await page.context().addCookies([{ name: "nw_session", value: marker, url: baseUrl }]);
  const items = manyNotifications(103);
  let failOnce = true;
  const cursors: string[] = [];
  await page.route(pathIs("/api/authoring/notifications/unread-count"), (route) => route.fulfill({ json: { data: items.filter((row) => row.readAt === null).length } }));
  await page.route(pathIs("/api/authoring/notifications"), (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    let start = 0;
    if (cursor) {
      cursors.push(cursor);
      if (failOnce) { failOnce = false; return route.fulfill({ status: 503 }); }
      const decoded = Buffer.from(cursor, "base64url").toString("utf8");
      const id = decoded.split("|")[1];
      start = items.findIndex((row) => row.id === id) + 1;
      expect(start).toBeGreaterThan(0);
    }
    return route.fulfill({ json: { data: items.slice(start, start + 50) } });
  });
  await page.route((url) => url.pathname.startsWith("/api/authoring/notifications/") && url.pathname.endsWith("/read"), (route) => {
    const id = route.request().url().split("/").at(-2);
    const row = items.find((entry) => entry.id === id);
    expect(row).toBeTruthy();
    row!.readAt = "2026-01-02T00:00:00.000Z";
    return route.fulfill({ json: { data: row } });
  });
  await page.route(pathIs("/api/authoring/notifications/read-all"), (route) => {
    for (const row of items) row.readAt = "2026-01-02T00:00:00.000Z";
    return route.fulfill({ json: { data: items.length } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /通知/ }).click();
  const panel = page.getByRole("dialog", { name: "通知" });
  await expect(panel.locator(".nw-np-row")).toHaveCount(50);
  const panelBox = await panel.boundingBox();
  expect(panelBox).not.toBeNull();
  expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await expect(panel).toContainText("未读数包含尚未载入的通知");
  await panel.getByRole("button", { name: "加载更多通知" }).click();
  await expect(panel.getByRole("alert")).toBeVisible();
  await expect(panel.locator(".nw-np-row")).toHaveCount(50);
  await panel.getByRole("button", { name: "加载更多通知" }).click();
  await expect(panel.locator(".nw-np-row")).toHaveCount(100);
  expect(cursors[0]).toBe(cursors[1]);
  await panel.getByRole("button", { name: "加载更多通知" }).click();
  await expect(panel.locator(".nw-np-row")).toHaveCount(103);
  await expect(panel.getByRole("button", { name: "加载更多通知" })).toHaveCount(0);
  await expect(panel.locator('a[href="/messages/last-thread"]')).toBeVisible();
  await panel.locator(".nw-np-row").last().getByRole("button", { name: "标记已读" }).click();
  await expect(panel.locator(".nw-np-row").last().getByRole("button", { name: "标记已读" })).toHaveCount(0);
  await expect(panel.locator(".nw-np-row")).toHaveCount(103);
  await panel.getByRole("button", { name: "全部标为已读" }).click();
  await expect(panel.getByRole("button", { name: "标记已读" })).toHaveCount(0);
  await expect(page.locator(".nw-bdg")).toHaveCount(0);
});

test("writing desk loads old notifications and marks one without discarding loaded pages", async ({ page }) => {
  await registerThroughForm(page, uniqueEmail("paged-inbox"), "/write");
  const items = manyNotifications(52);
  await page.route(pathIs("/api/authoring/notifications/unread-count"), (route) => route.fulfill({ json: { data: items.filter((row) => row.readAt === null).length } }));
  await page.route(pathIs("/api/authoring/notifications"), (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    return route.fulfill({ json: { data: cursor ? items.slice(50) : items.slice(0, 50) } });
  });
  await page.route((url) => url.pathname.startsWith("/api/authoring/notifications/") && url.pathname.endsWith("/read"), (route) => {
    const id = route.request().url().split("/").at(-2);
    const row = items.find((entry) => entry.id === id);
    expect(row).toBeTruthy();
    row!.readAt = "2026-01-02T00:00:00.000Z";
    return route.fulfill({ json: { data: row } });
  });
  await page.reload();
  const inbox = page.getByRole("region", { name: "通知" });
  await expect(inbox).toContainText("52 未读");
  await expect(inbox.locator(".nw-authoring-inbox-row")).toHaveCount(50);
  await inbox.getByRole("button", { name: "加载更多通知" }).click();
  await expect(inbox.locator(".nw-authoring-inbox-row")).toHaveCount(52);
  await expect(inbox.locator('a[href="/messages/last-thread"]')).toBeVisible();
  await inbox.locator(".nw-authoring-inbox-row").last().getByRole("button", { name: "标记已读" }).click();
  await expect(inbox).toContainText("51 未读");
  await expect(inbox.locator(".nw-authoring-inbox-row")).toHaveCount(52);
  await expect(inbox.getByRole("button", { name: "加载更多通知" })).toHaveCount(0);
});
