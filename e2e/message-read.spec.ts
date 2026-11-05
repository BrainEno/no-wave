import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test, type BrowserContext } from "@playwright/test";
import { uniqueEmail } from "./support/accounts.ts";

async function register(context: BrowserContext, origin: string): Promise<string> {
  const response = await context.request.post(`${origin}/api/auth/register`, {
    headers: { origin },
    data: { email: uniqueEmail("message-read"), password: "browser-messages-password" },
  });
  expect(response.status()).toBe(201);
  const session = await context.request.get(`${origin}/api/authoring/session`);
  expect(session.status()).toBe(200);
  return (await session.json()).data.id as string;
}

async function start(context: BrowserContext, origin: string, other: string): Promise<string> {
  const response = await context.request.post(`${origin}/api/authoring/inbox`, {
    headers: { origin, "idempotency-key": randomUUID() },
    data: { participantIds: [other] },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).data.id as string;
}

async function send(context: BrowserContext, origin: string, conversationId: string, body: string): Promise<void> {
  const response = await context.request.post(`${origin}/api/authoring/inbox/${conversationId}/messages`, {
    headers: { origin, "idempotency-key": randomUUID() },
    data: { body },
  });
  expect(response.status()).toBe(201);
}

async function unread(context: BrowserContext, origin: string, conversationId: string): Promise<number> {
  const response = await context.request.get(`${origin}/api/authoring/inbox`);
  expect(response.status()).toBe(200);
  const rows = (await response.json()).data as { id: string; unreadCount: number }[];
  const row = rows.find((entry) => entry.id === conversationId);
  expect(row).toBeTruthy();
  return row!.unreadCount;
}

test("explicitly mark one conversation read, including messages that arrive before the write is processed", async ({ browser, page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const writer = await browser.newContext({ baseURL: origin });
  const stranger = await browser.newContext({ baseURL: origin });
  const anonymous = await browser.newContext({ baseURL: origin });
  let release: () => void = () => {};
  try {
    const recipientId = await register(page.context(), origin);
    const initialRefresh = (await page.context().cookies()).find((cookie) => cookie.name === "nw_refresh")?.value;
    expect(initialRefresh).toBeTruthy();
    await register(writer, origin);
    await register(stranger, origin);
    const first = await start(writer, origin, recipientId);
    const other = await start(writer, origin, recipientId);
    const empty = await start(writer, origin, recipientId);
    // The store has millisecond read markers. Give the initial membership
    // marker a distinct timestamp from the messages being sent.
    await delay(10);
    await send(page.context(), origin, first, "recipient to writer");
    await send(writer, origin, first, "visible in the thread");
    await send(writer, origin, other, "another conversation");
    expect(await unread(page.context(), origin, first)).toBe(1);
    expect(await unread(page.context(), origin, other)).toBe(1);
    expect(await unread(writer, origin, first)).toBe(1);

    // Membership is checked by the real API, even with a well-formed id.
    const denied = await stranger.request.put(`${origin}/api/authoring/inbox/${first}/read`, { headers: { origin } });
    expect(denied.status()).toBe(403);
    const signedOut = await anonymous.request.put(`${origin}/api/authoring/inbox/${first}/read`, { headers: { origin } });
    expect(signedOut.status()).toBe(401);
    const crossOrigin = await page.context().request.put(`${origin}/api/authoring/inbox/${first}/read`, { headers: { origin: "https://attacker.example" } });
    expect(crossOrigin.status()).toBe(403);
    expect(await unread(page.context(), origin, first)).toBe(1);

    let writes = 0;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/authoring/inbox/*/read", async (route) => {
      writes += 1;
      await gate;
      await route.continue();
    });
    await page.goto(`/messages/${first}`);
    await expect(page.getByText("visible in the thread", { exact: true })).toBeVisible();
    await expect(page.getByText("会将整段对话标为已读，包括尚未加载或请求期间到达的消息。", { exact: true })).toBeVisible();
    const mark = page.getByRole("button", { name: /将全部标为已读|正在标记/ });
    await expect(mark).toBeVisible({ timeout: 3_000 });
    await expect(mark).toHaveAttribute("aria-describedby", `nw-mark-read-hint-${first}`);
    expect(writes).toBe(0); // Opening and reading a page is never a silent PUT.
    expect(await unread(page.context(), origin, first)).toBe(1);

    await mark.click();
    await expect(mark).toBeDisabled();
    await expect.poll(() => writes).toBe(1);
    await send(writer, origin, first, "arrived while the write waited");
    expect(await unread(page.context(), origin, first)).toBe(2);
    await expect(page.getByText("arrived while the write waited", { exact: true })).toHaveCount(0);
    release();
    await expect(page.getByRole("status").filter({ hasText: "已向服务器标记" })).toBeVisible();
    expect(writes).toBe(1);
    expect(await unread(page.context(), origin, first)).toBe(0);
    expect(await unread(page.context(), origin, other)).toBe(1);
    expect(await unread(writer, origin, first)).toBe(1);

    // A message sent after acknowledgement is unread again and the inbox shows
    // the server's answer, not a local optimistic guess.
    await delay(10);
    await send(writer, origin, first, "arrived afterwards");
    expect(await unread(page.context(), origin, first)).toBe(1);
    await page.getByRole("link", { name: /返回收件箱/ }).click();
    await expect(page.locator(`a[href="/messages/${first}"]`)).toContainText("1 条未读");
    await expect(page.locator(`a[href="/messages/${other}"]`)).toContainText("1 条未读");
    await page.goto(`/en/messages/${first}`);
    await expect(page.getByRole("button", { name: "Mark all as read" })).toBeVisible();
    await expect(page.getByText(/including messages that are not loaded/)).toBeVisible();
    expect(writes).toBe(1);
    expect(await unread(page.context(), origin, first)).toBe(1);
    await page.goto(`/messages/${empty}`);
    await expect(page.getByText("这段对话还没有消息。", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "将全部标为已读" })).toHaveCount(0);
    expect(writes).toBe(1);
    expect((await page.context().cookies()).find((cookie) => cookie.name === "nw_refresh")?.value).toBe(initialRefresh);
  } finally {
    release();
    await writer.close();
    await stranger.close();
    await anonymous.close();
  }
});

test("unconfirmed, signed-out and denied marks never pretend success or discard a draft", async ({ browser, page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const writer = await browser.newContext({ baseURL: origin });
  try {
    const recipientId = await register(page.context(), origin);
    await register(writer, origin);
    const conversation = await start(writer, origin, recipientId);
    await delay(10);
    await send(writer, origin, conversation, "hello reader");
    expect(await unread(page.context(), origin, conversation)).toBe(1);
    let attempts = 0;
    await page.route("**/api/authoring/inbox/*/read", async (route) => {
      attempts += 1;
      if (attempts === 1) {
        // The API committed the mark, but its response never reaches the UI.
        const stored = await route.fetch();
        expect(stored.status()).toBe(200);
        await route.abort("failed");
      } else if (attempts === 2) await route.fulfill({ status: 200, contentType: "application/json", body: '{"data":false}' });
      else if (attempts === 3) await route.fulfill({ status: 200, contentType: "application/json", body: "not JSON" });
      else if (attempts === 4) await route.fulfill({ status: 401, contentType: "application/json", body: '{"error":{"code":"UNAUTHENTICATED"}}' });
      else if (attempts === 5) await route.fulfill({ status: 403, contentType: "application/json", body: '{"error":{"code":"FORBIDDEN"}}' });
      else if (attempts === 6) await route.fulfill({ status: 404, contentType: "application/json", body: '{"error":{"code":"NOT_FOUND"}}' });
      else await route.continue();
    });
    await page.goto(`/messages/${conversation}`);
    await expect(page.getByText("hello reader", { exact: true })).toBeVisible();
    const draft = page.getByLabel("写一条消息");
    await draft.fill("keep this draft");
    const mark = page.getByRole("button", { name: /将全部标为已读|正在标记/ });
    await expect(mark).toBeVisible({ timeout: 3_000 });

    await mark.click();
    await expect(page.getByRole("alert")).toContainText("暂时无法确认是否标为已读");
    await expect(draft).toHaveValue("keep this draft");
    expect(await unread(page.context(), origin, conversation)).toBe(0);
    await delay(10);
    await send(writer, origin, conversation, "new after the lost response");
    expect(await unread(page.context(), origin, conversation)).toBe(1);
    expect(attempts).toBe(1); // An ambiguous result must never trigger a silent retry.
    await mark.click();
    await expect(page.getByRole("alert")).toContainText("暂时无法确认是否标为已读");
    expect(await unread(page.context(), origin, conversation)).toBe(1);
    await mark.click();
    await expect(page.getByRole("alert")).toContainText("暂时无法确认是否标为已读");
    expect(await unread(page.context(), origin, conversation)).toBe(1);
    await mark.click();
    await expect(page.getByRole("alert")).toContainText("请在新标签页登录原账户");
    await expect(page.getByRole("alert").getByRole("link")).toHaveAttribute("target", "_blank");
    await mark.click();
    await expect(page.getByRole("alert")).toContainText("找不到这段对话，或者你不在其中");
    expect(await unread(page.context(), origin, conversation)).toBe(1);
    await expect(draft).toHaveValue("keep this draft");
    await mark.click();
    await expect(page.getByRole("alert")).toContainText("找不到这段对话，或者你不在其中");
    expect(await unread(page.context(), origin, conversation)).toBe(1);
    await mark.click();
    await expect(page.getByRole("status").filter({ hasText: "已向服务器标记" })).toBeVisible();
    expect(await unread(page.context(), origin, conversation)).toBe(0);
    await expect(draft).toHaveValue("keep this draft");
    expect(attempts).toBe(7);

    // Simulate a full first page plus an older page. The unread mutation must not
    // run automatically on either loading or paging, even when there are more
    // messages than the newest page can show.
    const messagePage = Array.from({ length: 100 }, (_, index) => ({
      id: `page-${index}`, senderId: "writer", body: `page message ${index}`,
      createdAt: "2026-01-01T00:00:00.000Z",
    }));
    await page.route(/\/api\/authoring\/inbox\/[^/]+\/messages\?/, async (route) => {
      const older = new URL(route.request().url()).searchParams.has("before");
      await route.fulfill({ json: { data: older ? [{ ...messagePage[0], id: "older", body: "older page" }] : messagePage } });
    });
    await page.reload();
    await expect(page.locator(".nw-msg")).toHaveCount(100);
    await page.getByRole("button", { name: "看更早的消息" }).click();
    await expect(page.locator(".nw-msg")).toHaveCount(101);
    await expect(page.getByText("older page", { exact: true })).toBeVisible();
    expect(attempts).toBe(7);
  } finally {
    await writer.close();
  }
});
