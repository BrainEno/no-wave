import { expect, test, type BrowserContext } from "@playwright/test";
import { uniqueEmail } from "./support/accounts.ts";

const PASSWORD = "browser-message-safety-password";
const ACTOR_HEADER = "x-expected-messaging-actor";

async function register(context: BrowserContext, origin: string) {
  const email = uniqueEmail("message-safety");
  const response = await context.request.post(`${origin}/api/auth/register`, {
    headers: { origin }, data: { email, password: PASSWORD },
  });
  expect(response.status()).toBe(201);
  const identity = await context.request.get(`${origin}/api/authoring/session`);
  expect(identity.status()).toBe(200);
  return { email, id: (await identity.json()).data.id as string };
}

async function signIn(context: BrowserContext, origin: string, email: string) {
  const response = await context.request.post(`${origin}/api/auth/login`, {
    headers: { origin }, data: { email, password: PASSWORD },
  });
  expect(response.status()).toBe(200);
}

async function start(context: BrowserContext, origin: string, recipient: string): Promise<string> {
  const response = await context.request.post(`${origin}/api/authoring/inbox`, {
    headers: { origin, "idempotency-key": crypto.randomUUID() }, data: { participantIds: [recipient] },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).data.id as string;
}

test("a lost conversation response cannot be replayed as another account", async ({ browser, page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const otherContext = await browser.newContext({ baseURL: origin });
  try {
    const recipient = await register(otherContext, origin);
    const replacement = await register(otherContext, origin);
    const author = await register(page.context(), origin);
    const requests: { key: string | undefined; actor: string | undefined; body: string | null }[] = [];
    let createdId = "";
    await page.route("**/api/authoring/inbox", async (route) => {
      if (route.request().method() !== "POST") { await route.continue(); return; }
      requests.push({ key: route.request().headers()["idempotency-key"], actor: route.request().headers()[ACTOR_HEADER], body: route.request().postData() });
      if (requests.length === 1) {
        const stored = await route.fetch();
        expect(stored.status()).toBe(201);
        createdId = (await stored.json()).data.id as string;
        await route.abort("failed");
      } else await route.continue();
    });
    await page.goto(`/messages?to=${recipient.id}`);
    await page.getByRole("button", { name: "发起对话", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("暂时无法确认对话是否创建");
    // A different tab can replace HttpOnly cookies without remounting this form.
    await signIn(page.context(), origin, replacement.email);
    await page.getByRole("button", { name: "发起对话", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("登录原账户");
    expect(new URL(page.url()).pathname).toBe("/messages");
    expect(requests).toHaveLength(2);
    expect(requests[0].actor).toBe(author.id);
    expect(requests[1]).toEqual(requests[0]);
    const inbox = await page.context().request.get(`${origin}/api/authoring/inbox`);
    const rows = (await inbox.json()).data as { id: string }[];
    expect(rows, "the replacement account must not acquire a second conversation").toEqual([]);
    await signIn(page.context(), origin, author.email);
    await page.getByRole("button", { name: "发起对话", exact: true }).click();
    await page.waitForURL(`**/messages/${createdId}`);
    expect(requests[2]).toEqual(requests[0]);
    await expect(page.getByRole("dialog", { name: "请求尚未确认" })).not.toBeVisible();
  } finally { await otherContext.close(); }
});

test("a lost message stays bound to its sender even when the other member signs in", async ({ browser, page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const otherContext = await browser.newContext({ baseURL: origin });
  try {
    const recipient = await register(otherContext, origin);
    const author = await register(page.context(), origin);
    const conversation = await start(page.context(), origin, recipient.id);
    const requests: { key: string | undefined; actor: string | undefined; body: string | null }[] = [];
    await page.route(`**/api/authoring/inbox/${conversation}/messages`, async (route) => {
      if (route.request().method() !== "POST") { await route.continue(); return; }
      requests.push({ key: route.request().headers()["idempotency-key"], actor: route.request().headers()[ACTOR_HEADER], body: route.request().postData() });
      if (requests.length === 1) {
        const stored = await route.fetch();
        expect(stored.status()).toBe(201);
        await route.abort("failed");
      } else await route.continue();
    });
    await page.goto(`/messages/${conversation}`);
    await page.getByLabel("写一条消息").fill("A message with one original sender.");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("暂时无法确认消息是否发出");
    await signIn(page.context(), origin, recipient.email);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("登录原账户");
    expect(requests[0].actor).toBe(author.id);
    expect(requests[1]).toEqual(requests[0]);
    const stored = await otherContext.request.get(`${origin}/api/authoring/inbox/${conversation}/messages`);
    expect((await stored.json()).data.map((message: { senderId: string; body: string }) => ({ senderId: message.senderId, body: message.body }))).toEqual([
      { senderId: author.id, body: "A message with one original sender." },
    ]);
    await signIn(page.context(), origin, author.email);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator(".nw-msg-body").getByText("A message with one original sender.", { exact: true })).toHaveCount(1);
    await expect(page.getByLabel("写一条消息")).toHaveValue("");
    expect(requests[2]).toEqual(requests[0]);
  } finally { await otherContext.close(); }
});

test("mark-all uses the account whose conversation was opened, not replacement cookies", async ({ browser, page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const otherContext = await browser.newContext({ baseURL: origin });
  try {
    const recipient = await register(otherContext, origin);
    const author = await register(page.context(), origin);
    const conversation = await start(page.context(), origin, recipient.id);
    const sent = await page.context().request.post(`${origin}/api/authoring/inbox/${conversation}/messages`, {
      headers: { origin, "idempotency-key": crypto.randomUUID() }, data: { body: "Unread for the other member." },
    });
    expect(sent.status()).toBe(201);
    await page.goto(`/messages/${conversation}`);
    await expect(page.locator(".nw-msg-body")).toContainText("Unread for the other member.");
    await expect(page.locator(".nw-msg-mine")).toHaveCount(1);
    await signIn(page.context(), origin, recipient.email);
    const marked = page.waitForResponse((response) => response.url().endsWith(`/inbox/${conversation}/read`));
    await page.getByRole("button", { name: "将全部标为已读", exact: true }).click();
    const response = await marked;
    expect(response.status()).toBe(409);
    expect(response.request().headers()[ACTOR_HEADER]).toBe(author.id);
    await expect(page.getByRole("alert")).toContainText("登录原账户");
    const inbox = await otherContext.request.get(`${origin}/api/authoring/inbox`);
    const row = (await inbox.json()).data.find((item: { id: string }) => item.id === conversation);
    expect(row.unreadCount).toBe(1);
    await signIn(page.context(), origin, author.email);
    await page.getByRole("button", { name: "将全部标为已读", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("已向服务器标记");
  } finally { await otherContext.close(); }
});

test("an uncertain reply protects navigation and reload; same-key confirmation releases both", async ({ browser, page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const otherContext = await browser.newContext({ baseURL: origin });
  try {
    const recipient = await register(otherContext, origin);
    await register(page.context(), origin);
    const conversation = await start(page.context(), origin, recipient.id);
    const keys: (string | undefined)[] = [];
    await page.route(`**/api/authoring/inbox/${conversation}/messages`, async (route) => {
      if (route.request().method() !== "POST") { await route.continue(); return; }
      keys.push(route.request().headers()["idempotency-key"]);
      if (keys.length === 1) {
        const stored = await route.fetch();
        expect(stored.status()).toBe(201);
        await route.abort("failed");
      } else await route.continue();
    });
    await page.goto(`/messages/${conversation}`);
    await page.getByLabel("写一条消息").fill("Keep my original message and key.");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("暂时无法确认消息是否发出");
    await page.getByRole("link", { name: /返回收件箱/ }).click();
    const modal = page.getByRole("dialog", { name: "请求尚未确认" });
    await expect(modal).toBeVisible();
    await expect(modal).toContainText("原账户的收件箱");
    await expect(modal.getByRole("button", { name: "留在此页" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(modal).not.toBeVisible();
    await expect(page.getByLabel("写一条消息")).toHaveValue("Keep my original message and key.");
    // A real reload is guarded as well, not only React Router navigation.
    const nextDialog = page.waitForEvent("dialog");
    const reload = page.reload().catch(() => null);
    const native = await nextDialog;
    expect(native.type()).toBe("beforeunload");
    await native.dismiss();
    await reload;
    expect(new URL(page.url()).pathname).toBe(`/messages/${conversation}`);
    await expect(page.getByLabel("写一条消息")).toHaveValue("Keep my original message and key.");
    expect(keys).toHaveLength(1);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator(".nw-msg-body").getByText("Keep my original message and key.", { exact: true })).toHaveCount(1);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(await page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    })).toBe(false);
    await page.getByRole("link", { name: /返回收件箱/ }).click();
    await expect(page).toHaveURL(`${origin}/messages`);
    await expect(page.getByRole("dialog", { name: "请求尚未确认" })).not.toBeVisible();
    const stored = await otherContext.request.get(`${origin}/api/authoring/inbox/${conversation}/messages`);
    expect((await stored.json()).data).toHaveLength(1);
  } finally { await otherContext.close(); }
});

test("choosing to leave an in-flight start cancels local work and cannot navigate back on a late success", async ({ browser, page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const otherContext = await browser.newContext({ baseURL: origin });
  let release: () => void = () => {};
  try {
    const recipient = await register(otherContext, origin);
    await register(page.context(), origin);
    let committed!: () => void;
    const stored = new Promise<void>((resolve) => { committed = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let delivered!: () => void;
    const finished = new Promise<void>((resolve) => { delivered = resolve; });
    let conversation = "";
    let writes = 0;
    await page.route("**/api/authoring/inbox", async (route) => {
      if (route.request().method() !== "POST") { await route.continue(); return; }
      writes++;
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      conversation = (await response.json()).data.id as string;
      committed();
      await gate;
      try { await route.fulfill({ response }); } finally { delivered(); }
    });
    await page.goto(`/messages?to=${recipient.id}`);
    await page.getByRole("button", { name: "发起对话", exact: true }).click();
    await stored;
    await expect(page.getByRole("button", { name: "正在发起…", exact: true })).toBeDisabled();
    await page.locator("a.nw-rail").click();
    const modal = page.getByRole("dialog", { name: "请求尚未确认" });
    await expect(modal).toBeVisible();
    await modal.getByRole("button", { name: "仍要离开", exact: true }).click();
    await expect(page).toHaveURL(`${origin}/`);
    release();
    await finished;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page).toHaveURL(`${origin}/`);
    expect(writes).toBe(1);
    const inbox = await page.context().request.get(`${origin}/api/authoring/inbox`);
    expect((await inbox.json()).data.map((row: { id: string }) => row.id)).toEqual([conversation]);
  } finally { release(); await otherContext.close(); }
});

test("unverifiable identity leaves history and draft readable but disables every mutation until explicit retry", async ({ browser, page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const otherContext = await browser.newContext({ baseURL: origin });
  try {
    const recipient = await register(otherContext, origin);
    const author = await register(page.context(), origin);
    const conversation = await start(page.context(), origin, recipient.id);
    const sent = await otherContext.request.post(`${origin}/api/authoring/inbox/${conversation}/messages`, {
      headers: { origin, "idempotency-key": crypto.randomUUID() }, data: { body: "Existing private history." },
    });
    expect(sent.status()).toBe(201);
    let reads = 0;
    await page.route("**/api/authoring/session", async (route) => {
      if (++reads === 1) await route.fulfill({ json: { data: {} } });
      else await route.continue();
    });
    const writes: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith(`/inbox/${conversation}/messages`)) writes.push(request.headers()[ACTOR_HEADER]);
    });
    await page.goto(`/messages/${conversation}`);
    await expect(page.locator(".nw-msg-body")).toContainText("Existing private history.");
    await expect(page.getByRole("alert")).toContainText("暂时无法确认当前账户");
    await page.getByLabel("写一条消息").fill("Draft that must not leave before account verification.");
    await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "将全部标为已读", exact: true })).toBeDisabled();
    expect(writes).toHaveLength(0);
    await page.getByRole("button", { name: "重新确认账户", exact: true }).click();
    await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "将全部标为已读", exact: true })).toBeEnabled();
    await expect(page.getByLabel("写一条消息")).toHaveValue("Draft that must not leave before account verification.");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator(".nw-msg-body").getByText("Draft that must not leave before account verification.", { exact: true })).toHaveCount(1);
    expect(writes).toEqual([author.id]);
    expect(reads).toBe(2);
    const storage = await page.evaluate(() => JSON.stringify({ local: Object.entries(localStorage), session: Object.entries(sessionStorage) }));
    expect(storage).not.toContain("Draft that must not leave before account verification.");
    expect(storage).not.toContain("Existing private history.");
  } finally { await otherContext.close(); }
});

test("a successful response naming another sender cannot acknowledge or erase the original message", async ({ browser, page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const otherContext = await browser.newContext({ baseURL: origin });
  try {
    const recipient = await register(otherContext, origin);
    const author = await register(page.context(), origin);
    const conversation = await start(page.context(), origin, recipient.id);
    const keys: (string | undefined)[] = [];
    await page.route(`**/api/authoring/inbox/${conversation}/messages`, async (route) => {
      if (route.request().method() !== "POST") { await route.continue(); return; }
      keys.push(route.request().headers()["idempotency-key"]);
      if (keys.length === 1) {
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        const payload = await response.json();
        await route.fulfill({ status: 201, json: { data: { ...payload.data, senderId: recipient.id } } });
      } else await route.continue();
    });
    await page.goto(`/messages/${conversation}`);
    await page.getByLabel("写一条消息").fill("Only my own acknowledgment can settle this.");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("暂时无法确认消息是否发出");
    await expect(page.getByLabel("写一条消息")).toHaveValue("Only my own acknowledgment can settle this.");
    await expect(page.locator(".nw-msg-body")).toHaveCount(0);
    await page.getByRole("button", { name: "再试一次", exact: true }).click();
    await expect(page.locator(".nw-msg-mine .nw-msg-body")).toHaveText("Only my own acknowledgment can settle this.");
    await expect(page.getByLabel("写一条消息")).toHaveValue("");
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    const stored = await otherContext.request.get(`${origin}/api/authoring/inbox/${conversation}/messages`);
    const rows = (await stored.json()).data as { senderId: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].senderId).toBe(author.id);
  } finally { await otherContext.close(); }
});

test("a failed older-history read cannot unmount protection for an uncertain reply", async ({ browser, page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const otherContext = await browser.newContext({ baseURL: origin });
  try {
    const recipient = await register(otherContext, origin);
    const author = await register(page.context(), origin);
    const conversation = await start(page.context(), origin, recipient.id);
    let reads = 0;
    const keys: (string | undefined)[] = [];
    await page.route(new RegExp(`/api/authoring/inbox/${conversation}/messages(?:\\?|$)`), async (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        keys.push(request.headers()["idempotency-key"]);
        if (keys.length === 1) {
          const response = await route.fetch();
          expect(response.status()).toBe(201);
          await route.abort("failed");
        } else await route.continue();
        return;
      }
      const url = new URL(request.url());
      if (url.searchParams.has("before")) {
        await route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE" } } });
      } else if (++reads === 1) {
        await route.fulfill({ json: { data: Array.from({ length: 100 }, (_, index) => ({
          id: `older-history-${index}`, senderId: recipient.id, body: `Earlier history ${index}`,
          conversationId: conversation, createdAt: "2026-11-01T00:00:00.000Z",
        })) } });
      } else await route.continue();
    });
    await page.goto(`/messages/${conversation}`);
    await expect(page.locator(".nw-msg")).toHaveCount(100);
    await page.getByLabel("写一条消息").fill("Keep the key when history fails.");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("暂时无法确认消息是否发出");
    await page.getByRole("button", { name: "看更早的消息", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("这段对话没能读取");
    await page.getByRole("link", { name: /返回收件箱/ }).click();
    const modal = page.getByRole("dialog", { name: "请求尚未确认" });
    await expect(modal).toBeVisible();
    await modal.getByRole("button", { name: "留在此页", exact: true }).click();
    expect(new URL(page.url()).pathname).toBe(`/messages/${conversation}`);
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await expect(page.getByLabel("写一条消息")).toHaveValue("Keep the key when history fails.");
    await expect(page.locator(".nw-msg-body")).toHaveText("Keep the key when history fails.");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByLabel("写一条消息")).toHaveValue("");
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    await expect(page.locator(".nw-msg-body")).toHaveCount(1);
    const stored = await otherContext.request.get(`${origin}/api/authoring/inbox/${conversation}/messages`);
    expect((await stored.json()).data.map((message: { senderId: string }) => message.senderId)).toEqual([author.id]);
  } finally { await otherContext.close(); }
});
