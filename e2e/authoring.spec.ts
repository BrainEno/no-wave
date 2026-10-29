import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Authoring journey, end to end in a real browser.
 *
 * Why this exists: the save button was broken for most real documents while
 * every cheaper layer was green — the unit tests, the API contract tests, the
 * types. The failure lived between the Lexical editor, the REST body and the
 * adapter, and only a browser that types into the editor and clicks 保存草稿
 * can see it. These are the assertions that would have caught it, and the ones
 * that caught the follow-up bug below.
 *
 * Rules of the layer (see docs/testing/end-to-end.md):
 * - selectors follow the accessibility tree, never CSS;
 * - every test creates its own account, so nothing depends on another test;
 * - account setup goes through HTTP (deterministic), the browser does every
 *   interaction the assertions are actually about;
 * - assertions wait on durable outcomes (the article list, the public page,
 *   the sidebar), so a flaky transient state cannot turn them green or red.
 */

const PASSWORD = "e2e-browser-password";
/** The API the Web proxy talks to; the dev stack binds it to localhost. */
const API_BASE_URL = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:4000";
/** Where the suite drives the browser; playwright.config.ts sets baseURL from it. */
const WEB_ORIGIN = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";

type SavedArticle = { id: string; slug: string; title: string; status: "draft" | "published" };

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

/**
 * A compact snapshot of what the page actually rendered.
 *
 * CI logs are the only place a browser failure can be read, and a bare
 * "locator not found" says nothing about a page that rendered something else.
 * The digest is attached to assertion messages so it lands in the failure text.
 */
async function pageDigest(page: Page): Promise<string> {
  try {
    return (await page.locator("body").ariaSnapshot()).slice(0, 1200);
  } catch {
    return (await page.content()).slice(0, 1200);
  }
}

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
  // `domain` + `path` (not `url`): Playwright derives the path from a url's
  // directory, and the access cookie is deliberately scoped to /api/authoring
  // so it is never sent to page routes.
  await page.context().addCookies(cookies.map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: new URL(WEB_ORIGIN).hostname,
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
    // Distinguish "no session", "an API call hangs" and "client JS never ran":
    // all three leave the page on its server-rendered loading state.
    const probe = await page.evaluate(async () => {
      const status = async (path: string): Promise<number> => {
        const response = await fetch(path, { credentials: "same-origin", cache: "no-store" });
        return response.status;
      };
      return {
        session: await status("/api/authoring/session"),
        articles: await status("/api/authoring/articles"),
        hydrated: typeof (window as unknown as { next?: unknown }).next === "object",
        scripts: document.scripts.length,
      };
    }).catch((error: unknown) => `probe failed: ${String(error)}`);
    throw new Error(
      `/write did not open the authoring desk (probe: ${JSON.stringify(probe)}); page:\n${await pageDigest(page)}\n${String(caught)}`,
    );
  }
  return email;
}

/** Wait until the Lexical editor has hydrated: its toolbar exists client-side only. */
async function waitForEditor(page: Page): Promise<void> {
  await expect(page.getByLabel("标题")).toBeVisible();
  await expect(page.getByRole("toolbar", { name: "富文本格式" })).toBeVisible({ timeout: 45_000 });
}

async function savedArticles(page: Page): Promise<SavedArticle[]> {
  const response = await page.request.get("/api/authoring/articles");
  expect(response.status(), "reading the author's article list").toBe(200);
  const body = (await response.json()) as { data: SavedArticle[] };
  return Array.isArray(body.data) ? body.data : [];
}

const FIRST_PARAGRAPH = "无浪是一只没有波浪的文学站点，第一段用来验证保存链路。";
const SECOND_PARAGRAPH = "第二段用来验证摘要会取正文开头，而不是把整篇文章塞进去。";

/** Write a title and two paragraphs, then save; returns the generated address. */
async function writeAndSave(page: Page, title: string, publish: boolean): Promise<string> {
  await waitForEditor(page);
  await page.getByLabel("标题").fill(title);
  await page.getByLabel("作品正文").click();
  await page.keyboard.type(FIRST_PARAGRAPH);
  await page.keyboard.press("Enter");
  await page.keyboard.type(SECOND_PARAGRAPH);
  // The text has to reach the editor state, not just the DOM, before saving.
  await expect(page.getByLabel("作品正文")).toContainText("第一段用来验证保存链路。");

  await page.getByRole("button", { name: publish ? "发布作品" : "保存草稿" }).click();
  return await savedSlug(page, title, publish ? "published" : "draft");
}

/**
 * Wait for the article to exist with the expected status and return its slug.
 *
 * Polled rather than read once: the workspace saves asynchronously, and the
 * slug is the durable outcome the rest of the assertions need.
 */
async function savedSlug(page: Page, title: string, status: SavedArticle["status"]): Promise<string> {
  let articles: SavedArticle[] = [];
  try {
    await expect(async () => {
      articles = await savedArticles(page);
      const match = articles.find((article) => article.title === title);
      expect(match, `no article titled "${title}" in ${JSON.stringify(articles.map((article) => [article.title, article.status]))}`).toBeDefined();
      expect(match?.status).toBe(status);
    }).toPass({ timeout: 45_000, intervals: [500, 1_000, 2_000] });
  } catch (caught) {
    throw new Error(`the save did not produce a ${status} article; page:\n${await pageDigest(page)}\n${String(caught)}`);
  }
  const slug = articles.find((article) => article.title === title)?.slug ?? "";
  expect(slug, `a generated slug for "${title}": ${JSON.stringify(articles.map((article) => article.slug))}`)
    .toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  return slug;
}

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== "failed" && testInfo.status !== "timedOut") return;
  console.log(`FAILED ${testInfo.title} at ${page.url()}\n${await pageDigest(page)}`);
});

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

test("saving a draft creates the article with a generated address, and it survives a reload", async ({ page, request }) => {
  await registerWriter(page, request);
  const title = `浏览器验证草稿 ${Date.now().toString(36)}`;
  const slug = await writeAndSave(page, title, false);
  expect(slug.length).toBeGreaterThan(0);

  // The success line, with the generated address, has to stay on screen: it is
  // the only place that tells the author where the work lives. It used to be
  // discarded by the remount that followed the save.
  const status = page.getByRole("status").filter({ hasText: "作品地址：" });
  await expect(status).toContainText("草稿已保存。", { timeout: 45_000 });
  await expect(status).toContainText(`作品地址：/articles/${slug}`);

  // Saving again updates that article instead of creating a second one, and it
  // is published from the same document without retyping anything.
  await expect(page.getByRole("button", { name: "发布作品" })).toBeVisible();
  await page.getByRole("button", { name: "发布作品" }).click();
  try {
    await expect(status).toContainText("作品已发布。", { timeout: 45_000 });
  } catch (caught) {
    // The client refuses a save before it sends anything, so what the page
    // says now is the only way to tell a refused save from a failed request.
    const alerts = await page.locator("[role=alert]").allTextContents();
    const editorText = ((await page.getByLabel("作品正文").textContent()) ?? "").slice(0, 120);
    const titleValue = await page.getByLabel("标题").inputValue();
    throw new Error(
      `publishing the saved draft did not report success; alerts=${JSON.stringify(alerts)} editor=${JSON.stringify(editorText)} title=${JSON.stringify(titleValue)}\n${await pageDigest(page)}\n${String(caught)}`,
    );
  }
  await expect(async () => {
    const saved = await savedArticles(page);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.status).toBe("published");
  }).toPass({ timeout: 45_000, intervals: [500, 1_000, 2_000] });

  // The sidebar is the durable UI signal; a reload re-reads it from the API.
  await page.reload();
  const entry = page.getByRole("button", { name: new RegExp(title) });
  await expect(entry).toBeVisible({ timeout: 45_000 });
  await expect(entry).toContainText("已发布");
});

test("publishing an article makes it readable at its generated address with a generated summary", async ({ page, request }) => {
  await registerWriter(page, request);
  const title = `浏览器验证发布 ${Date.now().toString(36)}`;
  const slug = await writeAndSave(page, title, true);

  await page.goto(`/articles/${slug}`);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible({ timeout: 45_000 });
  // Exact: the summary is rendered as a standfirst paragraph that starts with
  // the same sentence, so a substring match would be ambiguous.
  await expect(page.getByText(FIRST_PARAGRAPH, { exact: true })).toBeVisible();

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
  try {
    // Filtered by text: Next keeps an empty route announcer in the tree that
    // also carries role=alert.
    await expect(page.getByRole("alert").filter({ hasText: "正文内容" })).toBeVisible({ timeout: 30_000 });
  } catch (caught) {
    throw new Error(`the editor did not refuse an empty body; page:\n${await pageDigest(page)}\n${String(caught)}`);
  }
  expect(await savedArticles(page)).toHaveLength(0);
});
