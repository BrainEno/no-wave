import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { BROWSER_PASSWORD as PASSWORD, registerThroughForm, uniqueEmail } from "./support/accounts.ts";

/**
 * The list of signed-in devices, end to end in a real browser.
 *
 * Why this file exists: the two cheaper layers cannot see the one thing this
 * screen is for. The API tests prove that "end the others" spares the session
 * that asks, and the HTTP tests prove the proxy forwards it — but neither can
 * see a row disappear, a notice appear, or a visitor who taps 结束其他全部设备
 * and keeps reading. That is the class of failure the authoring suite was
 * written for ("every cheaper layer was green"), and it is why the device list
 * is exercised here too rather than only against the build.
 *
 * Rules of the layer (see docs/testing/end-to-end.md):
 * - selectors follow the accessibility tree; `data-*` appears only where the
 *   component uses it as its own contract for a device row;
 * - every test creates its own account, so nothing depends on another test;
 * - the browser does every interaction the assertions are actually about;
 * - assertions wait on durable outcomes (the row count, the notice, the ended
 *   device's own next request), so a transient state cannot turn them green.
 */

/** The API the Web application proxies to; both share one database. */
const API_BASE_URL = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:4000";

async function pageDigest(page: Page): Promise<string> {
  try {
    return (await page.locator("body").ariaSnapshot()).slice(0, 1200);
  } catch {
    return (await page.content()).slice(0, 1200);
  }
}

/**
 * Wait for the account page to have actually loaded.
 *
 * Not the page's own heading: the panel renders it while it is still asking the
 * API who the visitor is, and an assertion that matched that copy would pass on
 * a page that never finished. The devices heading only exists once the account
 * is loaded and the section is on screen.
 */
async function waitForAccount(page: Page): Promise<Locator> {
  const devices = page.locator("[data-account-devices]");
  try {
    await expect(devices.getByRole("heading", { name: /登录的设备/ })).toBeVisible({ timeout: 60_000 });
  } catch (caught) {
    throw new Error(`/account never loaded the device section; page:\n${await pageDigest(page)}\n${String(caught)}`);
  }
  return devices;
}

let traffic: string[] = [];
let consoleLog: string[] = [];

test.beforeEach(async ({ page }) => {
  traffic = [];
  consoleLog = [];
  const record = (line: string): void => { if (traffic.length < 40) traffic.push(line); };
  const recordConsole = (line: string): void => { if (consoleLog.length < 40) consoleLog.push(line); };
  page.on("console", (message) => recordConsole(`${message.type()}: ${message.text().slice(0, 300)}`));
  page.on("pageerror", (error) => recordConsole(`pageerror: ${String(error).slice(0, 300)}`));
  const watched = (url: string): boolean => /\/api\/(authoring|auth)/.test(url);
  page.on("request", (request) => {
    if (!watched(request.url())) return;
    record(`-> ${request.method()} ${new URL(request.url()).pathname}`);
  });
  page.on("response", (response) => {
    if (!watched(response.url())) return;
    record(`<- ${response.status()} ${new URL(response.url()).pathname}`);
  });
});

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== "failed" && testInfo.status !== "timedOut") return;
  console.log(
    `FAILED ${testInfo.title} at ${page.url()}\ntraffic:\n${traffic.join("\n")}\nconsole:\n${consoleLog.join("\n")}\n${await pageDigest(page)}`,
  );
});

test("the account page lists the signed-in devices, and ending the others leaves this one reading", async ({ page, request }) => {
  const email = uniqueEmail("devices");
  await registerThroughForm(page, email);
  await waitForAccount(page);

  // A second device, signed in over HTTP and never used again: it exists only
  // so that "end the others" has exactly one to end. The list is fetched when
  // the page mounts, so the page is reloaded to read it back.
  const second = await request.post(`${API_BASE_URL}/api/v1/auth/login`, {
    data: { email, password: PASSWORD },
  });
  expect(second.status(), `the second device signing in: ${await second.text()}`).toBe(200);
  const { refreshToken } = (await second.json()).data as { refreshToken: string };
  await page.reload();

  const devices = await waitForAccount(page);
  const rows = devices.locator("[data-device]");
  await expect(rows, "both devices are listed").toHaveCount(2, { timeout: 60_000 });
  await expect(devices.locator('[data-device-current="true"]')).toHaveCount(1);
  await expect(devices.getByText("这台设备")).toBeVisible();

  await page.getByRole("button", { name: "结束其他全部设备" }).click();

  // The durable outcome: the row is gone, the notice says how many went, and
  // the device that asked is still signed in.
  await expect(rows).toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByRole("status").filter({ hasText: "已让其他 1 台设备退出登录" })).toBeVisible();
  await expect(devices.locator('[data-device-current="true"]'), "the row that stayed is still this one").toHaveCount(1);

  const ended = await request.post(`${API_BASE_URL}/api/v1/auth/refresh`, { data: { refreshToken } });
  expect(ended.status(), "the ended device cannot refresh: its token is dead, not merely hidden").toBe(401);

  const stillHere = await page.request.get("/api/authoring/session");
  expect(stillHere.status(), "and the device that asked is still signed in").toBe(200);
});

test("ending the device you are holding signs this browser out, instead of leaving a page it cannot use", async ({ page }) => {
  const email = uniqueEmail("own-device");
  await registerThroughForm(page, email);
  const devices = await waitForAccount(page);

  const rows = devices.locator("[data-device]");
  await expect(rows).toHaveCount(1, { timeout: 60_000 });

  // One device, so there is no "end the others" button: a list of one has
  // nothing else to end, and a button that would do nothing is worse than none.
  await expect(page.getByRole("button", { name: "结束其他全部设备" })).toHaveCount(0);

  await page.getByRole("button", { name: "结束这台" }).click();

  // Ending your own device is allowed — it is what 退出登录 does — and the
  // honest answer is the sign-in page: the panel leaves as soon as its next
  // request is refused, rather than showing a row it can no longer act on.
  await page.waitForURL("**/sign-in**", { timeout: 60_000 });
  const session = await page.request.get("/api/authoring/session");
  expect(session.status(), "the session really is over, not just the page").toBe(401);
});
