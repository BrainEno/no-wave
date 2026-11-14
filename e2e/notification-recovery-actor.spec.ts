import { expect } from "@playwright/test";
import { test } from "./support/csp-fixture.ts";
import { gate, restorePage, settleUi } from "./support/messaging-privacy.ts";
import { NOTIFICATION_ACTOR_HEADER, loginNotificationAccount, notificationAccounts, openNotificationSurfaces, unreadNotifications } from "./support/notification-privacy.ts";

const privateDom = ".nw-authoring-inbox-row, .nw-np-row, .nw-bdg";

test("restoration verifies a real replacement recipient even when its readable session hint is unchanged", async ({ browser, page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const accounts = await notificationAccounts(browser, page, origin);
  const entered = gate(), release = gate();
  try {
    const { inbox, bell } = await openNotificationSurfaces(page);
    const marker = (await page.context().cookies(origin)).find((cookie) => cookie.name === "nw_session")!;
    expect(marker).toBeTruthy();
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await loginNotificationAccount(page.context(), origin, accounts.replacement.email);
    await page.context().addCookies([{ ...marker, value: marker.value }]);
    const reads: string[] = [];
    let checks = 0, writes = 0;
    page.on("request", (request) => {
      if (!request.url().includes("/api/authoring/notifications")) return;
      if (request.method() === "GET") reads.push(request.headers()[NOTIFICATION_ACTOR_HEADER]!);
      else writes++;
    });
    await page.route("**/api/authoring/session", async (route) => {
      checks++;
      entered.release();
      await release.promise;
      await route.continue();
    });
    await restorePage(page);
    await entered.promise;
    await expect(page.locator(privateDom)).toHaveCount(0);
    expect(reads).toHaveLength(0);
    release.release();
    for (const surface of [inbox, bell]) {
      await expect(surface.locator(`a[href="/authors/${accounts.original.id}"]`)).toBeVisible();
      await expect(surface.locator(`a[href="/authors/${accounts.replacement.id}"]`)).toHaveCount(0);
    }
    await expect(page.locator(".nw-bdg")).toHaveText("1");
    expect(checks).toBe(1);
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(reads.every((actor) => actor === accounts.replacement.id)).toBe(true);
    expect(writes).toBe(0);
    expect(await unreadNotifications(accounts.other, origin)).toBe(1);
  } finally { release.release(); await accounts.other.close(); }
});

test("a recovery identity outage hides both surfaces until an explicit read verifies the account", async ({ browser, page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const accounts = await notificationAccounts(browser, page, origin);
  try {
    const { inbox, bell } = await openNotificationSurfaces(page);
    let checks = 0, reads = 0, writes = 0;
    await page.route("**/api/authoring/session", async (route) => {
      if (++checks === 1) await route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "synthetic-private-identity-detail" } } });
      else await route.continue();
    });
    page.on("request", (request) => {
      if (!request.url().includes("/api/authoring/notifications")) return;
      if (request.method() === "GET") reads++;
      else writes++;
    });
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    for (const surface of [inbox, bell]) {
      await expect(surface.getByRole("alert")).toContainText("暂时无法载入");
      await expect(surface).not.toContainText("synthetic-private-identity-detail");
    }
    await expect(page.locator(privateDom)).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
    await settleUi(page);
    expect(checks).toBe(1);
    expect(reads, "a failed identity cannot reuse an unbound private-read fallback").toBe(0);
    expect(writes).toBe(0);
    const verifiedRead = page.waitForRequest((request) => request.url().includes("/api/authoring/notifications") && request.method() === "GET");
    await bell.getByRole("button", { name: "刷新通知", exact: true }).click();
    expect((await verifiedRead).headers()[NOTIFICATION_ACTOR_HEADER]).toBe(accounts.original.id);
    await expect(inbox.locator(".nw-authoring-inbox-row")).toHaveCount(1);
    await expect(bell.locator(".nw-np-row")).toHaveCount(1);
    expect(checks).toBe(2);
    expect(writes).toBe(0);
    expect(await unreadNotifications(page.context(), origin)).toBe(1);
  } finally { await accounts.other.close(); }
});

test("a delayed verified identity from an old cookie cannot overwrite a newer restoration", async ({ browser, page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const accounts = await notificationAccounts(browser, page, origin);
  const entered = gate(), release = gate(), finished = gate();
  try {
    const { inbox, bell } = await openNotificationSurfaces(page);
    let checks = 0, writes = 0;
    const actors: string[] = [];
    await page.route("**/api/authoring/session", async (route) => {
      if (++checks !== 1) { await route.continue(); return; }
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      expect((await response.json()).data.id).toBe(accounts.original.id);
      entered.release();
      await release.promise;
      try { await route.fulfill({ response }); } finally { finished.release(); }
    });
    page.on("request", (request) => {
      if (!request.url().includes("/api/authoring/notifications")) return;
      if (request.method() === "GET") actors.push(request.headers()[NOTIFICATION_ACTOR_HEADER]!);
      else writes++;
    });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await entered.promise;
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await loginNotificationAccount(page.context(), origin, accounts.replacement.email);
    await restorePage(page);
    for (const surface of [inbox, bell]) await expect(surface.locator(`a[href="/authors/${accounts.original.id}"]`)).toBeVisible();
    release.release();
    await finished.promise;
    await settleUi(page);
    for (const surface of [inbox, bell]) {
      await expect(surface.locator(`a[href="/authors/${accounts.original.id}"]`)).toBeVisible();
      await expect(surface.locator(`a[href="/authors/${accounts.replacement.id}"]`)).toHaveCount(0);
    }
    expect(checks).toBe(2);
    expect(actors.length).toBeGreaterThanOrEqual(2);
    expect(actors.every((actor) => actor === accounts.replacement.id)).toBe(true);
    expect(writes).toBe(0);
    expect(await unreadNotifications(accounts.other, origin)).toBe(1);
  } finally { release.release(); await accounts.other.close(); }
});

test("a committed original read with a delayed acknowledgement cannot mark a replacement recipient read", async ({ browser, page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const accounts = await notificationAccounts(browser, page, origin);
  const entered = gate(), release = gate(), finished = gate();
  try {
    const { inbox, bell } = await openNotificationSurfaces(page);
    const submitted: string[] = [];
    await page.route("**/api/authoring/notifications/read-all", async (route) => {
      submitted.push(route.request().headers()[NOTIFICATION_ACTOR_HEADER]!);
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      expect((await response.json()).data).toBe(1);
      entered.release();
      await release.promise;
      try { await route.fulfill({ response }); } finally { finished.release(); }
    });
    await bell.getByRole("button", { name: "全部标为已读", exact: true }).click();
    await entered.promise;
    expect(await unreadNotifications(page.context(), origin), "the original server-side mutation really committed").toBe(0);
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await expect(page.locator(privateDom)).toHaveCount(0);
    await loginNotificationAccount(page.context(), origin, accounts.replacement.email);
    await restorePage(page);
    for (const surface of [inbox, bell]) await expect(surface.locator(`a[href="/authors/${accounts.original.id}"]`)).toBeVisible();
    release.release();
    await finished.promise;
    await settleUi(page);
    for (const surface of [inbox, bell]) {
      await expect(surface.getByRole("button", { name: "标记已读", exact: true })).toHaveCount(1);
      await expect(surface.locator(`a[href="/authors/${accounts.replacement.id}"]`)).toHaveCount(0);
    }
    await expect(page.locator(".nw-bdg")).toHaveText("1");
    expect(submitted).toEqual([accounts.original.id]);
    expect(await unreadNotifications(accounts.other, origin)).toBe(1);
  } finally { release.release(); await accounts.other.close(); }
});

test("a stale explicit refresh clears on conflict before a second deliberate read accepts the new account", async ({ browser, page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const accounts = await notificationAccounts(browser, page, origin);
  try {
    const { inbox, bell } = await openNotificationSurfaces(page);
    await loginNotificationAccount(page.context(), origin, accounts.replacement.email);
    let checks = 0, writes = 0;
    const actors: string[] = [];
    await page.route("**/api/authoring/session", async (route) => { checks++; await route.continue(); });
    page.on("request", (request) => {
      if (!request.url().includes("/api/authoring/notifications")) return;
      if (request.method() === "GET") actors.push(request.headers()[NOTIFICATION_ACTOR_HEADER]!);
      else writes++;
    });
    const conflict = page.waitForResponse((response) => response.url().includes("/api/authoring/notifications") && response.status() === 409);
    await inbox.getByRole("button", { name: "刷新通知", exact: true }).click();
    await conflict;
    await expect(page.locator(privateDom)).toHaveCount(0);
    for (const surface of [inbox, bell]) await expect(surface.getByRole("alert")).toContainText("账户已变更");
    await settleUi(page);
    expect(checks, "a failed read cannot silently retry against a different recipient").toBe(0);
    expect(actors.length).toBeGreaterThan(0);
    expect(actors.every((actor) => actor === accounts.original.id)).toBe(true);
    actors.length = 0;
    await bell.getByRole("button", { name: "刷新通知", exact: true }).click();
    for (const surface of [inbox, bell]) {
      await expect(surface.locator(`a[href="/authors/${accounts.original.id}"]`)).toBeVisible();
      await expect(surface.getByRole("alert")).toHaveCount(0);
    }
    expect(checks).toBe(1);
    expect(actors.length).toBeGreaterThanOrEqual(2);
    expect(actors.every((actor) => actor === accounts.replacement.id)).toBe(true);
    expect(writes).toBe(0);
    expect(await unreadNotifications(accounts.other, origin)).toBe(1);
  } finally { await accounts.other.close(); }
});

test("real logout and sign-in restoration remove and then reread private notifications without marking them", async ({ browser, page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const accounts = await notificationAccounts(browser, page, origin);
  try {
    const { inbox, bell } = await openNotificationSurfaces(page);
    let writes = 0;
    page.on("request", (request) => {
      if (request.url().includes("/api/authoring/notifications") && request.method() !== "GET") writes++;
    });
    const logout = await page.context().request.post(`${origin}/api/auth/logout`, { headers: { origin } });
    expect(logout.status()).toBe(200);
    expect((await page.context().request.get(`${origin}/api/authoring/session`)).status()).toBe(401);
    await restorePage(page);
    await expect(page.locator(privateDom)).toHaveCount(0);
    await expect(bell.getByRole("link", { name: /登录/ })).toBeVisible();
    await expect(bell.getByRole("button", { name: "全部标为已读", exact: true })).toHaveCount(0);
    await loginNotificationAccount(page.context(), origin, accounts.original.email);
    const read = page.waitForRequest((request) => request.url().includes("/api/authoring/notifications") && request.method() === "GET");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    expect((await read).headers()[NOTIFICATION_ACTOR_HEADER]).toBe(accounts.original.id);
    await expect(inbox.locator(".nw-authoring-inbox-row")).toHaveCount(1);
    await expect(bell.locator(".nw-np-row")).toHaveCount(1);
    await expect(page.locator(".nw-bdg")).toHaveText("1");
    expect(writes).toBe(0);
    expect(await unreadNotifications(page.context(), origin)).toBe(1);
  } finally { await accounts.other.close(); }
});
