import { expect } from "@playwright/test";
import { test } from "./support/csp-fixture.ts";
import { ACTOR_HEADER, conversation, gate, login, register, restorePage, settleUi } from "./support/messaging-privacy.ts";

for (const screen of ["inbox", "thread"] as const) {
  test(`${screen}: focus after a real account replacement removes the original account's history`, async ({ browser, page, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    const separate = await browser.newContext({ baseURL: origin });
    try {
      const recipient = await register(separate, origin);
      const replacement = await register(separate, origin);
      const author = await register(page.context(), origin);
      const body = `Private ${screen} history for the original account.`;
      const id = await conversation(page.context(), origin, recipient.id, body);
      let writes = 0;
      page.on("request", (request) => {
        if (request.method() !== "GET" && request.url().includes("/api/authoring/inbox")) writes++;
      });
      await page.goto(screen === "inbox" ? "/messages" : `/messages/${id}`);
      const content = screen === "inbox" ? page.locator(".nw-thread-preview") : page.locator(".nw-msg-body");
      const draft = page.getByLabel(screen === "inbox" ? "对方的用户 ID" : "写一条消息");
      const original = screen === "inbox" ? recipient.id : "An unsent private draft.";
      await expect(content).toContainText(body);
      await draft.fill(original);
      await login(page.context(), origin, replacement.email);
      const fresh = await page.context().request.get(`${origin}/api/authoring/inbox`);
      expect(fresh.status()).toBe(200);
      expect((await fresh.json()).data).toEqual([]);
      const denied = await page.context().request.get(`${origin}/api/authoring/inbox/${id}/messages`);
      expect(denied.status()).toBe(403);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(content.filter({ hasText: body })).toHaveCount(0);
      await expect(page.getByRole("alert")).toContainText("账户已变更");
      await expect(page.getByRole("button", { name: screen === "inbox" ? "发起对话" : "发送", exact: true })).toHaveCount(0);
      await expect(draft).toHaveCount(0);
      const signIn = page.getByRole("alert").getByRole("link", { name: "登录" });
      await expect(signIn).toHaveAttribute("target", "_blank");
      await expect(signIn).toHaveAttribute("rel", "noopener noreferrer");
      await page.getByRole("button", { name: "重新确认账户", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText("账户已变更");
      await expect(content).toHaveCount(0);
      await login(page.context(), origin, author.email);
      await page.getByRole("button", { name: "重新确认账户", exact: true }).click();
      await expect(content).toContainText(body);
      await expect(draft).toHaveValue(original);
      expect(writes, "account verification restores display, not a send or mark-all").toBe(0);
    } finally { await separate.close(); }
  });

  test(`${screen}: a real logout on restoration is signed-out, never a successful empty history`, async ({ browser, page, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    const separate = await browser.newContext({ baseURL: origin });
    try {
      const recipient = await register(separate, origin);
      const author = await register(page.context(), origin);
      const body = "History from before another tab logged out.";
      const id = await conversation(page.context(), origin, recipient.id, body);
      await page.goto(screen === "inbox" ? "/messages" : `/messages/${id}`);
      const content = screen === "inbox" ? page.locator(".nw-thread-preview") : page.locator(".nw-msg-body");
      await expect(content).toContainText(body);
      const logout = await page.context().request.post(`${origin}/api/auth/logout`, { headers: { origin } });
      expect(logout.status()).toBe(200);
      const session = await page.context().request.get(`${origin}/api/authoring/session`);
      expect(session.status()).toBe(401);
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await expect(page.getByRole("alert")).toContainText("登录后可以看到你的私信");
      await expect(content).toHaveCount(0);
      await expect(page.getByText("还没有任何对话。", { exact: true })).toHaveCount(0);
      await expect(page.getByText("这段对话还没有消息。", { exact: true })).toHaveCount(0);
      await expect(page.locator(".nw-compose")).toHaveCount(0);
      await login(page.context(), origin, author.email);
      await page.getByRole("button", { name: "重新确认账户", exact: true }).click();
      await expect(content).toContainText(body);
    } finally { await separate.close(); }
  });

  test(`${screen}: a failed recovery identity check cannot reuse the first-load read-only fallback`, async ({ browser, page, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    const separate = await browser.newContext({ baseURL: origin });
    try {
      const recipient = await register(separate, origin);
      const author = await register(page.context(), origin);
      const body = "History concealed until the original identity is verified again.";
      const id = await conversation(page.context(), origin, recipient.id, body);
      const english = screen === "thread";
      await page.goto(english ? `/en/messages/${id}` : "/messages");
      const content = english ? page.locator(".nw-msg-body") : page.locator(".nw-thread-preview");
      const input = page.getByLabel(english ? "Write a message" : "对方的用户 ID");
      const original = english ? "Keep this draft in memory, not in another account's UI." : recipient.id;
      await expect(content).toContainText(body);
      await input.fill(original);
      let identityReads = 0, historyReads = 0, writes = 0;
      let identityUnavailable = true;
      await page.route("**/api/authoring/session", async (route) => {
        identityReads++;
        // The bell verifies independently too: an outage cannot be consumed by
        // whichever private surface wins the first-request race.
        if (identityUnavailable) await route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE" } } });
        else await route.continue();
      });
      page.on("request", (request) => {
        if (!request.url().includes("/api/authoring/inbox")) return;
        if (request.method() === "GET") historyReads++;
        else writes++;
      });
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await expect(page.getByRole("alert")).toContainText(english ? "current account could not be confirmed" : "暂时无法确认当前账户");
      await expect(content).toHaveCount(0);
      await expect(input).toHaveCount(0);
      await expect(page.locator(".nw-mark-read")).toHaveCount(0);
      await settleUi(page);
      expect(identityReads, "one verification per independent messaging and notification owner").toBe(2);
      expect(historyReads, "a post-boundary failure must not start unbound private reads").toBe(0);
      expect(writes).toBe(0);
      identityUnavailable = false;
      const nextRead = page.waitForRequest((request) => request.url().includes("/api/authoring/inbox") && request.method() === "GET");
      await page.getByRole("button", { name: english ? "Confirm account again" : "重新确认账户", exact: true }).click();
      expect((await nextRead).headers()[ACTOR_HEADER]).toBe(author.id);
      await expect(content).toContainText(body);
      await expect(input).toHaveValue(original);
      expect(identityReads, "only the explicit messaging retry rechecks identity").toBe(3);
      expect(historyReads).toBe(1);
      expect(writes).toBe(0);
    } finally { await separate.close(); }
  });
}

test("pagehide clears the English thread DOM synchronously and no background event revives it before verification", async ({ browser, page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const separate = await browser.newContext({ baseURL: origin });
  const identityEntered = gate(), release = gate();
  try {
    const recipient = await register(separate, origin);
    await register(page.context(), origin);
    const body = "English private history before a persisted-pageshow event.";
    const id = await conversation(page.context(), origin, recipient.id, body);
    await page.goto(`/en/messages/${id}`);
    await expect(page.locator(".nw-msg-body")).toHaveText(body);
    await page.getByLabel("Write a message").fill("This private draft is not part of a browser snapshot.");
    let checks = 0;
    await page.route("**/api/authoring/session", async (route) => {
      checks++;
      identityEntered.release();
      await release.promise;
      await route.continue();
    });
    const concealed = await page.evaluate(() => {
      window.dispatchEvent(new Event("pagehide"));
      return { messages: document.querySelectorAll(".nw-msg-body").length, drafts: document.querySelectorAll("#nw-compose-body").length };
    });
    expect(concealed).toEqual({ messages: 0, drafts: 0 });
    await expect(page.getByRole("status")).toContainText("Private messages are hidden");
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await settleUi(page);
    expect(checks, "pagehide wins even if visibilityState has not caught up").toBe(0);
    await restorePage(page);
    await identityEntered.promise;
    await expect(page.locator(".nw-msg-body")).toHaveCount(0);
    await expect(page.getByLabel("Write a message")).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText("Confirming the current account");
    release.release();
    await expect(page.locator(".nw-msg-body")).toHaveText(body);
    await expect(page.getByLabel("Write a message")).toHaveValue("This private draft is not part of a browser snapshot.");
    expect(checks, "messaging and notifications both verify after pageshow").toBe(2);
    const storage = await page.evaluate(() => JSON.stringify({ local: Object.entries(localStorage), session: Object.entries(sessionStorage) }));
    expect(storage).not.toContain(body);
    expect(storage).not.toContain("This private draft is not part of a browser snapshot.");
  } finally { release.release(); await separate.close(); }
});
