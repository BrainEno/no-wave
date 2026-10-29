import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Authoring journey, end to end in a real browser.
 *
 * Why this exists: the save button was broken for most real documents while
 * every cheaper layer was green — the unit tests, the API contract tests, the
 * types. The failure lived between the Lexical editor, the REST body and the
 * adapter, and only a browser that types into the editor and clicks 保存草稿
 * can see it. These are the assertions that would have caught it.
 *
 * Rules of the layer (see docs/testing/end-to-end.md):
 * - selectors follow the accessibility tree, never CSS;
 * - every test creates its own account, so nothing depends on another test;
 * - account setup goes through HTTP (deterministic), the browser does every
 *   interaction the assertions are actually about.
 */

const PASSWORD = "e2e-browser-password";
/** The API the Web proxy talks to; the dev stack binds it to localhost. */
const API_BASE_URL = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:4000";
/** Where the suite drives the browser; playwright.config.ts sets baseURL from it. */
const WEB_ORIGIN = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

/**
 * A compact snapshot of what the page actually rendered.
 *
 * CI logs are the only place a browser failure can be read, and a bare
 * "locator not found" says nothing about a page that failed to hydrate. The
 * digest is attached to assertion messages so it lands in the failure output.
 */
async function pageDigest(page: Page): Promise<string> {
  try {
    return (await page.locator("body").ariaSnapshot()).slice(0, 1200);
  } catch {
    return (await page.content()).slice(0, 1200);
  }
}

/**
 * Create an account with a profile and hand the browser its session.
 *
 * The profile is not decoration: the public reader drops articles whose author
 * has none, so a published work would be unreachable without it.
 */
type SessionCookie = { name: string; value: string; path: string; maxAge: number; httpOnly: boolean; secure: boolean; sameSite: "Lax" | "Strict" | "None" };

/**
 * Read the session cookies out of a login response.
 *
 * They are written into the browser context explicitly rather than relying on
 * the API client sharing its cookie jar with the page: the suite is about the
 * browser, and it should not depend on that sharing being true.
 */
function sessionCookies(headers: { name: string; value: string }[]): SessionCookie[] {
  const cookies: SessionCookie[] = [];
  for (const header of headers) {
    if (header.name.toLowerCase() !== "set-cookie") continue;
    const parts = header.value.split(";").map((part) => part.trim()).filter((part) => part.length > 0);
    const [pair, ...attributes] = parts;
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const cookie: SessionCookie = {
      name: pair.slice(0, separator).trim(),
      value: pair.slice(separator + 1).trim(),
      path: "/",
      maxAge: 3600,
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    };
    for (const attribute of attributes) {
      const [key, value = ""] = attribute.split("=");
      switch (key.trim().toLowerCase()) {
        case "path": cookie.path = value.trim(); break;
        case "max-age": cookie.maxAge = Number.parseInt(value.trim(), 10) || cookie.maxAge; break;
        case "httponly": cookie.httpOnly = true; break;
        case "secure": cookie.secure = true; break;
        case "samesite": {
          const sameSite = value.trim().toLowerCase();
          if (sameSite === "strict") cookie.sameSite = "Strict";
          else if (sameSite === "none") cookie.sameSite = "None";
          else cookie.sameSite = "Lax";
          break;
        }
        default: break;
      }
    }
    if (cookie.value.length > 0) cookies.push(cookie);
  }
  return cookies;
}

/**
 * Create an account with a profile and hand the browser its session.
 *
 * The profile is not decoration: the public reader drops articles whose author
 * has none, so a published work would be unreachable without it.
 */
async function registerWriter(page: Page, request: APIRequestContext): Promise<string> {
  const email = uniqueEmail("writer");
  const registered = await request.post(`${API_BASE_URL}/api/v1/auth/register`, {
    data: { email, password: PASSWORD },
  });
  expect(registered.status(), `registering ${email}: ${await registered.text()}`).toBe(201);
  const { accessToken } = (await registered.json()).data as { accessToken: string };

  const profile = await request.put(`${API_BASE_URL}/api/v1/me/profile`, {
    data: { displayName: "无浪作者", bio: "浏览器验证账户。", locale: "zh-CN" },
    headers: { authorization: `Bearer ${accessToken}`, origin: API_BASE_URL },
  });
  expect(profile.status(), `creating the author profile: ${await profile.text()}`).toBe(200);

  // Sign in through the same-origin proxy the application uses. The proxy
  // rejects mutations without an exact same-origin Origin header, which a
  // plain HTTP client does not send.
  const login = await page.request.post("/api/auth/login", {
    data: { email, password: PASSWORD },
    headers: { origin: WEB_ORIGIN },
  });
  expect(login.status(), `signing the browser in: ${await login.text()}`).toBe(200);
  const cookies = sessionCookies(await login.headersArray());
  expect(cookies.length, `the login response must set session cookies; headers: ${JSON.stringify(await login.headersArray())}`).toBeGreaterThan(0);
  await page.context().addCookies(cookies.map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    url: WEB_ORIGIN,
    path: cookie.path,
    expires: Math.floor(Date.now() / 1000) + cookie.maxAge,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
  })));

  await page.goto("/write");
  try {
    await expect(page.getByRole("heading", { name: /写作台/ })).toBeVisible({ timeout: 45_000 });
  } catch (caught) {
    const sessionStatus = await page.evaluate(async () => {
      const response = await fetch("/api/authoring/session", { credentials: "same-origin", cache: "no-store" });
      return response.status;
    }).catch((error: unknown) => `evaluate failed: ${String(error)}`);
    throw new Error(
      `/write did not open the authoring desk (session probe: ${String(sessionStatus)}); page:\n${await pageDigest(page)}\n${String(caught)}`,
    );
  }
  return email;
}

/** Wait until the Lexical editor has hydrated: its toolbar exists client-side only. */
async function waitForEditor(page: Page): Promise<void> {
  await expect(page.getByLabel("标题")).toBeVisible();
  await expect(page.getByRole("toolbar", { name: "富文本格式" })).toBeVisible({ timeout: 45_000 });
}

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== "failed" && testInfo.status !== "timedOut") return;
  console.log(`FAILED ${testInfo.title} at ${page.url()}\n${await pageDigest(page)}`);
});

const TITLE_PREFIX = "无浪是一只没有波浪的文学站点，第一段用来验证保存链路。";
const SECOND_PARAGRAPH = "第二段用来验证摘要会取正文开头，而不是把整篇文章塞进去。";

/** Write a title and two paragraphs, save, and return the generated address. */
async function writeAndSave(page: Page, title: string, publish: boolean): Promise<string> {
  await waitForEditor(page);
  await page.getByLabel("标题").fill(title);
  await page.getByLabel("作品正文").click();
  await page.keyboard.type(TITLE_PREFIX);
  await page.keyboard.press("Enter");
  await page.keyboard.type(SECOND_PARAGRAPH);
  // The text has to reach the editor state, not just the DOM, before saving.
  await expect(page.getByLabel("作品正文")).toContainText("第一段用来验证保存链路。");

  await page.getByRole("button", { name: publish ? "发布作品" : "保存草稿" }).click();
  const status = page.getByRole("status");
  await expect(status).toContainText(publish ? "作品已发布。" : "草稿已保存。", { timeout: 45_000 });
  await expect(status).toContainText("作品地址：/articles/");
  const message = (await status.textContent()) ?? "";
  const slug = (message.split("/articles/")[1] ?? "").trim();
  expect(slug, `the editor must report a generated address; status was "${message}"`)
    .toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  return slug;
}

test("the sign-in form registers an account and opens the authoring desk", async ({ page }) => {
  const email = uniqueEmail("signup");
  await page.goto("/sign-in?next=%2Fwrite");

  // A click that lands before React hydrates is silently dropped, so the mode
  // switch is retried until its effect shows up.
  try {
    await expect(async () => {
      await page.getByRole("button", { name: /没有账户？创建账户|已有账户？登录/ }).click();
      await expect(page.getByRole("button", { name: "创建账户并继续" })).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 45_000 });
  } catch (caught) {
    throw new Error(`the sign-in form never switched to register mode; page:\n${await pageDigest(page)}\n${String(caught)}`);
  }

  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill(PASSWORD);
  await page.getByRole("button", { name: "创建账户并继续" }).click();
  await page.waitForURL("**/write", { timeout: 45_000 });
  await expect(page.getByRole("heading", { name: /写作台/ })).toBeVisible({ timeout: 45_000 });
});

test("saving a draft creates the article, generates its address, and survives a reload", async ({ page, request }) => {
  await registerWriter(page, request);
  const title = `浏览器验证草稿 ${Date.now().toString(36)}`;
  const slug = await writeAndSave(page, title, false);

  // A reload re-reads the author's article list from the API: the draft is real.
  await page.reload();
  await expect(page.getByRole("button", { name: new RegExp(title) })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole("status")).toContainText(`/articles/${slug}`);
});

test("publishing an article makes it readable at its generated address with a generated summary", async ({ page, request }) => {
  await registerWriter(page, request);
  const title = `浏览器验证发布 ${Date.now().toString(36)}`;
  const slug = await writeAndSave(page, title, true);

  await page.goto(`/articles/${slug}`);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText("第一段用来验证保存链路。")).toBeVisible();

  // The summary was left blank in the editor, so the API derived it from the
  // body: the page description must be the beginning of the prose, not empty.
  const description = (await page.locator('meta[name="description"]').getAttribute("content")) ?? "";
  expect(description, `generated summary for /articles/${slug}; page:\n${await pageDigest(page)}`).not.toHaveLength(0);
  expect(description.startsWith("无浪是一只没有波浪的文学站点")).toBe(true);
  expect(description.length).toBeLessThanOrEqual(111);
});

test("an article with no body is refused with a readable message instead of a silent failure", async ({ page, request }) => {
  await registerWriter(page, request);
  await waitForEditor(page);
  await page.getByLabel("标题").fill(`浏览器验证空正文 ${Date.now().toString(36)}`);
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("alert")).toContainText("请先输入正文内容。");
});
