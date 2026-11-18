import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { test } from "./support/csp-fixture.ts";
import { startFontStack } from "./support/font-stack.ts";

// An explicit resource-route opt-in, not a migration of the synchronous UI.
// The independent finite command is invoked once, never scheduled by the API.
test("an author's browser queues encrypted input through Cookie-only resources, observes execution and cannot see another owner's job", async ({ page, browser }) => {
  const stack = await startFontStack({ notionJobs: true });
  try {
    const register = async () => {
      const response = await page.request.post(`${stack.apiBaseUrl}/api/v1/auth/register`, {
        data: { email: `notion-job-${randomUUID()}@example.test`, password: "Disposable browser jobs 5932!" },
      });
      expect(response.status()).toBe(201);
      return (await response.json()).data.accessToken as string;
    };
    // Use the real BFF registration, which installs both scoped credentials and
    // the non-authoritative session marker required by existing private shells.
    const registered = await page.request.post(`${stack.webBaseUrl}/api/auth/register`, {
      headers: { origin: stack.webBaseUrl },
      data: { email: `notion-owner-${randomUUID()}@example.test`, password: "Disposable browser jobs 5932!" },
    });
    expect(registered.status()).toBe(201);
    expect(await registered.text()).not.toMatch(/accessToken|refreshToken/);
    expect((await page.context().cookies()).map(cookie => cookie.name)).toEqual(expect.arrayContaining(["nw_access", "nw_refresh", "nw_session"]));
    const foreignToken = await register();
    expect((await page.goto(`${stack.webBaseUrl}/write/notion`))?.status()).toBe(200);
    await expect(page).toHaveURL(`${stack.webBaseUrl}/write/notion`);
    await expect(page.getByRole("heading", { name: /从 Notion 导入/ })).toBeVisible();
    const requestKey = randomUUID();
    const started = await page.evaluate(async ({ requestKey, sourceId }) => {
      const bundle = { version: 1, pages: [{ id: sourceId,
        properties: { Page: { type: "title", title: [{ type: "text", plain_text: "私有队列来源标题", text: { content: "私有队列来源标题" } }] } },
        blocks: [{ id: "body", type: "paragraph", paragraph: { rich_text: [{ type: "text", plain_text: "明确选择后导入的正文。", text: { content: "明确选择后导入的正文。" } }] } }],
      }] };
      const preview = await fetch("/api/authoring/notion-import", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ bundle, apply: false }) });
      const plan = await preview.json();
      if (preview.status !== 200 || typeof plan.data?.planToken !== "string") throw new Error("The existing signed preview was unavailable.");
      const response = await fetch("/api/authoring/notion-jobs", { method: "POST", headers: {
        "content-type": "application/json", "idempotency-key": requestKey, authorization: "Bearer browser-must-not-control-identity",
      }, body: JSON.stringify({ bundle, planToken: plan.data.planToken }) });
      return { status: response.status, location: response.headers.get("location"), cache: response.headers.get("cache-control"), text: await response.text() };
    }, { requestKey, sourceId: randomUUID() });
    expect(started.status).toBe(202);
    expect(started.cache).toContain("no-store");
    const job = JSON.parse(started.text).data;
    expect(job.state).toBe("queued");
    expect(job.completed).toBe(0);
    expect(started.text).not.toMatch(/私有队列来源标题|明确选择后导入|ownerId|leaseToken|planToken|ciphertext/);
    expect(started.location).toBe(`/api/authoring/notion-jobs/${job.id}`);
    const conditional = await page.evaluate(async path => {
      const initial = await fetch(path, { cache: "no-store" });
      const etag = initial.headers.get("etag")!;
      await initial.arrayBuffer();
      const next = await fetch(path, { cache: "no-store", headers: { "if-none-match": etag } });
      return { status: next.status, text: await next.text(), etag: next.headers.get("etag"), cache: next.headers.get("cache-control") };
    }, started.location!);
    expect(conditional.status).toBe(304);
    expect(conditional.text).toBe("");
    expect(conditional.cache).toContain("no-store");
    expect(conditional.etag).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    const lookup = await page.evaluate(async requestKey => {
      const response = await fetch("/api/authoring/notion-jobs", { headers: { "idempotency-key": requestKey } });
      return { status: response.status, data: (await response.json()).data };
    }, requestKey);
    expect(lookup.status).toBe(200);
    expect(lookup.data.map((item: { id: string }) => item.id)).toEqual([job.id]);
    const foreign = await browser.newContext();
    try {
      await foreign.addCookies([{ name: "nw_access", value: foreignToken, url: stack.webBaseUrl, httpOnly: true, sameSite: "Lax" }]);
      const hidden = await foreign.request.get(stack.webBaseUrl + started.location!);
      expect(hidden.status()).toBe(404);
      expect(hidden.headers().etag).toBeUndefined();
    } finally { await foreign.close(); }
    const rejected = await page.request.delete(stack.webBaseUrl + started.location!, { headers: { origin: "https://foreign.example.test" } });
    expect(rejected.status()).toBe(403);
    const drained = await stack.drainNotionJobs();
    expect(drained).toContain('"succeeded":1');
    const completed = await page.evaluate(async path => {
      const response = await fetch(path);
      return { status: response.status, data: (await response.json()).data };
    }, started.location!);
    expect(completed.status).toBe(200);
    expect(completed.data).toMatchObject({ state: "succeeded", completed: 1, report: { summary: { create: 1 } } });
    await page.goto(`${stack.webBaseUrl}/write`);
    await expect(page.getByRole("complementary", { name: "我的作品", exact: true }).getByRole("button", { name: /^私有队列来源标题 草稿/ })).toBeVisible();
    await page.context().clearCookies();
    const forged = await page.evaluate(async path => (await fetch(path, { headers: { authorization: "Bearer a-browser-token-is-not-a-session" } })).status, started.location!);
    expect(forged).toBe(401);
  } finally { await stack.close(); }
});
