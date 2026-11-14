import { expect } from "@playwright/test";
import { test } from "./support/csp-fixture.ts";
import { ACTOR_HEADER, conversation, gate, login, register, restorePage, settleUi, unloadBlocked } from "./support/messaging-privacy.ts";

test("concealment cancels an in-flight start without retiring its key or unmounting its failed-history guard", async ({ browser, page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const separate = await browser.newContext({ baseURL: origin });
  const committed = gate(), release = gate(), delivered = gate();
  try {
    const recipient = await register(separate, origin);
    const author = await register(page.context(), origin);
    const requests: { actor: string | undefined; key: string | undefined; body: string | null }[] = [];
    let id = "";
    let reads = 0;
    await page.route(/\/api\/authoring\/inbox(?:\?|$)/, async (route) => {
      const request = route.request();
      if (request.method() === "GET") {
        if (++reads === 2) await route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE" } } });
        else await route.continue();
        return;
      }
      requests.push({ actor: request.headers()[ACTOR_HEADER], key: request.headers()["idempotency-key"], body: request.postData() });
      if (requests.length !== 1) { await route.continue(); return; }
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      id = (await response.json()).data.id as string;
      committed.release();
      await release.promise;
      try { await route.fulfill({ response }); } finally { delivered.release(); }
    });
    await page.goto(`/messages?to=${recipient.id}`);
    await page.getByRole("button", { name: "发起对话", exact: true }).click();
    await committed.promise;
    await expect(page.getByRole("button", { name: "正在发起…", exact: true })).toBeDisabled();
    expect(await page.evaluate(() => {
      window.dispatchEvent(new Event("pagehide"));
      return document.querySelector("#nw-recipient") === null;
    })).toBe(true);
    expect(await unloadBlocked(page)).toBe(true);
    release.release();
    await delivered.promise;
    await settleUi(page);
    expect(new URL(page.url()).pathname).toBe("/messages");
    expect(requests).toHaveLength(1);
    await restorePage(page);
    await expect(page.getByRole("alert")).toContainText("私信没能读取");
    await expect(page.getByLabel("对方的用户 ID")).toHaveCount(0);
    expect(await unloadBlocked(page)).toBe(true);
    await page.locator("a.nw-rail").click();
    const modal = page.getByRole("dialog", { name: "请求尚未确认" });
    await expect(modal).toBeVisible();
    await modal.getByRole("button", { name: "留在此页", exact: true }).click();
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await expect(page.getByLabel("对方的用户 ID")).toHaveValue(recipient.id);
    expect(requests).toHaveLength(1);
    expect(await unloadBlocked(page), "a later successful read is not a create acknowledgment").toBe(true);
    await page.getByRole("button", { name: "发起对话", exact: true }).click();
    await page.waitForURL(`**/messages/${id}`);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual({ actor: author.id, key: expect.any(String), body: JSON.stringify({ participantIds: [recipient.id] }) });
    expect(requests[1]).toEqual(requests[0]);
    expect(await unloadBlocked(page)).toBe(false);
    const inbox = await separate.request.get(`${origin}/api/authoring/inbox`);
    expect((await inbox.json()).data.map((row: { id: string }) => row.id)).toEqual([id]);
  } finally { release.release(); await separate.close(); }
});

test("a concealed uncertain reply keeps the original draft, account and key through member replacement and manual recovery", async ({ browser, page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const separate = await browser.newContext({ baseURL: origin });
  try {
    const recipient = await register(separate, origin);
    const author = await register(page.context(), origin);
    const id = await conversation(page.context(), origin, recipient.id, "Already acknowledged history.");
    const body = "One pending reply across account recovery.";
    const requests: { actor: string | undefined; key: string | undefined; body: string | null }[] = [];
    await page.route(`**/api/authoring/inbox/${id}/messages`, async (route) => {
      if (route.request().method() !== "POST") { await route.continue(); return; }
      const request = route.request();
      requests.push({ actor: request.headers()[ACTOR_HEADER], key: request.headers()["idempotency-key"], body: request.postData() });
      if (requests.length === 1) {
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        await route.abort("failed");
      } else await route.continue();
    });
    await page.goto(`/messages/${id}`);
    await page.getByLabel("写一条消息").fill(body);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("暂时无法确认消息是否发出");
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await login(page.context(), origin, recipient.email);
    await restorePage(page);
    await expect(page.getByRole("alert")).toContainText("账户已变更");
    await expect(page.getByLabel("写一条消息")).toHaveCount(0);
    await expect(page.locator(".nw-msg-body")).toHaveCount(0);
    expect(requests).toHaveLength(1);
    expect(await unloadBlocked(page)).toBe(true);
    await page.getByRole("link", { name: /返回收件箱/ }).click();
    const modal = page.getByRole("dialog", { name: "请求尚未确认" });
    await expect(modal).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(modal).not.toBeVisible();
    await login(page.context(), origin, author.email);
    await page.getByRole("button", { name: "重新确认账户", exact: true }).click();
    await expect(page.getByLabel("写一条消息")).toHaveValue(body);
    await expect(page.locator(".nw-msg-mine .nw-msg-body").getByText(body, { exact: true })).toHaveCount(1);
    expect(requests, "a fresh read must not replay or acknowledge the pending reply").toHaveLength(1);
    expect(await unloadBlocked(page)).toBe(true);
    await page.getByLabel("写一条消息").fill("This is a different intent, not a retry.");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("恢复原文");
    expect(requests).toHaveLength(1);
    await page.getByRole("button", { name: "恢复原文", exact: true }).click();
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByLabel("写一条消息")).toHaveValue("");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual({ actor: author.id, key: expect.any(String), body: JSON.stringify({ body }) });
    expect(requests[1]).toEqual(requests[0]);
    expect(await unloadBlocked(page)).toBe(false);
    await expect(page.locator(".nw-msg-body").getByText(body, { exact: true })).toHaveCount(1);
    const stored = await separate.request.get(`${origin}/api/authoring/inbox/${id}/messages`);
    expect((await stored.json()).data.map((message: { senderId: string; body: string }) => ({ senderId: message.senderId, body: message.body }))).toEqual([
      { senderId: author.id, body: "Already acknowledged history." }, { senderId: author.id, body },
    ]);
  } finally { await separate.close(); }
});

test("restoration never automatically replays an unconfirmed bodyless mark-all action", async ({ browser, page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const separate = await browser.newContext({ baseURL: origin });
  try {
    await register(separate, origin);
    const author = await register(page.context(), origin);
    const id = await conversation(separate, origin, author.id, "Unread until an explicit mark-all.");
    const requests: { actor: string | undefined; key: string | undefined; body: string | null }[] = [];
    await page.route(`**/api/authoring/inbox/${id}/read`, async (route) => {
      const request = route.request();
      expect(request.method()).toBe("PUT");
      requests.push({ actor: request.headers()[ACTOR_HEADER], key: request.headers()["idempotency-key"], body: request.postData() });
      if (requests.length === 1) {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        await route.abort("failed");
      } else await route.continue();
    });
    await page.goto(`/messages/${id}`);
    await expect(page.locator(".nw-msg-body")).toHaveText("Unread until an explicit mark-all.");
    await page.getByRole("button", { name: "将全部标为已读", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("暂时无法确认");
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await restorePage(page);
    await expect(page.getByRole("button", { name: "将全部标为已读", exact: true })).toBeEnabled();
    expect(requests).toHaveLength(1);
    await expect(page.locator(".nw-mark-read-status")).not.toContainText("已向服务器标记");
    await page.getByRole("button", { name: "将全部标为已读", exact: true }).click();
    await expect(page.locator(".nw-mark-read-status")).toContainText("已向服务器标记");
    expect(requests).toEqual([
      { actor: author.id, key: undefined, body: null }, { actor: author.id, key: undefined, body: null },
    ]);
    const unread = await page.context().request.get(`${origin}/api/authoring/inbox`);
    const row = (await unread.json()).data.find((entry: { id: string }) => entry.id === id);
    expect(row.unreadCount).toBe(0);
  } finally { await separate.close(); }
});
