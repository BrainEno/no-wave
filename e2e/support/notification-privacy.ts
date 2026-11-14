import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { uniqueEmail } from "./accounts.ts";

const PASSWORD = "disposable-notification-privacy-password";
export const NOTIFICATION_ACTOR_HEADER = "x-expected-notification-actor";
async function register(context: BrowserContext, origin: string) {
  const email = uniqueEmail("notification-privacy");
  const registered = await context.request.post(`${origin}/api/auth/register`, {
    headers: { origin }, data: { email, password: PASSWORD },
  });
  expect(registered.status()).toBe(201);
  const session = await context.request.get(`${origin}/api/authoring/session`);
  expect(session.status()).toBe(200);
  return { email, id: (await session.json()).data.id as string };
}
export async function loginNotificationAccount(context: BrowserContext, origin: string, email: string) {
  const response = await context.request.post(`${origin}/api/auth/login`, { headers: { origin }, data: { email, password: PASSWORD } });
  expect(response.status()).toBe(200);
}
export async function unreadNotifications(context: BrowserContext, origin: string) {
  const response = await context.request.get(`${origin}/api/authoring/notifications/unread-count`);
  expect(response.status()).toBe(200);
  return (await response.json()).data as number;
}
export async function notificationAccounts(browser: Browser, page: Page, origin: string) {
  const other = await browser.newContext({ baseURL: origin });
  try {
    const replacement = await register(other, origin);
    const original = await register(page.context(), origin);
    for (const [context, target] of [[other, original.id], [page.context(), replacement.id]] as const) {
      const response = await context.request.post(`${origin}/api/authoring/users/${target}/follow?locale=zh-CN`, { headers: { origin } });
      expect(response.status()).toBe(200);
    }
    expect(await unreadNotifications(other, origin)).toBe(1);
    expect(await unreadNotifications(page.context(), origin)).toBe(1);
    return { other, original, replacement };
  } catch (error) { await other.close(); throw error; }
}
export async function openNotificationSurfaces(page: Page) {
  await page.goto("/write");
  const inbox = page.getByRole("region", { name: "通知", exact: true });
  await expect(inbox.locator(".nw-authoring-inbox-row")).toHaveCount(1);
  await page.getByRole("button", { name: /^通知/ }).click();
  const bell = page.getByRole("dialog", { name: "通知", exact: true });
  await expect(bell.locator(".nw-np-row")).toHaveCount(1);
  return { inbox, bell };
}
