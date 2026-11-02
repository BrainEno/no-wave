import { expect, type Page } from "@playwright/test";

/**
 * An account opened in a browser, through the form a visitor uses.
 *
 * Registering over HTTP would be one line shorter and one session longer: the
 * registration mints a session of its own and it stays live, so an account made
 * that way arrives at a private screen already signed in from somewhere the test
 * never visited. The device list is the obvious case — it would show a device
 * the journey never used — but the same is true of any screen behind a session,
 * so this is how every one of them opens an account.
 *
 * `next` is where the sign-in form sends the visitor afterwards, which is also
 * how the redirect-away-and-come-back journey is asserted.
 */
const PASSWORD = "e2e-browser-password";

export const BROWSER_PASSWORD = PASSWORD;

export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

export async function registerThroughForm(page: Page, email: string, next = "/account"): Promise<void> {
  await page.goto(`/sign-in?next=${encodeURIComponent(next)}`);
  // A click that lands before React hydrates is silently dropped, so the mode
  // switch is retried until its effect shows up.
  await expect(async () => {
    await page.getByRole("button", { name: /没有账户？创建账户/ }).click();
    await expect(page.getByRole("button", { name: "创建账户并继续" })).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 45_000 });
  await expect(async () => {
    await page.getByLabel("邮箱").fill(email);
    await page.getByLabel("密码").fill(PASSWORD);
    await page.getByRole("button", { name: "创建账户并继续" }).click();
    await page.waitForURL(`**${next}`, { timeout: 5_000 });
  }).toPass({ timeout: 60_000, intervals: [500, 1_000, 2_000] });
}
