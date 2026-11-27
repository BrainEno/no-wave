import { expect, type BrowserContext } from "@playwright/test";
// Phase gate: reconnect/offline recovery with real authentication. Every
// notification here is created by a real follow on the disposable real stack,
// not by an intercepted API response.
import { test } from "./support/article-view-stack.ts";
import { uniqueEmail } from "./support/accounts.ts";
import {
  notificationAccounts,
  openNotificationSurfaces,
  unreadNotifications,
} from "./support/notification-privacy.ts";

const PASSWORD = "disposable-offline-recovery-password";

/** A separate, online account that follows the target: one real notification. */
async function followFrom(
  browser: import("@playwright/test").Browser,
  origin: string,
  targetId: string,
): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: origin });
  try {
    const registered = await context.request.post(
      `${origin}/api/auth/register`,
      {
        headers: { origin },
        data: {
          email: uniqueEmail("notification-offline"),
          password: PASSWORD,
        },
      },
    );
    expect(registered.status()).toBe(201);
    const followed = await context.request.post(
      `${origin}/api/authoring/users/${targetId}/follow?locale=zh-CN`,
      { headers: { origin } },
    );
    expect(followed.status()).toBe(200);
    return context;
  } catch (error) {
    await context.close();
    throw error;
  }
}

test("going offline keeps shown notifications, and returning online reconciles with the server once", async ({
  browser,
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const accounts = await notificationAccounts(browser, page, origin);
  const followers: BrowserContext[] = [];
  try {
    await openNotificationSurfaces(page);
    // Two more real notifications, so the offline check has several rows to keep.
    followers.push(await followFrom(browser, origin, accounts.original.id));
    followers.push(await followFrom(browser, origin, accounts.original.id));
    await page.reload();
    const inbox = page.getByRole("region", { name: "通知", exact: true });
    await expect(inbox.locator(".nw-authoring-inbox-row")).toHaveCount(3);
    await page.getByRole("button", { name: /^通知/ }).click();
    const bell = page.getByRole("dialog", { name: "通知", exact: true });
    const reopenBell = async () => {
      if (!(await bell.isVisible())) {
        await page.getByRole("button", { name: /^通知/ }).click();
      }
      await expect(bell).toBeVisible();
    };
    await expect(bell.locator(".nw-np-row")).toHaveCount(3);

    await page.context().setOffline(true);
    // Created while this page is offline: only the server knows about it yet.
    followers.push(await followFrom(browser, origin, accounts.original.id));

    await inbox.getByRole("button", { name: "刷新通知", exact: true }).click();
    await expect(inbox.getByRole("alert")).toBeVisible();
    // A failed read never removes rows the reader already has. Clicking the
    // inbox closes the non-modal bell; its store stays mounted, so reopen it.
    await expect(inbox.locator(".nw-authoring-inbox-row")).toHaveCount(3);
    await reopenBell();
    await expect(bell.locator(".nw-np-row")).toHaveCount(3);

    await page.context().setOffline(false);
    // Returning online reconciles from the first page without a manual click.
    // toHaveCount is exact, so a duplicated row would fail this check.
    await expect(inbox.locator(".nw-authoring-inbox-row")).toHaveCount(4, {
      timeout: 15_000,
    });
    await reopenBell();
    await expect(bell.locator(".nw-np-row")).toHaveCount(4);
    await expect(inbox.getByRole("alert")).toHaveCount(0);
    expect(await unreadNotifications(page.context(), origin)).toBe(4);
  } finally {
    await Promise.all(followers.map((context) => context.close()));
    await accounts.other.close();
  }
});
