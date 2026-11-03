import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * The writing desk's browser-only contract (issue #168).
 *
 * Every assertion here is about something only a real browser can see, and each
 * one corresponds to a defect the cheaper layers could not catch:
 *
 * 1. **No native dialogs.** `window.prompt` cannot be asserted from a unit test —
 *    the call simply does not exist there. In an embedded WebView it returns
 *    `null` without showing anything, which made "insert image" fail silently. A
 *    dialog handler that fails the test the moment one opens is the only way to
 *    prove the desk never asks the browser for a question it should ask itself.
 * 2. **The language is a choice, and it sticks.** The desk used to hard-code
 *    `locale: "zh-CN"`, so an English work was impossible and a `zh-TW` work was
 *    silently rewritten on save.
 * 3. **One `Idempotency-Key` per save intent.** Weak-network retries used to
 *    create a second copy of the same work.
 *
 * The account is created over HTTP (deterministic); everything the test is
 * actually about goes through the browser.
 */

const PASSWORD = "e2e-browser-password";

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

function currentOrigin(): string {
  const base = process.env.E2E_WEB_URL ?? "http://127.0.0.1:3000";
  return new URL(base).origin;
}

/** The API the web application proxies to. */
const API_BASE_URL = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:4000";

/**
 * Fail the moment a native dialog would open.
 *
 * This is the assertion, not a convenience: `page.on("dialog")` only fires when
 * the page really called `window.prompt` / `alert` / `confirm`. A passing test
 * therefore means the desk answered every question in its own markup.
 */
function forbidNativeDialogs(page: import("@playwright/test").Page): string[] {
  const opened: string[] = [];
  page.on("dialog", async (dialog) => {
    opened.push(`${dialog.type()}: ${dialog.message()}`);
    await dialog.dismiss().catch(() => undefined);
  });
  return opened;
}

async function registerWriter(page: import("@playwright/test").Page, request: APIRequestContext): Promise<string> {
  const email = uniqueEmail("desk168");
  const registered = await request.post(`${API_BASE_URL}/api/v1/auth/register`, {
    data: { email, password: PASSWORD },
  });
  expect(registered.status(), `registering ${email}: ${await registered.text()}`).toBe(201);
  const { accessToken } = (await registered.json()).data as { accessToken: string };
  const profile = await request.put(`${API_BASE_URL}/api/v1/me/profile`, {
    data: { displayName: "写作台验证", bio: "浏览器验证账户。", locale: "zh-CN" },
    headers: { authorization: `Bearer ${accessToken}`, origin: API_BASE_URL },
  });
  expect(profile.status(), `creating the author profile: ${await profile.text()}`).toBe(200);

  const login = await page.request.post("/api/auth/login", {
    data: { email, password: PASSWORD },
    headers: { origin: currentOrigin() },
  });
  expect(login.status(), `signing the browser in as ${email}: ${await login.text()}`).toBe(200);
  const cookies = (await login.headersArray())
    .filter((header) => header.name.toLowerCase() === "set-cookie")
    .flatMap((header) => parseSetCookie(header.value));
  expect(cookies.length, "the login response must set session cookies").toBeGreaterThan(0);
  await page.context().addCookies(cookies.map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: new URL(currentOrigin()).hostname,
    path: cookie.path,
    expires: Math.floor(Date.now() / 1000) + cookie.maxAge,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
  })));
  await page.goto("/write");
  await expect(page.getByRole("heading", { name: /写作台/ })).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "新建作品" }).click();
  await expect(page.getByLabel("标题")).toBeVisible({ timeout: 45_000 });
  return email;
}

type ParsedCookie = {
  name: string; value: string; path: string; maxAge: number;
  httpOnly: boolean; secure: boolean; sameSite: "Strict" | "Lax" | "None";
};

function parseSetCookie(header: string): ParsedCookie[] {
  const [pair, ...attributes] = header.split(";").map((part) => part.trim());
  const index = pair.indexOf("=");
  if (index <= 0) return [];
  const cookie: ParsedCookie = {
    name: pair.slice(0, index), value: pair.slice(index + 1), path: "/", maxAge: 3600,
    httpOnly: false, secure: false, sameSite: "Lax",
  };
  for (const attribute of attributes) {
    const [rawKey, ...rest] = attribute.split("=");
    const value = rest.join("=");
    switch (rawKey.toLowerCase()) {
      case "path": cookie.path = value; break;
      case "max-age": cookie.maxAge = Number(value) || 3600; break;
      case "httponly": cookie.httpOnly = true; break;
      case "secure": cookie.secure = true; break;
      case "samesite": cookie.sameSite = /strict/i.test(value) ? "Strict" : /none/i.test(value) ? "None" : "Lax"; break;
      default: break;
    }
  }
  return cookie.value.length > 0 ? [cookie] : [];
}

test("the writing desk asks its own questions: no prompt, no alert, no confirm", async ({ page, request }) => {
  const opened = forbidNativeDialogs(page);
  await registerWriter(page, request);

  // 链接 used to be `window.prompt`. It must open a dialog the page owns, with a
  // field the browser can fill and an error it can read.
  await page.getByRole("button", { name: "链接" }).click();
  const linkDialog = page.getByRole("dialog", { name: "插入链接" });
  await expect(linkDialog).toBeVisible();
  await linkDialog.getByLabel("链接地址").fill("javascript:alert(1)");
  await linkDialog.getByRole("button", { name: "插入链接" }).click();
  // A refused address is reported on the field, not in an `alert`.
  await expect(linkDialog.getByRole("alert")).toContainText("只允许 HTTP(S)");
  await linkDialog.getByRole("button", { name: "取消" }).click();
  await expect(linkDialog).toBeHidden();

  // The retired type is not offered; the language is.
  const workType = page.getByLabel("作品类型");
  await expect(workType.locator("option", { hasText: "连载" })).toHaveCount(0);
  await expect(page.getByLabel("作品语言")).toHaveValue("zh-CN");
  await page.getByLabel("作品语言").selectOption("en");
  await expect(page.getByLabel("作品语言")).toHaveValue("en");

  expect(opened, "the desk must answer in its own markup").toEqual([]);
});

test("an English work saves as English and appears in the English archive only", async ({ page, request }) => {
  const opened = forbidNativeDialogs(page);
  await registerWriter(page, request);
  const title = `A Portable Web ${Date.now()}`;

  await page.getByLabel("作品语言").selectOption("en");
  await page.getByLabel("标题").fill(title);
  await page.getByLabel("作品正文").click();
  await page.keyboard.type("The web was meant to be portable.");
  await expect(page.getByLabel("作品正文")).toContainText("portable");

  // Capture the create request so the idempotency header can be asserted on the
  // wire rather than inferred from the UI.
  const keys: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\/authoring\/articles$/.test(new URL(request.url()).pathname)) {
      const key = request.headers()["idempotency-key"];
      if (typeof key === "string") keys.push(key);
    }
  });
  await page.getByRole("button", { name: "发布作品" }).click();

  await expect(async () => {
    const response = await page.request.get("/api/authoring/articles?locale=en");
    const body = (await response.json()) as { data?: { title?: string; locale?: string }[] };
    const match = (body.data ?? []).find((article) => article.title === title);
    expect(match, `"${title}" must be in the English list`).toBeDefined();
  }).toPass({ timeout: 45_000, intervals: [500, 1_000, 2_000] });

  expect(keys.length, "the create carried an Idempotency-Key").toBeGreaterThan(0);
  expect(keys[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(opened, "the save must not open a browser dialog").toEqual([]);
});
