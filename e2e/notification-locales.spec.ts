import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { test } from "./support/csp-fixture.ts";
import { interceptNotifications } from "./support/notification-api.ts";
import { holdAnimationFrames } from "./support/animation-frame-gate.ts";

async function fixture(page: Page, baseURL: string, count = 3) {
  const origin = new URL(baseURL).origin;
  await page.context().addCookies([{ name: "nw_session", value: String(Math.floor(Date.now() / 1000) + 3600), url: origin }]);
  await page.route(url => url.pathname === "/api/authoring/session", route => route.fulfill({ json: { data: { id: "locale-inbox-reader" } } }));
  return interceptNotifications(page, count);
}

test("the real bilingual inbox translates every row and preserves known payload editions and unknown destinations", async ({ page, baseURL }) => {
  const api = await fixture(page, baseURL!);
  api.items[0]!.payload = JSON.stringify({ type: "article.commented", slug: "english-work", locale: "en" });
  api.items[1]!.payload = JSON.stringify({ type: "future.event" });
  api.items[2]!.payload = JSON.stringify({ type: "article.liked", slug: "chinese-work", locale: "zh-CN" });
  await page.goto("/en/notifications");
  const en = page.getByRole("region", { name: "Notifications", exact: true });
  await expect(en.locator(".nw-authoring-inbox-row")).toHaveCount(3);
  await expect(en).toContainText("Someone commented on your work.");
  await expect(en).toContainText("You have a notification.");
  await expect(en.locator("time").first()).toHaveText("11.01.2026");
  await expect(en.locator('a[href="/en/articles/english-work#nw-comments-title"]')).toBeVisible();
  await expect(en.locator('a[href="/articles/chinese-work"]')).toBeVisible();
  await expect(en.locator('.nw-authoring-inbox-row a[href^="/en/notifications?notice="]')).toBeVisible();
  const violations = (await new AxeBuilder({ page }).analyze()).violations.filter(result => result.impact === "serious" || result.impact === "critical");
  expect(violations.map(result => ({ id: result.id, nodes: result.nodes.map(node => node.target) }))).toEqual([]);
  await page.locator('.nw-pill a.nw-lang[lang="zh-CN"]').click();
  await expect(page).toHaveURL(/\/notifications$/);
  const zh = page.getByRole("region", { name: "通知", exact: true });
  await expect(zh.locator(".nw-authoring-inbox-row")).toHaveCount(3);
  await expect(zh).toContainText("有人评论了你的作品。");
  await expect(zh.locator("time").first()).toHaveText("2026.11.01");
  await expect(zh.locator('a[href="/en/articles/english-work#nw-comments-title"]')).toBeVisible();
  await expect(zh.locator('.nw-authoring-inbox-row a[href^="/notifications?notice="]')).toBeVisible();
  expect(api.calls.filter(call => call.method !== "GET")).toEqual([]);
});

test("localized filters describe loaded data honestly and keep keyset history and keyboard focus after reads", async ({ page, baseURL }) => {
  const api = await fixture(page, baseURL!, 52);
  for (const item of api.items.slice(50)) item.payload = JSON.stringify({ type: "message.created", conversationId: "older-thread" });
  await page.goto("/en/notifications?view=unread&kind=messages");
  const inbox = page.getByRole("region", { name: "Notifications", exact: true });
  const rows = inbox.locator(".nw-authoring-inbox-row");
  await expect(inbox).toContainText("No loaded notifications match these filters.");
  await expect(inbox).toContainText("Older notifications may still match.");
  await expect(inbox).toContainText("50 loaded, 50 unread here; 52 unread in the whole inbox");
  await inbox.getByRole("button", { name: "Load more notifications", exact: true }).click();
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(rows.last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(rows.last()).toBeFocused();
  await rows.first().getByRole("button", { name: "Mark read", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toBeFocused();
  await expect(inbox.getByRole("status")).toHaveText("Notification marked read.");
  await inbox.getByRole("link", { name: "Read", exact: true }).click();
  await expect(page).toHaveURL(/view=read&kind=messages$/);
  await expect(rows).toHaveCount(1);
  await expect(rows.getByRole("button", { name: "Mark read", exact: true })).toHaveCount(0);
  expect(api.calls.filter(call => call.path === "/api/authoring/notifications")).toHaveLength(2);
  expect(api.calls.filter(call => call.method === "PUT")).toHaveLength(1);
  await page.goBack();
  await expect(page).toHaveURL(/view=unread&kind=messages$/);
  await expect(rows).toHaveCount(1);
  await page.goForward();
  await expect(page).toHaveURL(/view=read&kind=messages$/);
  await page.locator('.nw-pill a.nw-lang[lang="zh-CN"]').click();
  await expect(page).toHaveURL(/\/notifications\?view=read&kind=messages$/);
  await expect(page.getByRole("link", { name: "已读", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByLabel("通知类型", { exact: true })).toHaveValue("messages");
});

test("a late read completion cannot steal focus after an outside non-focusable pointer action", async ({ page, baseURL }) => {
  const api = await fixture(page, baseURL!);
  await page.goto("/en/notifications");
  const inbox = page.getByRole("region", { name: "Notifications", exact: true });
  await expect(inbox.locator(".nw-authoring-inbox-row")).toHaveCount(3);
  const held = api.holdNext("write");
  try {
    await inbox.getByRole("button", { name: "Mark read", exact: true }).first().click();
    await held.started;
    await page.locator(".nw-fbar > span").click();
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    held.release();
    await held.finished;
    await expect(inbox.getByRole("button", { name: "Mark read", exact: true })).toHaveCount(2);
    await expect(inbox.getByRole("status")).toHaveText("Notification marked read.");
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  } finally { held.release(); }
});

test("a forged page hint never supplies notification identity, and authorization failure clears the English inbox", async ({ page, baseURL }) => {
  const api = await fixture(page, baseURL!);
  await page.goto("/en/notifications");
  const inbox = page.getByRole("region", { name: "Notifications", exact: true });
  await expect(inbox.locator(".nw-authoring-inbox-row")).toHaveCount(3);
  api.failCounts(401);
  await inbox.getByRole("button", { name: "Refresh notifications", exact: true }).click();
  await expect(inbox.locator(".nw-authoring-inbox-row")).toHaveCount(0);
  await expect(page.locator(".nw-bdg")).toHaveCount(0);
  await expect(inbox).toContainText("Sign in to read your notifications.");
  await expect(inbox.getByRole("link", { name: "Sign in again", exact: true })).toHaveAttribute("href", "/sign-in?next=%2Fen%2Fnotifications");
  expect(api.calls.filter(call => call.method !== "GET")).toHaveLength(0);
});

for (const mobile of [false, true]) {
  test(`the ${mobile ? "mobile" : "desktop"} language control keeps all four formerly dropped pages in both directions`, async ({ page, baseURL }) => {
    await fixture(page, baseURL!);
    // These assertions concern route continuity, not domain data. A fixed
    // unavailable response keeps the actual router without granting credentials.
    await page.route(url => /^\/api\/authoring\/(feed|inbox)(\/|$)/.test(url.pathname), route => route.fulfill({ status: 503, json: { error: { code: "SERVICE_UNAVAILABLE" } } }));
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    for (const path of ["/authors", "/feed", "/messages", "/messages/thread-17"]) {
      await page.goto(path);
      if (mobile) {
        await page.getByRole("button", { name: "选单", exact: true }).click();
        await page.getByRole("dialog", { name: "选单", exact: true }).getByRole("link", { name: "切换语言", exact: true }).click();
      } else await page.locator('.nw-pill a.nw-lang[lang="en"]').click();
      await expect(page).toHaveURL(new RegExp(`/en${path}$`));
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      await expect(page.locator("main")).toBeFocused();
      if (mobile) {
        await expect(page.getByRole("dialog", { name: "Menu", exact: true })).toBeHidden();
        await expect(page.locator("main")).toBeFocused();
        await page.getByRole("button", { name: "Menu", exact: true }).click();
        await page.getByRole("dialog", { name: "Menu", exact: true }).getByRole("link", { name: "Switch language", exact: true }).click();
      } else await page.locator('.nw-pill a.nw-lang[lang="zh-CN"]').click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    }
  });
}

test("an unknown bell notice opens and focuses that exact inbox row in either language without marking it read", async ({ page, baseURL }) => {
  const api = await fixture(page, baseURL!);
  api.items[1]!.payload = JSON.stringify({ type: "future.event" });
  const id = api.items[1]!.id;
  await page.goto("/en");
  await page.getByRole("button", { name: /^Notifications/ }).click();
  const panel = page.getByRole("dialog", { name: "Notifications", exact: true });
  const view = panel.locator(".nw-np-row").nth(1).getByRole("link", { name: "View", exact: true });
  await expect(view).toHaveAttribute("href", `/en/notifications?notice=${id}`);
  await view.click();
  await expect(page).toHaveURL(new URL(`/en/notifications?notice=${id}`, baseURL!).href);
  const row = page.locator(`.nw-authoring-inbox-row[data-notification-id="${id}"]`);
  await expect(row).toBeFocused();
  await expect(panel).toBeHidden();
  await expect(row.getByRole("button", { name: "Mark read", exact: true })).toBeVisible();
  await page.locator('.nw-pill a.nw-lang[lang="zh-CN"]').click();
  await expect(page).toHaveURL(new URL(`/notifications?notice=${id}`, baseURL!).href);
  await expect(row).toBeFocused();
  await expect(row.getByRole("button", { name: "标记已读", exact: true })).toBeVisible();
  expect(api.calls.filter(call => call.method !== "GET")).toHaveLength(0);
});

test("a delayed selected row never steals a filter's focus and offers an explicit keyboard jump instead", async ({ page, baseURL }) => {
  const api = await fixture(page, baseURL!);
  const id = api.items[1]!.id;
  const held = api.holdNext("page");
  try {
    await page.goto(`/en/notifications?notice=${id}`);
    await held.started;
    const filter = page.getByLabel("Notification type", { exact: true });
    await filter.focus();
    held.release();
    await held.finished;
    const jump = page.getByRole("button", { name: "Jump to selected notification", exact: true });
    await expect(jump).toBeVisible();
    await expect(filter).toBeFocused();
    await jump.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(`.nw-authoring-inbox-row[data-notification-id="${id}"]`)).toBeFocused();
    expect(api.calls.filter(call => call.path === "/api/authoring/notifications")).toHaveLength(1);
  } finally { held.release(); }
});

test("selected older or filtered notices never trigger an automatic scan or a fake empty inbox", async ({ page, baseURL }) => {
  const api = await fixture(page, baseURL!, 52);
  const id = api.items[51]!.id;
  await page.goto(`/en/notifications?notice=${id}`);
  const selection = page.getByRole("complementary", { name: "Selected notification", exact: true });
  await expect(selection).toContainText("older history is never scanned automatically");
  expect(api.calls.filter(call => call.path === "/api/authoring/notifications")).toHaveLength(1);
  await page.getByRole("button", { name: "Load more notifications", exact: true }).click();
  const target = page.locator(`.nw-authoring-inbox-row[data-notification-id="${id}"]`);
  await selection.getByRole("button", { name: "Jump to selected notification", exact: true }).click();
  await expect(target).toBeFocused();
  expect(api.calls.filter(call => call.path === "/api/authoring/notifications")).toHaveLength(2);
  await page.getByRole("navigation", { name: "Notification filters", exact: true }).getByRole("link", { name: "Read", exact: true }).click();
  await expect(selection).toContainText("hidden by these filters");
  await expect(page.getByRole("button", { name: "Jump to selected notification", exact: true })).toHaveCount(0);
  await selection.getByRole("link", { name: "Show without filters", exact: true }).click();
  await expect(target).toBeFocused();
  expect(api.calls.filter(call => call.method !== "GET")).toHaveLength(0);
  expect(api.calls.filter(call => call.path === "/api/authoring/notifications")).toHaveLength(2);
});

test("an outside pointer intent between a read commit and its queued focus repair still wins", async ({ page, baseURL }) => {
  const api = await fixture(page, baseURL!);
  await page.goto("/en/notifications");
  const inbox = page.getByRole("region", { name: "Notifications", exact: true });
  const mark = inbox.getByRole("button", { name: "Mark read", exact: true }).first();
  await expect(inbox.locator(".nw-authoring-inbox-row")).toHaveCount(3);
  await mark.focus();
  const releaseFrames = await holdAnimationFrames(page);
  try {
    await page.keyboard.press("Enter");
    await expect(inbox.getByRole("button", { name: "Mark read", exact: true })).toHaveCount(2);
    await expect(inbox.getByRole("status")).toHaveText("Notification marked read.");
    const outside = await page.locator(".nw-fbar > span").evaluate(element => {
      element.scrollIntoView({ block: "center" });
      const box = element.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
    await page.mouse.click(outside.x, outside.y);
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    await releaseFrames();
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    expect(api.calls.filter(call => call.method === "PUT")).toHaveLength(1);
  } finally { await releaseFrames(); }
});

test("scrolling while a read is pending cancels its automatic focus and scroll repair", async ({ page, baseURL }) => {
  const api = await fixture(page, baseURL!, 12);
  await page.goto("/en/notifications");
  const inbox = page.getByRole("region", { name: "Notifications", exact: true });
  const held = api.holdNext("write");
  try {
    await inbox.getByRole("button", { name: "Mark read", exact: true }).first().click();
    await held.started;
    await page.mouse.wheel(0, 500);
    held.release();
    await held.finished;
    await expect(inbox.getByRole("status")).toHaveText("Notification marked read.");
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    expect(api.calls.filter(call => call.method !== "GET")).toHaveLength(1);
  } finally { held.release(); }
});

test("a selected locator cannot auto-follow an account replacement before its first paint", async ({ page, baseURL }) => {
  const api = await fixture(page, baseURL!);
  api.items[0]!.payload = JSON.stringify({ type: "future.event" });
  const id = api.items[0]!.id;
  await page.goto("/en");
  await page.getByRole("button", { name: /^Notifications/ }).click();
  const panel = page.getByRole("dialog", { name: "Notifications", exact: true });
  const view = panel.locator(".nw-np-row").first().getByRole("link", { name: "View", exact: true });
  await view.focus();
  const releaseFrames = await holdAnimationFrames(page);
  try {
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new URL(`/en/notifications?notice=${id}`, baseURL!).href);
    const row = page.locator(`.nw-authoring-inbox-row[data-notification-id="${id}"]`);
    await expect(row).toBeVisible();
    await page.route(url => url.pathname === "/api/authoring/session", route => route.fulfill({ json: { data: { id: "replacement-locale-reader" } } }));
    const replacedRead = page.waitForRequest(request => request.url().includes("/api/authoring/notifications") && request.headers()["x-expected-notification-actor"] === "replacement-locale-reader");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await replacedRead;
    await expect(row).toBeVisible();
    await releaseFrames();
    await expect(row).not.toBeFocused();
    const jump = page.getByRole("button", { name: "Jump to selected notification", exact: true });
    await jump.focus();
    await page.keyboard.press("Enter");
    await expect(row).toBeFocused();
    expect(api.calls.filter(call => call.method !== "GET")).toHaveLength(0);
  } finally { await releaseFrames(); }
});

test("new outside input after a navigation commit cancels the chrome's queued destination focus", async ({ page, baseURL }) => {
  const api = await fixture(page, baseURL!);
  await page.goto("/en");
  await page.getByRole("button", { name: /^Notifications/ }).click();
  const panel = page.getByRole("dialog", { name: "Notifications", exact: true });
  await panel.getByRole("link", { name: "Open notification inbox", exact: true }).focus();
  const releaseFrames = await holdAnimationFrames(page);
  try {
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/en\/notifications$/);
    await expect(panel).toBeHidden();
    const outside = await page.locator(".nw-fbar > span").evaluate(element => {
      element.scrollIntoView({ block: "center" });
      const box = element.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
    await page.mouse.click(outside.x, outside.y);
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    await releaseFrames();
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    expect(api.calls.filter(call => call.method !== "GET")).toHaveLength(0);
  } finally { await releaseFrames(); }
});
