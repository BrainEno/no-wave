import { expect, test, type APIRequestContext } from "@playwright/test";
import { publishWork, uniqueEmail, WORK_PASSWORD } from "./support/works.ts";

const api = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:4000";
const pathFor = (slug: string) => `/api/authoring/articles/${slug}/views?locale=zh-CN`;

/** Assert durable state, not the body of a fire-and-forget fetch the UI never drains. */
async function persistedViews(request: APIRequestContext, slug: string): Promise<number> {
  const response = await request.get(`${api}/api/v1/articles/${slug}?locale=zh-CN`);
  expect(response.status()).toBe(200);
  return (await response.json()).data.viewCount;
}

test("an author's mounted reading page sends its scoped cookie and cannot increment its own work", async ({ page, request, baseURL }) => {
  const { email, slug } = await publishWork(request, `作者自阅 ${Date.now().toString(36)}`, ["作者自己的阅读不应计入。"]);
  const origin = new URL(baseURL!).origin;
  const login = await page.context().request.post(`${origin}/api/auth/login`, { headers: { origin }, data: { email, password: WORK_PASSWORD } });
  expect(login.status()).toBe(200);
  const before = await page.context().cookies();
  const access = before.find(({ name }) => name === "nw_access");
  expect(access?.path).toBe("/api/authoring");
  expect(access?.httpOnly).toBe(true);
  const refresh = before.find(({ name }) => name === "nw_refresh")?.value;
  expect(Boolean(refresh)).toBe(true);
  const beacon = page.waitForResponse((response) => response.url().endsWith(pathFor(slug)) && response.request().method() === "POST");
  const navigation = await page.goto(`/articles/${slug}`);
  expect(navigation?.status()).toBe(200);
  const pageHeaders = await navigation!.request().allHeaders();
  expect(pageHeaders.cookie ?? "").not.toContain("nw_access=");
  expect(pageHeaders.cookie ?? "").not.toContain("nw_refresh=");
  const response = await beacon;
  expect(response.status()).toBe(200);
  expect(await persistedViews(request, slug)).toBe(0);
  const headers = await response.request().allHeaders();
  expect(headers.cookie ?? "").toContain("nw_access=");
  expect(headers.cookie ?? "").toContain("nw_refresh=");
  expect(response.request().postData()).toBeNull();
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(response.headers()["x-nw-client-address-proof"]).toBeUndefined();
  await expect(page.getByText("作者自己的阅读不应计入。", { exact: true })).toBeVisible();
  const detail = await request.get(`${api}/api/v1/articles/${slug}?locale=zh-CN`);
  expect(detail.status()).toBe(200);
  expect((await detail.json()).data.viewCount).toBe(0);
  const repeat = page.waitForResponse((response) => response.url().endsWith(pathFor(slug)) && response.request().method() === "POST");
  await page.reload();
  expect((await repeat).status()).toBe(200);
  expect(await persistedViews(request, slug)).toBe(0);
  expect((await page.context().cookies()).find(({ name }) => name === "nw_refresh")?.value === refresh).toBe(true);
  const exposed = await page.evaluate(() => document.cookie);
  expect(exposed).not.toContain("nw_access=");
  expect(exposed).not.toContain("nw_refresh=");
});

test("two signed-in readers on the same NAT count separately while anonymous readers still dedupe by address", async ({ browser, request, baseURL }) => {
  const { slug } = await publishWork(request, `同网不同读者 ${Date.now().toString(36)}`, ["共享出口地址不是共享账户。"]);
  const origin = new URL(baseURL!).origin;
  const first = await browser.newContext({ baseURL: origin });
  const second = await browser.newContext({ baseURL: origin });
  const anonymous = await browser.newContext({ baseURL: origin });
  try {
    for (const [index, context] of [first, second].entries()) {
      const registered = await context.request.post(`${origin}/api/auth/register`, {
        headers: { origin }, data: { email: uniqueEmail(`nat-reader-${index}`), password: WORK_PASSWORD },
      });
      expect(registered.status()).toBe(201);
      const page = await context.newPage();
      const beacon = page.waitForResponse((response) => response.url().endsWith(pathFor(slug)) && response.request().method() === "POST");
      await page.goto(`/articles/${slug}`);
      const response = await beacon;
      expect(response.status()).toBe(200);
      expect((await response.request().allHeaders()).cookie ?? "").toContain("nw_access=");
      expect(await persistedViews(request, slug)).toBe(index + 1);
      const repeated = page.waitForResponse((reply) => reply.url().endsWith(pathFor(slug)) && reply.request().method() === "POST");
      await page.reload();
      expect((await repeated).status()).toBe(200);
      expect(await persistedViews(request, slug)).toBe(index + 1);
    }
    const firstIdentity = await first.request.get("/api/authoring/session");
    const secondIdentity = await second.request.get("/api/authoring/session");
    expect(firstIdentity.status()).toBe(200);
    expect(secondIdentity.status()).toBe(200);
    expect((await firstIdentity.json()).data.id === (await secondIdentity.json()).data.id).toBe(false);
    const visitor = await anonymous.newPage();
    const anonymousView = visitor.waitForResponse((response) => response.url().endsWith(pathFor(slug)) && response.request().method() === "POST");
    await visitor.goto(`/articles/${slug}`);
    const viewed = await anonymousView;
    expect(viewed.status()).toBe(200);
    expect((await viewed.request().allHeaders()).cookie ?? "").not.toContain("nw_access=");
    expect(await persistedViews(request, slug)).toBe(3);
    const anonymousRepeat = visitor.waitForResponse((response) => response.url().endsWith(pathFor(slug)) && response.request().method() === "POST");
    await visitor.reload();
    expect((await anonymousRepeat).status()).toBe(200);
    expect(await persistedViews(request, slug)).toBe(3);
    const detail = await request.get(`${api}/api/v1/articles/${slug}?locale=zh-CN`);
    expect(detail.status()).toBe(200);
    expect((await detail.json()).data.viewCount).toBe(3);
    const reloadFirst = first.pages()[0]!;
    const onceMore = reloadFirst.waitForResponse((response) => response.url().endsWith(pathFor(slug)) && response.request().method() === "POST");
    await reloadFirst.reload();
    expect((await onceMore).status()).toBe(200);
    expect(await persistedViews(request, slug)).toBe(3);
  } finally {
    await Promise.all([first.close(), second.close(), anonymous.close()]);
  }
});

test("browser-cookie renewal verifies the author before counting and a revoked session never degrades to anonymous success", async ({ page, request, baseURL }) => {
  const { email, slug } = await publishWork(request, `过期身份阅读 ${Date.now().toString(36)}`, ["续期和撤销都不能创造匿名自阅。"]);
  const origin = new URL(baseURL!).origin;
  const login = await page.context().request.post(`${origin}/api/auth/login`, { headers: { origin }, data: { email, password: WORK_PASSWORD } });
  expect(login.status()).toBe(200);
  const previousRefresh = (await page.context().cookies()).find(({ name }) => name === "nw_refresh")?.value;
  expect(Boolean(previousRefresh)).toBe(true);
  // A same-origin inert document avoids background private readers racing the
  // exact cookie transition under test. The request still uses Chromium's jar.
  await page.goto("/healthz");
  await page.context().clearCookies({ name: "nw_access" });
  const sent = page.waitForRequest((request) => request.url().endsWith(pathFor(slug)) && request.method() === "POST");
  const renewed = await page.evaluate(async (path) => {
    const response = await fetch(path, { method: "POST", credentials: "same-origin", cache: "no-store" });
    return { status: response.status, body: await response.json(), cache: response.headers.get("cache-control") };
  }, pathFor(slug));
  const headers = await (await sent).allHeaders();
  expect(headers.cookie ?? "").not.toContain("nw_access=");
  expect(headers.cookie ?? "").toContain("nw_refresh=");
  expect(renewed.status).toBe(200);
  expect(renewed.body.data).toEqual({ counted: false, viewCount: 0 });
  expect(renewed.cache).toContain("no-store");
  const currentCookies = await page.context().cookies();
  expect(currentCookies.some(({ name, path }) => name === "nw_access" && path === "/api/authoring")).toBe(true);
  const nextRefresh = currentCookies.find(({ name }) => name === "nw_refresh")?.value;
  expect(Boolean(nextRefresh) && nextRefresh !== previousRefresh).toBe(true);
  const revoke = await request.post(`${api}/api/v1/auth/logout`, { data: { refreshToken: nextRefresh } });
  expect(revoke.status()).toBe(200);
  const rejected = await page.evaluate(async (path) => {
    const response = await fetch(path, { method: "POST", credentials: "same-origin", cache: "no-store" });
    return { status: response.status, body: await response.json() };
  }, pathFor(slug));
  expect(rejected.status).toBe(401);
  expect(rejected.body.data).toBeUndefined();
  const after = await page.context().cookies();
  expect(after.some(({ name }) => ["nw_access", "nw_refresh", "nw_session"].includes(name))).toBe(false);
  const persisted = await request.get(`${api}/api/v1/articles/${slug}?locale=zh-CN`);
  expect(persisted.status()).toBe(200);
  expect((await persisted.json()).data.viewCount).toBe(0);
  // Only the following, now-genuinely-anonymous read may create the address row.
  const anonymous = await page.evaluate(async (path) => {
    const response = await fetch(path, { method: "POST", credentials: "same-origin", cache: "no-store" });
    return { status: response.status, body: await response.json() };
  }, pathFor(slug));
  expect(anonymous.status).toBe(200);
  expect(anonymous.body.data).toEqual({ counted: true, viewCount: 1 });
});
