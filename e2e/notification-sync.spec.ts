import { expect, test, type Page } from "@playwright/test";
import { registerThroughForm, uniqueEmail } from "./support/accounts.ts";
import { interceptNotifications } from "./support/notification-api.ts";

async function signedInDesk(page: Page, count = 3) {
  await registerThroughForm(page, uniqueEmail("notification-sync"), "/write");
  const api = await interceptNotifications(page, count);
  await page.reload();
  const inbox = page.getByRole("region", { name: "通知", exact: true });
  await expect(inbox.locator(".nw-authoring-inbox-row")).toHaveCount(Math.min(count, 50));
  await page.getByRole("button", { name: /^通知/ }).click();
  const bell = page.getByRole("dialog", { name: "通知", exact: true });
  await expect(bell.locator(".nw-np-row")).toHaveCount(Math.min(count, 50));
  return { api, inbox, bell };
}

test("marking one desk notification also updates the open bell and its badge", async ({ page }) => {
  const { inbox, bell } = await signedInDesk(page);
  await inbox.locator(".nw-authoring-inbox-row").first().getByRole("button", { name: "标记已读", exact: true }).click();
  await expect(inbox.getByRole("button", { name: "标记已读", exact: true })).toHaveCount(2);
  await expect(bell.getByRole("button", { name: "标记已读", exact: true })).toHaveCount(2);
  await expect(page.locator(".nw-bdg")).toHaveText("2");
});

test("marking all in the bell clears the already-mounted desk without reopening either surface", async ({ page }) => {
  const { inbox, bell } = await signedInDesk(page);
  await bell.getByRole("button", { name: "全部标为已读", exact: true }).click();
  await expect(page.locator(".nw-bdg")).toHaveCount(0);
  await expect(bell.getByRole("button", { name: "标记已读", exact: true })).toHaveCount(0);
  await expect(inbox.getByRole("button", { name: "标记已读", exact: true })).toHaveCount(0);
  await expect(inbox).not.toContainText("3 未读");
});

test("a rejected read leaves both unread lists intact and never displays an upstream diagnostic", async ({ page }) => {
  const { api, inbox, bell } = await signedInDesk(page);
  api.failWrites(503);
  await inbox.locator(".nw-authoring-inbox-row").first().getByRole("button", { name: "标记已读", exact: true }).click();
  await expect(inbox.getByRole("alert")).toContainText("刷新通知");
  await expect(bell.getByRole("alert")).toBeVisible();
  for (const view of [inbox, bell]) {
    await expect(view.getByRole("button", { name: "标记已读", exact: true })).toHaveCount(3);
    await expect(view).not.toContainText("synthetic-private-upstream-detail");
  }
  await expect(page.locator(".nw-bdg")).toHaveText("3");
  api.failWrites(200);
  await inbox.locator(".nw-authoring-inbox-row").first().getByRole("button", { name: "标记已读", exact: true }).click();
  await expect(bell.getByRole("button", { name: "标记已读", exact: true })).toHaveCount(2);
});

test("an accepted write with a failed total refresh stays visibly stale, then reconciles without replaying the write", async ({ page }) => {
  const { api, inbox, bell } = await signedInDesk(page);
  api.failCounts(503);
  await inbox.locator(".nw-authoring-inbox-row").first().getByRole("button", { name: "标记已读", exact: true }).click();
  await expect(inbox.getByRole("alert")).toBeVisible();
  await expect(bell.getByRole("button", { name: "标记已读", exact: true })).toHaveCount(2);
  await expect(page.locator(".nw-bdg")).toHaveText("3");
  await expect(inbox).toContainText("上次确认的值");
  api.failCounts(200);
  await bell.getByRole("button", { name: "刷新通知", exact: true }).click();
  await expect(page.locator(".nw-bdg")).toHaveText("2");
  await expect(inbox.getByRole("alert")).toHaveCount(0);
  expect(api.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
});

test("a 401 on either half of refresh removes private rows and the badge from both surfaces", async ({ page }) => {
  const { api, inbox, bell } = await signedInDesk(page);
  api.failCounts(401);
  await inbox.getByRole("button", { name: "刷新通知", exact: true }).click();
  await expect(page.locator(".nw-authoring-inbox-row, .nw-np-row")).toHaveCount(0);
  await expect(page.locator(".nw-bdg")).toHaveCount(0);
  await expect(bell.getByRole("link", { name: /登录/ })).toBeVisible();
  await expect(bell.getByRole("button", { name: "全部标为已读", exact: true })).toHaveCount(0);
});

test("returning online reconciles an errored feed from the first page without polling or losing the other surface", async ({ page }) => {
  const { api, inbox, bell } = await signedInDesk(page);
  api.failLists(503);
  await inbox.getByRole("button", { name: "刷新通知", exact: true }).click();
  await expect(inbox.getByRole("alert")).toBeVisible();
  api.items.unshift({ ...api.items[0]!, id: "50000000-0000-4000-8000-000000000001", eventKey: "new-arrival", payload: '{"type":"message.created","conversationId":"returned-online"}' });
  api.failLists(200);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(inbox.locator(".nw-authoring-inbox-row")).toHaveCount(4);
  await expect(bell.locator(".nw-np-row")).toHaveCount(4);
  await expect(page.locator(".nw-bdg")).toHaveText("4");
  await expect(bell.locator('a[href="/messages/returned-online"]')).toBeVisible();
});

test("a fractional total is an error, not a zero badge or a rounded authoritative count", async ({ page }) => {
  const { api, inbox, bell } = await signedInDesk(page);
  api.countBody({ data: 0.5 });
  await bell.getByRole("button", { name: "刷新通知", exact: true }).click();
  await expect(bell.getByRole("alert")).toContainText("格式不正确");
  await expect(inbox.getByRole("alert")).toContainText("格式不正确");
  await expect(page.locator(".nw-bdg")).toHaveText("3");
  api.countBody({ data: 3 });
  await inbox.getByRole("button", { name: "刷新通知", exact: true }).click();
  await expect(inbox.getByRole("alert")).toHaveCount(0);
  await expect(bell.getByRole("alert")).toHaveCount(0);
});

test("shared pagination labels loaded and global unread counts, and a read beyond page one preserves all loaded history", async ({ page }) => {
  const { inbox, bell } = await signedInDesk(page, 52);
  await expect(inbox).toContainText("已载入 50 条，其中 50 条未读；全收件箱 52 条未读");
  await expect(bell).toContainText("未读数包含尚未载入的通知");
  await inbox.getByRole("button", { name: "加载更多通知", exact: true }).click();
  await expect(inbox.locator(".nw-authoring-inbox-row")).toHaveCount(52);
  await expect(bell.locator(".nw-np-row")).toHaveCount(52);
  await bell.locator(".nw-np-row").last().getByRole("button", { name: "标记已读", exact: true }).click();
  await expect(inbox).toContainText("已载入 52 条，其中 51 条未读；全收件箱 51 条未读");
  await expect(page.locator(".nw-bdg")).toHaveText("51");
  await expect(inbox.locator(".nw-authoring-inbox-row")).toHaveCount(52);
});

test("logout clears the mounted bell and desk before the logout network request finishes", async ({ page }) => {
  const { bell } = await signedInDesk(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route((url) => url.pathname === "/api/auth/logout", async (route) => {
    await held;
    await route.fulfill({ json: { data: true } });
  });
  try {
    await page.getByRole("button", { name: "退出登录", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".nw-authoring-inbox-row, .nw-np-row")).toHaveCount(0);
    await expect(page.locator(".nw-bdg")).toHaveCount(0);
    await expect(bell.getByRole("link", { name: /登录/ })).toBeVisible();
  } finally { release(); }
});

test("an empty recent page with an authoritative unread total still offers mark-all and explains the mismatch", async ({ page }) => {
  const { api, inbox, bell } = await signedInDesk(page);
  api.items.length = 0;
  api.countBody({ data: 3 });
  await inbox.getByRole("button", { name: "刷新通知", exact: true }).click();
  await expect(inbox).toContainText("尚有未读通知，请刷新以取得最新列表");
  await expect(bell).toContainText("已载入 0 条，其中 0 条未读；全收件箱 3 条未读");
  await expect(bell.getByRole("button", { name: "全部标为已读", exact: true })).toBeEnabled();
  api.countBody({ data: 0 });
  await bell.getByRole("button", { name: "全部标为已读", exact: true }).click();
  await expect(page.locator(".nw-bdg")).toHaveCount(0);
  await expect(inbox.getByRole("button", { name: "全部标为已读", exact: true })).toHaveCount(0);
});

test("a late badge-only answer cannot replace the total from the now-visible shared feed", async ({ page }) => {
  await registerThroughForm(page, uniqueEmail("late-notification-count"), "/");
  const api = await interceptNotifications(page);
  api.countBody({ data: 99 });
  const oldCount = api.holdNext("count");
  try {
    await page.reload();
    await oldCount.started;
    api.countBody({ data: 3 });
    await page.getByRole("button", { name: /^通知/ }).click();
    const bell = page.getByRole("dialog", { name: "通知", exact: true });
    await expect(bell.locator(".nw-np-row")).toHaveCount(3);
    await expect(page.locator(".nw-bdg")).toHaveText("3");
    oldCount.release();
    await oldCount.finished;
    await expect(page.locator(".nw-bdg")).toHaveText("3");
    await expect(bell).toContainText("全收件箱 3 条未读");
  } finally { oldCount.release(); }
});

test("an older page cannot repopulate either surface after recovery replaces a session with the same readable hint", async ({ page }) => {
  const { api, inbox, bell } = await signedInDesk(page, 52);
  const oldPage = api.holdNext("more");
  try {
    await inbox.getByRole("button", { name: "加载更多通知", exact: true }).click();
    await oldPage.started;
    api.items.splice(0, api.items.length, {
      ...api.items[0]!, id: "60000000-0000-4000-8000-000000000001", eventKey: "replacement-notification",
      payload: '{"type":"message.created","conversationId":"replacement-inbox"}',
    });
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(inbox.locator(".nw-authoring-inbox-row")).toHaveCount(1);
    await expect(bell.locator(".nw-np-row")).toHaveCount(1);
    oldPage.release();
    await oldPage.finished;
    await expect(page.locator(".nw-bdg")).toHaveText("1");
    for (const view of [inbox, bell]) {
      await expect(view.locator('a[href="/messages/replacement-inbox"]')).toBeVisible();
      await expect(view.getByRole("button", { name: "标记已读", exact: true })).toHaveCount(1);
      await expect(view.getByRole("button", { name: "加载更多通知", exact: true })).toHaveCount(0);
    }
  } finally { oldPage.release(); }
});
