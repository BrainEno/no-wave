import { expect } from "@playwright/test";
import { test } from "./support/csp-fixture.ts";
import { DatabaseSync } from "node:sqlite";
import { startFontStack } from "./support/font-stack.ts";
import { uniqueEmail, WORK_PASSWORD } from "./support/works.ts";
import { openCookieProbe } from "./support/cookie-probe.ts";

test("the browser's different cookie Paths still join explicit and automatic refresh into one generation", async ({ page }) => {
  const stack = await startFontStack();
  try {
    const origin = stack.webBaseUrl;
    const registered = await page.context().request.post(`${origin}/api/auth/register`, { headers: { origin }, data: { email: uniqueEmail("refresh-paths"), password: WORK_PASSWORD } });
    expect(registered.status()).toBe(201);
    const before = await page.context().cookies(origin + "/api/authoring/session");
    const access = before.find(({ name }) => name === "nw_access")!;
    const refresh = before.find(({ name }) => name === "nw_refresh")!;
    const claims = JSON.parse(Buffer.from(access.value.split(".")[1]!, "base64url").toString()) as { sid: string; sub: string };
    expect(access.path).toBe("/api/authoring");
    expect(refresh.path).toBe("/api");
    expect(access.httpOnly && refresh.httpOnly).toBe(true);
    await openCookieProbe(page, origin);
    // A stale bearer is sent to authoring, but Chromium omits it from auth by
    // Path. No JavaScript handles or supplies either real credential.
    await page.context().addCookies([{ ...access, value: "expired-fixture-access" }]);
    const directSent = page.waitForRequest((request) => request.url().endsWith("/api/auth/refresh"));
    const automaticSent = page.waitForRequest((request) => request.url().endsWith("/api/authoring/session"));
    const responses = await page.evaluate(async () => Promise.all([
      ["/api/auth/refresh", "POST"], ["/api/authoring/session", "GET"], ["/api/auth/refresh", "POST"], ["/api/authoring/session", "GET"],
    ].map(async ([path, method]) => {
      const response = await fetch(path!, { method, credentials: "same-origin", cache: "no-store" });
      return { status: response.status, body: await response.json(), cache: response.headers.get("cache-control"), cookiesVisible: response.headers.has("set-cookie") };
    })));
    expect(responses.map(({ status }) => status)).toEqual([200, 200, 200, 200]);
    expect(responses[1]!.body.data.id).toBe(claims.sub);
    expect(responses[3]!.body.data.id).toBe(claims.sub);
    expect(responses.every(({ cache, cookiesVisible }) => cache?.includes("no-store") && !cookiesVisible)).toBe(true);
    const directHeaders = await (await directSent).allHeaders();
    const automaticHeaders = await (await automaticSent).allHeaders();
    expect(directHeaders.cookie ?? "").not.toContain("nw_access=");
    expect(directHeaders.cookie ?? "").toContain("nw_refresh=");
    expect(automaticHeaders.cookie ?? "").toContain("nw_access=expired-fixture-access");
    expect(automaticHeaders.cookie ?? "").toContain("nw_refresh=");
    const after = await page.context().cookies(origin + "/api/authoring/session");
    const nextAccess = after.find(({ name }) => name === "nw_access")!;
    const nextRefresh = after.find(({ name }) => name === "nw_refresh")!;
    expect(Boolean(nextAccess && nextRefresh)).toBe(true);
    expect(nextRefresh.value !== refresh.value).toBe(true);
    expect(nextAccess.httpOnly && nextRefresh.httpOnly).toBe(true);
    expect(nextAccess.path).toBe("/api/authoring");
    expect(nextRefresh.path).toBe("/api");
    expect(JSON.stringify(responses).includes(nextAccess.value)).toBe(false);
    expect(JSON.stringify(responses).includes(nextRefresh.value)).toBe(false);
    expect(await page.evaluate(() => document.cookie.includes("nw_access=") || document.cookie.includes("nw_refresh="))).toBe(false);
    const database = new DatabaseSync(stack.databasePath, { readOnly: true });
    try {
      const rows = database.prepare("SELECT used_at FROM auth_refresh_tokens WHERE session_id = ?").all(claims.sid);
      expect(rows.length).toBe(2);
      expect(rows.filter(({ used_at }) => used_at === null).length).toBe(1);
      expect(Number(database.prepare("SELECT count(*) AS n FROM revoked_sessions").get()!.n)).toBe(0);
    } finally { database.close(); }
    const identity = await page.context().request.get(`${origin}/api/authoring/session`);
    expect(identity.status()).toBe(200);
    expect((await identity.json()).data.id).toBe(claims.sub);
  } finally { await stack.close(); }
});

test("a refresh-only browser burst restores the HttpOnly access cookie without revoking its winner", async ({ page }) => {
  const stack = await startFontStack();
  try {
    const origin = stack.webBaseUrl;
    const registered = await page.context().request.post(`${origin}/api/auth/register`, { headers: { origin }, data: { email: uniqueEmail("refresh-expiry"), password: WORK_PASSWORD } });
    expect(registered.status()).toBe(201);
    const original = (await page.context().cookies()).find(({ name }) => name === "nw_refresh")!;
    await openCookieProbe(page, origin);
    await page.context().clearCookies({ name: "nw_access" });
    const sent = page.waitForRequest((request) => request.url().endsWith("/api/authoring/session"));
    const responses = await page.evaluate(async () => Promise.all([
      fetch("/api/auth/refresh", { method: "POST", credentials: "same-origin", cache: "no-store" }),
      fetch("/api/authoring/session", { credentials: "same-origin", cache: "no-store" }),
      fetch("/api/authoring/session", { credentials: "same-origin", cache: "no-store" }),
    ].map(async (pending) => { const response = await pending; return { status: response.status, body: await response.json() }; })));
    const headers = await (await sent).allHeaders();
    expect(headers.cookie ?? "").toContain("nw_refresh=");
    expect(headers.cookie ?? "").not.toContain("nw_access=");
    expect(responses.map(({ status }) => status)).toEqual([200, 200, 200]);
    expect(responses[1]!.body.data.id).toBe(responses[2]!.body.data.id);
    expect(responses[0]!.body.data.tokenType).toBe("Bearer");
    expect(responses[0]!.body.data.accessToken).toBeUndefined();
    expect(responses[0]!.body.data.refreshToken).toBeUndefined();
    const renewed = await page.context().cookies(origin + "/api/authoring/session");
    expect(renewed.some(({ name, httpOnly, path }) => name === "nw_access" && httpOnly && path === "/api/authoring")).toBe(true);
    expect(renewed.find(({ name }) => name === "nw_refresh")!.value !== original.value).toBe(true);
    const stillLive = await page.evaluate(async () => { const response = await fetch("/api/authoring/session", { cache: "no-store" }); return { status: response.status, body: await response.json() }; });
    expect(stillLive.status).toBe(200);
    expect(stillLive.body.data.id).toBe(responses[1]!.body.data.id);
  } finally { await stack.close(); }
});

test("a real 429 keeps browser cookies intact, exposes Retry-After and can recover with the unspent refresh token", async ({ page }) => {
  const stack = await startFontStack();
  try {
    const origin = stack.webBaseUrl;
    const registered = await page.context().request.post(`${origin}/api/auth/register`, { headers: { origin }, data: { email: uniqueEmail("refresh-throttle"), password: WORK_PASSWORD } });
    expect(registered.status()).toBe(201);
    // Establish exactly the real session bucket before saturating this private
    // fixture's fixed window. No production config or limiter is overridden.
    const baseline = new DatabaseSync(stack.databasePath, { readOnly: true });
    const priorKeys = new Set(baseline.prepare("SELECT key FROM auth_rate_limits").all().map(({ key }) => String(key)));
    baseline.close();
    expect((await page.context().request.post(`${origin}/api/auth/refresh`, { headers: { origin } })).status()).toBe(200);
    const previous = (await page.context().cookies()).find(({ name }) => name === "nw_refresh")!;
    const database = new DatabaseSync(stack.databasePath);
    try {
      const added = database.prepare("SELECT key, attempts FROM auth_rate_limits").all().filter(({ key }) => !priorKeys.has(String(key)));
      expect(added.length).toBe(1);
      expect(added[0]!.attempts).toBe(1);
      expect(Number(database.prepare("UPDATE auth_rate_limits SET attempts = 120 WHERE key = ?").run(String(added[0]!.key)).changes)).toBe(1);
    } finally { database.close(); }
    await openCookieProbe(page, origin);
    await page.context().clearCookies({ name: "nw_access" });
    const responses = await page.evaluate(async () => Promise.all([
      fetch("/api/authoring/session", { credentials: "same-origin", cache: "no-store" }),
      fetch("/api/auth/refresh", { method: "POST", credentials: "same-origin", cache: "no-store" }),
    ].map(async (pending) => { const response = await pending; return { status: response.status, body: await response.json(), retry: response.headers.get("retry-after"), cache: response.headers.get("cache-control") }; })));
    expect(responses.map(({ status }) => status)).toEqual([429, 429]);
    expect(responses.every(({ retry, cache, body }) => /^[1-9][0-9]{0,3}$/.test(retry ?? "") && Number(retry) <= 900 && cache?.includes("no-store") && body.error.code === "RATE_LIMITED")).toBe(true);
    const retained = await page.context().cookies();
    expect(retained.find(({ name }) => name === "nw_refresh")!.value === previous.value).toBe(true);
    expect(retained.some(({ name }) => name === "nw_session")).toBe(true);
    expect(retained.some(({ name }) => name === "nw_access")).toBe(false);
    const expiry = new DatabaseSync(stack.databasePath);
    try { expiry.prepare("UPDATE auth_rate_limits SET reset_at = ?").run("2000-01-01T00:00:00.000Z"); }
    finally { expiry.close(); }
    // The ledger remembers a transient burst for 250 ms; retry polling checks
    // eventual recovery, not an arbitrary network delay or a relaxed outcome.
    await expect.poll(async () => (await page.context().request.get(`${origin}/api/authoring/session`)).status(), { timeout: 5000 }).toBe(200);
    const recovered = await page.context().cookies(origin + "/api/authoring/session");
    expect(recovered.some(({ name, httpOnly }) => name === "nw_access" && httpOnly)).toBe(true);
    expect(recovered.find(({ name }) => name === "nw_refresh")!.value !== previous.value).toBe(true);
    expect(await page.evaluate(() => document.cookie.includes("nw_refresh="))).toBe(false);
  } finally { await stack.close(); }
});
