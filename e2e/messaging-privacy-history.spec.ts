import { expect } from "@playwright/test";
import { test } from "./support/csp-fixture.ts";
import { ACTOR_HEADER, conversation, gate, login, register, restorePage, settleUi } from "./support/messaging-privacy.ts";

test("a late older page that ignores abort cannot prepend into a recovered thread", async ({ browser, page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const separate = await browser.newContext({ baseURL: origin });
  const entered = gate(), release = gate(), delivered = gate();
  try {
    const recipient = await register(separate, origin);
    const author = await register(page.context(), origin);
    const id = await conversation(page.context(), origin, recipient.id, "Fresh history after recovery.");
    // Exercise the generation fence, not just native fetch cancellation. Only
    // this older-page read ignores its AbortSignal; its body really arrives late.
    await page.addInitScript(({ id }) => {
      const native = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
        if (url.pathname !== `/api/authoring/inbox/${id}/messages` || !url.searchParams.has("before")) return native(input, init);
        const response = await native(input, { ...init, signal: undefined });
        const bytes = await response.arrayBuffer();
        (window as Window & { privacyOldReadDelivered?: boolean }).privacyOldReadDelivered = true;
        return new Response(bytes, { status: response.status, headers: response.headers });
      };
    }, { id });
    let newestReads = 0;
    const cursors: string[] = [];
    const actors: (string | undefined)[] = [];
    await page.route(new RegExp(`/api/authoring/inbox/${id}/messages(?:\\?|$)`), async (route) => {
      const request = route.request();
      expect(request.method()).toBe("GET");
      actors.push(request.headers()[ACTOR_HEADER]);
      const before = new URL(request.url()).searchParams.get("before");
      if (before !== null) {
        cursors.push(before);
        entered.release();
        await release.promise;
        try {
          await route.fulfill({ json: { data: [{ id: "late-old-page", senderId: recipient.id,
            body: "Obsolete older history must never reappear.", createdAt: "2026-11-01T00:00:00.000Z" }] } });
        } finally { delivered.release(); }
      } else if (++newestReads === 1) {
        await route.fulfill({ json: { data: Array.from({ length: 100 }, (_, index) => ({
          id: `first-page-${index}`, senderId: recipient.id, body: `Original page ${index}`,
          createdAt: "2026-11-01T00:00:00.000Z",
        })) } });
      } else await route.continue();
    });
    await page.goto(`/messages/${id}`);
    await expect(page.locator(".nw-msg")).toHaveCount(100);
    expect(await page.locator(".nw-msg-body").first().textContent()).toBe("Original page 0");
    await page.getByRole("button", { name: "看更早的消息", exact: true }).click();
    await entered.promise;
    expect(cursors).toEqual(["first-page-0"]);
    const hidden = await page.evaluate(() => {
      window.dispatchEvent(new Event("pagehide"));
      return document.querySelectorAll(".nw-msg-body").length;
    });
    expect(hidden, "the old DOM is gone before the pagehide handler returns").toBe(0);
    await restorePage(page);
    await expect(page.locator(".nw-msg-body")).toHaveText("Fresh history after recovery.");
    release.release();
    await delivered.promise;
    await page.waitForFunction(() => (window as Window & { privacyOldReadDelivered?: boolean }).privacyOldReadDelivered === true);
    await settleUi(page);
    await expect(page.locator(".nw-msg-body")).toHaveText("Fresh history after recovery.");
    await expect(page.getByText("Obsolete older history must never reappear.", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "看更早的消息", exact: true })).toHaveCount(0);
    expect(newestReads).toBe(2);
    expect(actors).toEqual([author.id, author.id, author.id]);
  } finally { release.release(); await separate.close(); }
});

test("a paging read rejects replacement cookies even when that account is also a conversation member", async ({ browser, page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const separate = await browser.newContext({ baseURL: origin });
  try {
    const recipient = await register(separate, origin);
    const author = await register(page.context(), origin);
    const id = await conversation(page.context(), origin, recipient.id, "The real stored member-only history.");
    let first = true;
    let writes = 0;
    page.on("request", (request) => {
      if (request.method() !== "GET" && request.url().includes("/api/authoring/inbox")) writes++;
    });
    await page.route(new RegExp(`/api/authoring/inbox/${id}/messages(?:\\?|$)`), async (route) => {
      if (first) {
        first = false;
        await route.fulfill({ json: { data: Array.from({ length: 100 }, (_, index) => ({
          id: `member-page-${index}`, senderId: author.id, body: `Private loaded history ${index}`,
          createdAt: "2026-11-01T00:00:00.000Z",
        })) } });
      } else await route.continue();
    });
    await page.goto(`/messages/${id}`);
    await expect(page.locator(".nw-msg-mine")).toHaveCount(100);
    await login(page.context(), origin, recipient.email);
    const allowed = await page.context().request.get(`${origin}/api/authoring/inbox/${id}/messages`);
    expect(allowed.status(), "membership alone would allow a new page to read").toBe(200);
    const response = page.waitForResponse((item) => item.url().includes(`/inbox/${id}/messages?`) && new URL(item.url()).searchParams.has("before"));
    await page.getByRole("button", { name: "看更早的消息", exact: true }).click();
    const denied = await response;
    expect(denied.status()).toBe(409);
    expect((await denied.json()).error.code).toBe("ACCOUNT_CHANGED");
    expect(denied.request().headers()[ACTOR_HEADER]).toBe(author.id);
    await expect(page.locator(".nw-msg-body")).toHaveCount(0);
    await expect(page.getByLabel("写一条消息")).toHaveCount(0);
    await expect(page.getByRole("alert")).toContainText("账户已变更");
    await page.getByRole("button", { name: "重新确认账户", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("账户已变更");
    await expect(page.locator(".nw-msg-body")).toHaveCount(0);
    await login(page.context(), origin, author.email);
    await page.getByRole("button", { name: "重新确认账户", exact: true }).click();
    await expect(page.locator(".nw-msg-mine .nw-msg-body")).toHaveText("The real stored member-only history.");
    expect(writes, "neither mismatch nor recovery may mark read or resend").toBe(0);
  } finally { await separate.close(); }
});
