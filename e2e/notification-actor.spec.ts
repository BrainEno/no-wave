import { expect } from "@playwright/test";
import { test } from "./support/csp-fixture.ts";
import { gate, settleUi } from "./support/messaging-privacy.ts";
import { NOTIFICATION_ACTOR_HEADER, loginNotificationAccount, notificationAccounts, openNotificationSurfaces, unreadNotifications } from "./support/notification-privacy.ts";

for (const action of ["all", "one"] as const) {
  test(`a stale notification ${action} read cannot mutate a real replacement account before any focus recovery`, async ({ browser, page, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    const accounts = await notificationAccounts(browser, page, origin);
    try {
      const { inbox, bell } = await openNotificationSurfaces(page);
      await expect(bell.locator(`a[href="/authors/${accounts.replacement.id}"]`)).toBeVisible();
      await loginNotificationAccount(page.context(), origin, accounts.replacement.email);
      const submitted: { actor: string | undefined; body: string | null }[] = [];
      page.on("request", (request) => {
        if (request.method() === "GET" || !request.url().includes("/api/authoring/notifications")) return;
        submitted.push({ actor: request.headers()[NOTIFICATION_ACTOR_HEADER], body: request.postData() });
      });
      const response = page.waitForResponse((response) => response.request().method() === (action === "all" ? "POST" : "PUT") && response.url().includes("/api/authoring/notifications"));
      await bell.getByRole("button", { name: action === "all" ? "全部标为已读" : "标记已读", exact: true }).click();
      expect((await response).status()).toBe(409);
      await expect(page.locator(".nw-authoring-inbox-row, .nw-np-row, .nw-bdg")).toHaveCount(0);
      for (const surface of [inbox, bell]) await expect(surface.getByRole("alert")).toContainText("账户已变更");
      expect(await unreadNotifications(accounts.other, origin)).toBe(1);
      await settleUi(page);
      expect(submitted).toEqual([{ actor: accounts.original.id, body: null }]);
      await inbox.getByRole("button", { name: "刷新通知", exact: true }).click();
      for (const surface of [inbox, bell]) {
        await expect(surface.locator(`a[href="/authors/${accounts.original.id}"]`)).toBeVisible();
        await expect(surface.locator(`a[href="/authors/${accounts.replacement.id}"]`)).toHaveCount(0);
      }
      expect(await unreadNotifications(accounts.other, origin)).toBe(1);
      expect(submitted).toHaveLength(1);
      await loginNotificationAccount(page.context(), origin, accounts.original.email);
      expect(await unreadNotifications(page.context(), origin)).toBe(1);
    } finally { await accounts.other.close(); }
  });
}

test("pagehide removes both notification DOMs and the badge before the event returns", async ({ browser, page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const accounts = await notificationAccounts(browser, page, origin);
  const entered = gate(), release = gate();
  try {
    const { inbox, bell } = await openNotificationSurfaces(page);
    let checks = 0, mutations = 0;
    await page.route("**/api/authoring/session", async (route) => {
      checks++;
      entered.release();
      await release.promise;
      await route.continue();
    });
    page.on("request", (request) => {
      if (request.url().includes("/api/authoring/notifications") && request.method() !== "GET") mutations++;
    });
    const hidden = await page.evaluate(() => {
      window.dispatchEvent(new Event("pagehide"));
      return document.querySelectorAll(".nw-authoring-inbox-row, .nw-np-row, .nw-bdg").length;
    });
    expect(hidden).toBe(0);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await settleUi(page);
    expect(checks).toBe(0);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await entered.promise;
    await expect(page.locator(".nw-authoring-inbox-row, .nw-np-row, .nw-bdg")).toHaveCount(0);
    release.release();
    await expect(inbox.locator(".nw-authoring-inbox-row")).toHaveCount(1);
    await expect(bell.locator(".nw-np-row")).toHaveCount(1);
    await expect(page.locator(".nw-bdg")).toHaveText("1");
    expect(checks).toBe(1);
    expect(mutations).toBe(0);
  } finally { release.release(); await accounts.other.close(); }
});
