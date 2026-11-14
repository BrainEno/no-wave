import { expect, type BrowserContext } from "@playwright/test";
import { test } from "./support/csp-fixture.ts";
import { uniqueEmail } from "./support/accounts.ts";

/** Exercise real API writes while dropping responses after the server commits. */
async function register(context: BrowserContext, origin: string): Promise<string> {
  const response = await context.request.post(`${origin}/api/auth/register`, {
    headers: { origin },
    data: { email: uniqueEmail("messages"), password: "browser-messages-password" },
  });
  expect(response.status()).toBe(201);
  const session = await context.request.get(`${origin}/api/authoring/session`);
  expect(session.status()).toBe(200);
  return (await session.json()).data.id as string;
}

test("start and reply safely after lost responses, including edits and sign-in", async ({ browser, page, baseURL }) => {
  test.setTimeout(120_000);
  const origin = new URL(baseURL!).origin;
  const recipientContext = await browser.newContext({ baseURL: origin });
  try {
    const recipientId = await register(recipientContext, origin);
    const anonymous = await browser.newContext({ baseURL: origin });
    try {
      const visitor = await anonymous.newPage();
      await visitor.goto(`/authors/${recipientId}`);
      await visitor.getByRole("link", { name: "给这位作者发私信" }).click();
      await visitor.waitForURL("**/sign-in?next=*");
      expect(new URL(visitor.url()).searchParams.get("next")).toBe(`/messages?to=${recipientId}`);
    } finally {
      await anonymous.close();
    }
    await register(page.context(), origin);
    const initialRefresh = (await page.context().cookies()).find((cookie) => cookie.name === "nw_refresh")?.value;
    expect(initialRefresh).toBeTruthy();

    const starts: { key: string | undefined; body: string | null }[] = [];
    let createdId = "";
    await page.route("**/api/authoring/inbox", async (route) => {
      if (route.request().method() !== "POST") { await route.continue(); return; }
      starts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
      if (starts.length === 1) {
        const stored = await route.fetch();
        expect(stored.status()).toBe(201);
        createdId = (await stored.json()).data.id as string;
        // The server committed, but the browser never got the response.
        await route.abort("failed");
      } else {
        await route.continue();
      }
    });
    await page.goto(`/authors/${recipientId}`);
    await page.getByRole("link", { name: "给这位作者发私信" }).click();
    const recipient = page.getByLabel("对方的用户 ID");
    await expect(recipient).toHaveValue(recipientId);
    await page.getByRole("button", { name: "发起对话" }).click();
    await expect(page.getByRole("alert")).toContainText("暂时无法确认对话是否创建");
    await recipient.fill("different-recipient");
    await page.getByRole("button", { name: "发起对话" }).click();
    await expect(page.getByRole("alert")).toContainText("上次发起的对话可能已经创建");
    expect(starts).toHaveLength(1);
    await page.getByRole("button", { name: "恢复原收件人" }).click();
    await page.getByRole("button", { name: "发起对话" }).click();
    await page.waitForURL(`**/messages/${createdId}`);
    expect(starts).toHaveLength(2);
    expect(starts[0].key).toBeTruthy();
    expect(starts[1]).toEqual(starts[0]);

    const sends: { key: string | undefined; body: string | null }[] = [];
    await page.route("**/api/authoring/inbox/*/messages", async (route) => {
      if (route.request().method() !== "POST") { await route.continue(); return; }
      sends.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
      if (sends.length === 1) {
        const stored = await route.fetch();
        expect(stored.status()).toBe(201);
        await route.abort("failed");
      } else if (sends.length === 3) {
        // A 401 must not retire the pending key.
        await route.fulfill({ status: 401, contentType: "application/json", body: '{"error":{"code":"UNAUTHENTICATED"}}' });
      } else if (sends.length === 5) {
        // A successful but malformed response is also ambiguous.
        const stored = await route.fetch();
        expect(stored.status()).toBe(201);
        await route.fulfill({ status: 201, contentType: "application/json", body: '{"data":{}}' });
      } else {
        await route.continue();
      }
    });
    const box = page.getByLabel("写一条消息");
    await expect(box).toBeVisible();
    await box.fill("  hello once  ");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("暂时无法确认消息是否发出");
    await box.fill("different text");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("上一条消息可能已经发出");
    expect(sends).toHaveLength(1);
    await page.getByRole("button", { name: "恢复原文" }).click();
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator(".nw-msg-body").getByText("hello once", { exact: true })).toHaveCount(1);
    expect(sends[1]).toEqual(sends[0]);
    expect(JSON.parse(sends[0].body!).body).toBe("hello once");

    await box.fill("second message");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("请在新标签页登录");
    await expect(page.getByRole("alert").getByRole("link")).toHaveAttribute("target", "_blank");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator(".nw-msg-body").getByText("second message", { exact: true })).toHaveCount(1);
    expect(sends[3]).toEqual(sends[2]);
    expect(sends[2].key).not.toBe(sends[1].key);

    await box.fill("x".repeat(20_001));
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("消息不能超过 20000 字符");
    expect(sends).toHaveLength(4);
    await box.fill("third message");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("暂时无法确认消息是否发出");
    await page.getByRole("button", { name: "再试一次" }).click();
    await expect(page.locator(".nw-msg-body").getByText("third message", { exact: true })).toHaveCount(1);
    expect(sends[5]).toEqual(sends[4]);
    expect(sends[4].key).not.toBe(sends[3].key);

    const list = await recipientContext.request.get(`${origin}/api/authoring/inbox/${createdId}/messages`);
    expect(list.status()).toBe(200);
    const messages = (await list.json()).data as { body: string }[];
    expect(messages.map((message) => message.body).sort()).toEqual(["hello once", "second message", "third message"].sort());
    const inbox = await page.context().request.get(`${origin}/api/authoring/inbox`);
    const conversations = (await inbox.json()).data as { id: string }[];
    expect(conversations.filter((conversation) => conversation.id === createdId)).toHaveLength(1);
    expect((await page.context().cookies()).find((cookie) => cookie.name === "nw_refresh")?.value).toBe(initialRefresh);

    await page.unroute("**/api/authoring/inbox");
    await page.goto(`/en/messages?to=${encodeURIComponent(recipientId)}`);
    await expect(page.getByLabel("Recipient user ID")).toHaveValue(recipientId);
    const conflictKeys: (string | undefined)[] = [];
    await page.route("**/api/authoring/inbox", async (route) => {
      if (route.request().method() !== "POST") { await route.continue(); return; }
      conflictKeys.push(route.request().headers()["idempotency-key"]);
      if (conflictKeys.length <= 2) {
        await route.fulfill({ status: 409, contentType: "application/json", body: '{"error":{"code":"IDEMPOTENCY_CONFLICT"}}' });
      } else {
        await route.continue();
      }
    });
    await page.getByRole("button", { name: "Start conversation" }).click();
    await expect(page.getByRole("alert")).toContainText("conflicts with an existing conversation");
    await page.getByRole("button", { name: "Start conversation" }).click();
    await expect(page.getByRole("alert")).toContainText("conflicts with an existing conversation");
    expect(conflictKeys[1]).toBe(conflictKeys[0]);
    await page.getByRole("button", { name: "Discard pending request and start over" }).click();
    await page.getByRole("button", { name: "Start conversation" }).click();
    await page.waitForURL("**/en/messages/*");
    expect(conflictKeys[2]).toBeTruthy();
    expect(conflictKeys[2]).not.toBe(conflictKeys[1]);
  } finally {
    await recipientContext.close();
  }
});
