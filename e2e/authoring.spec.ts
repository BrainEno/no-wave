import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { test } from "./support/csp-fixture.ts";

/**
 * Authoring journey, end to end in a real browser — twice.
 *
 * Why this exists: the save button was broken for most real documents while
 * every cheaper layer was green — the unit tests, the API contract tests, the
 * types. The failure lived between the Lexical editor, the REST body and the
 * adapter, and only a browser that types into the editor and clicks 保存草稿
 * can see it. These are the assertions that would have caught it, and the ones
 * that caught the follow-up bug below.
 *
 * The file runs once per framework (see playwright.config.ts): the App Router
 * and the React Router prototype, both against the **same** API and the same
 * database. That is the claim the migration needs — "an author can sign up,
 * write and publish here" — and running one spec against both is the only way to
 * make it a measurement instead of two separate assertions nobody compared. So
 * nothing in this file may hard-code which framework it is talking to: the
 * origin comes from the project's `baseURL`, and every route below is one both
 * frameworks serve.
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
/** The API both frameworks proxy to; every project shares one database. */
const API_BASE_URL = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:4000";

/**
 * The origin the current project is driving.
 *
 * Read from the project rather than from the environment: the two projects differ
 * only in `baseURL`, and the login proxy rejects a mutation whose `Origin` is not
 * exactly its own — so the header has to follow the project, not a constant.
 */
function currentOrigin(): string {
  const baseURL = test.info().project.use.baseURL;
  if (!baseURL) throw new Error("every browser project must define a baseURL");
  return new URL(baseURL).origin;
}

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
 * Hand the browser the session of an account that already exists.
 *
 * `registerWriter` uses this for the account it has just created; the
 * notification journey uses it a second time to change who the browser is,
 * because the reader who is told about a deletion is not the author who made it.
 */
async function signIn(page: Page, email: string): Promise<void> {
  // Through the same-origin proxy the application uses. The proxy rejects
  // mutations without an exact same-origin Origin header, which a plain HTTP
  // client does not send.
  const origin = currentOrigin();
  const login = await page.request.post("/api/auth/login", {
    data: { email, password: PASSWORD },
    headers: { origin },
  });
  expect(login.status(), `signing the browser in as ${email}: ${await login.text()}`).toBe(200);
  const cookies = sessionCookies(await login.headersArray());
  expect(cookies.length, `the login response must set session cookies; headers: ${JSON.stringify(await login.headersArray())}`).toBeGreaterThan(0);
  // `domain` + `path` (not `url`): Playwright derives the path from a url's
  // directory, and the access cookie is deliberately scoped to /api/authoring
  // so it is never sent to page routes.
  await page.context().addCookies(cookies.map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: new URL(origin).hostname,
    path: cookie.path,
    expires: Math.floor(Date.now() / 1000) + cookie.maxAge,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
  })));
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

  await signIn(page, email);
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

/**
 * Everything the page sent to and received from the authoring API.
 *
 * Printed for a failing test. "The click did nothing", "the click hit another
 * button" and "the request was rejected" look identical from the outside, and
 * only the traffic tells them apart.
 */
let traffic: string[] = [];
/** Console output and uncaught exceptions: a handler that throws looks like a
 *  click that did nothing, and the page error is the only trace it leaves. */
let consoleLog: string[] = [];

test.beforeEach(async ({ page }) => {
  traffic = [];
  consoleLog = [];
  const record = (line: string): void => { if (traffic.length < 40) traffic.push(line); };
  const recordConsole = (line: string): void => { if (consoleLog.length < 40) consoleLog.push(line); };
  page.on("console", (message) => recordConsole(`${message.type()}: ${message.text().slice(0, 300)}`));
  page.on("pageerror", (error) => recordConsole(`pageerror: ${String(error).slice(0, 300)}`));
  const watched = (url: string): boolean => /\/api\/(authoring|auth)/.test(url);
  page.on("request", (request) => {
    if (!watched(request.url())) return;
    record(`-> ${request.method()} ${new URL(request.url()).pathname} ${(request.postData() ?? "").slice(0, 200)}`);
  });
  page.on("response", (response) => {
    if (!watched(response.url())) return;
    record(`<- ${response.status()} ${new URL(response.url()).pathname}`);
  });
  page.on("requestfailed", (request) => {
    if (!watched(request.url())) return;
    record(`!! ${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`);
  });
});

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== "failed" && testInfo.status !== "timedOut") return;
  console.log(`FAILED ${testInfo.title} at ${page.url()}\ntraffic:\n${traffic.join("\n")}\nconsole:\n${consoleLog.join("\n")}\n${await pageDigest(page)}`);
});

/**
 * Answer one of the desk's own confirmations (#F-12).
 *
 * These used to be `window.confirm`, so the suite could answer them with
 * `page.on("dialog")` and never look at the page. They are now a native
 * `<dialog>` the product owns: the name is the question, the buttons are the
 * answer, and a missing dialog is a visible failure instead of a silent delete.
 */
async function answerDeskDialog(page: Page, name: string | RegExp, answer: string): Promise<void> {
  const dialog = page.getByRole("dialog", { name });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: answer }).click();
  await expect(dialog).not.toBeVisible();
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

test("registration creates a default pen name and the writing desk can change it", async ({ page, request }) => {
  const email = uniqueEmail("penname");
  const registered = await request.post(`${API_BASE_URL}/api/v1/auth/register`, {
    data: { email, password: PASSWORD },
  });
  expect(registered.status(), `registering ${email}: ${await registered.text()}`).toBe(201);
  const { accessToken } = (await registered.json()).data as { accessToken: string };

  // No profile PUT: the default byline is part of the registration transaction.
  const profile = await request.get(`${API_BASE_URL}/api/v1/me/profile?locale=zh-CN`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  expect(profile.status(), `reading the default profile: ${await profile.text()}`).toBe(200);
  expect((await profile.json()).data.displayName).toBe("无浪作者");

  await signIn(page, email);
  await page.goto("/write");
  await expect(page.locator("[data-author-profile]")).toBeVisible({ timeout: 45_000 });
  await expect(page.locator("[data-author-profile-name]")).toHaveText("无浪作者", { timeout: 45_000 });

  await page.getByLabel("笔名").fill("新笔名");
  await page.getByRole("button", { name: "保存笔名" }).click();
  await expect(page.locator("[data-author-profile-name]")).toHaveText("新笔名", { timeout: 45_000 });
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
  const publishButton = page.getByRole("button", { name: "发布作品" });
  await expect(publishButton).toBeVisible();
  const requestsBefore = traffic.length;
  await publishButton.click();
  // A button takes focus when it is really clicked; if the click landed
  // somewhere else, this says where it went instead.
  const focused = await page.evaluate(() => {
    const active = document.activeElement;
    return active ? `${active.tagName}.${active.className} ${(active.textContent ?? "").slice(0, 40)}` : "none";
  });
  try {
    await expect(status).toContainText("作品已发布。", { timeout: 45_000 });
  } catch (caught) {
    // The client refuses a save before it sends anything, so what the page
    // says now is the only way to tell a refused save from a failed request.
    const alerts = await page.locator("[role=alert]").allTextContents();
    const editorText = ((await page.getByLabel("作品正文").textContent()) ?? "").slice(0, 120);
    const titleValue = await page.getByLabel("标题").inputValue();
    throw new Error(
      `publishing the saved draft did not report success; focused=${JSON.stringify(focused)} requests=${requestsBefore}->${traffic.length} alerts=${JSON.stringify(alerts)}\ntraffic:\n${traffic.join("\n")}\nconsole:\n${consoleLog.join("\n")}\n${String(caught)}`,
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

test("returning a published work to draft withdraws it from the public site", async ({ page, request }) => {
  await registerWriter(page, request);
  const title = `浏览器验证撤稿 ${Date.now().toString(36)}`;
  const slug = await writeAndSave(page, title, true);

  const publicHeading = page.getByRole("heading", { level: 1, name: title });
  await page.goto(`/articles/${slug}`);
  await expect(publicHeading).toBeVisible({ timeout: 45_000 });

  // The desk opens on a new document, so the published work has to be opened
  // from the list before it can be withdrawn — the 转为草稿 action only exists
  // for a work that is currently public.
  await page.goto("/write");
  await waitForEditor(page);
  const entry = page.getByRole("button", { name: new RegExp(title) });
  await expect(entry).toBeVisible({ timeout: 45_000 });
  await entry.click();
  await waitForEditor(page);
  const withdraw = page.getByRole("button", { name: "转为草稿" });
  await expect(withdraw).toBeVisible({ timeout: 45_000 });
  await withdraw.click();
  // The desk asks before it withdraws a page that readers may be on. That
  // confirmation is the product's own dialog (#F-12), not a browser `confirm()`:
  // the suite answers it, so a dialog that never appears is a failure rather
  // than a no-op, and what the author is told is an assertion of its own.
  const withdrawDialog = page.getByRole("dialog", { name: "转为草稿？" });
  await expect(withdrawDialog).toContainText("将对读者不可访问");
  await expect(withdrawDialog).toContainText("内容会保留在写作台");
  await withdrawDialog.getByRole("button", { name: "确认转为草稿" }).click();

  await expect(async () => {
    const saved = await savedArticles(page);
    expect(saved.find((article) => article.title === title)?.status, JSON.stringify(saved)).toBe("draft");
  }).toPass({ timeout: 45_000, intervals: [500, 1_000, 2_000] });

  // The durable outcome readers can see: the address stops serving the work,
  // while the draft itself is untouched and still listed in the desk.
  await page.goto(`/articles/${slug}`);
  await expect(publicHeading, `the withdrawn work must not be readable at /articles/${slug}`).toHaveCount(0);
  await page.goto("/write");
  await expect(page.getByRole("button", { name: new RegExp(title) })).toContainText("草稿", { timeout: 45_000 });
});

test("deleting a work takes it out of the desk and off the site", async ({ page, request }) => {
  await registerWriter(page, request);
  const title = `浏览器验证删除 ${Date.now().toString(36)}`;
  const slug = await writeAndSave(page, title, true);

  const publicHeading = page.getByRole("heading", { level: 1, name: title });
  await page.goto(`/articles/${slug}`);
  await expect(publicHeading).toBeVisible({ timeout: 45_000 });

  await page.goto("/write");
  await waitForEditor(page);
  const entry = page.getByRole("button", { name: new RegExp(title) });
  await expect(entry).toBeVisible({ timeout: 45_000 });
  await entry.click();
  await waitForEditor(page);
  await page.getByRole("button", { name: "删除作品", exact: true }).click();

  // What the confirmation says is part of the feature. It used to promise
  // \u201c删除后无法恢复\u201d; with a recycle bin behind the button that was the desk
  // lying about its own undo. It now names the way back and the one thing a
  // restore cannot give back to a third party — the comments under the work.
  const deleteDialog = page.getByRole("dialog", { name: /删除《.*》？/ });
  await expect(deleteDialog).toContainText("回收站");
  await expect(deleteDialog).toContainText("评论");
  await expect(deleteDialog).toContainText("所有语言版本");

  // Cancelling is a no-op. The old `window.confirm` answered "Cancel" with the
  // same `false` this dialog answers with, and a replacement whose escape hatch
  // deletes anyway would be worse than the blocking dialog it replaced.
  await deleteDialog.getByRole("button", { name: "取消" }).click();
  await expect(deleteDialog).not.toBeVisible();
  await page.goto(`/articles/${slug}`);
  await expect(publicHeading, "cancelling the confirmation must leave the work published").toBeVisible({ timeout: 45_000 });

  // The destructive answer has to be aimed at: back into the desk, open the
  // work again, and this time say yes.
  await page.goto("/write");
  await waitForEditor(page);
  await entry.click();
  await waitForEditor(page);
  await page.getByRole("button", { name: "删除作品", exact: true }).click();
  await answerDeskDialog(page, /删除《.*》？/, "确认删除");

  // The notice belongs to the desk, not to the editor: the editor is reset to a
  // new document, so a message that only the editor could show would vanish with
  // the work it is about.
  await expect(page.getByRole("status").filter({ hasText: "已删除" })).toContainText(title, { timeout: 45_000 });
  await expect(async () => {
    const saved = await savedArticles(page);
    expect(saved.find((article) => article.title === title), JSON.stringify(saved)).toBeUndefined();
  }).toPass({ timeout: 45_000, intervals: [500, 1_000, 2_000] });

  // The durable outcome a reader can see: the address stops serving the work.
  await page.goto(`/articles/${slug}`);
  await expect(publicHeading, `the deleted work must not be readable at /articles/${slug}`).toHaveCount(0);
});

test("a deleted work can be restored from the recycle bin, as a draft", async ({ page, request }) => {
  await registerWriter(page, request);
  const title = `浏览器验证还原 ${Date.now().toString(36)}`;
  const slug = await writeAndSave(page, title, true);

  await page.goto("/write");
  await waitForEditor(page);
  const entry = page.getByRole("button", { name: new RegExp(title) });
  await expect(entry).toBeVisible({ timeout: 45_000 });
  await entry.click();
  await waitForEditor(page);
  await page.getByRole("button", { name: "删除作品", exact: true }).click();
  await answerDeskDialog(page, /删除《.*》？/, "确认删除");
  await expect(page.getByRole("status").filter({ hasText: "已删除" })).toContainText(title, { timeout: 45_000 });

  // The deletion is not the end of the story: the work is in the recycle bin,
  // with a deadline the author can read, and it can be brought back.
  const trash = page.getByRole("region", { name: "回收站" });
  const row = trash.getByRole("button", { name: new RegExp(`还原《${title}》`) });
  await expect(row).toBeVisible({ timeout: 45_000 });
  await expect(trash).toContainText(/将在 \d+ 天后自动清除|即将自动清除/);

  await row.click();
  await expect(page.getByRole("status").filter({ hasText: "已还原" })).toContainText(title, { timeout: 45_000 });

  // Back in the desk, as a draft, with its body intact: a restore is an undo,
  // not a fresh document.
  await expect(async () => {
    const saved = await savedArticles(page);
    expect(saved.find((article) => article.title === title)?.status, JSON.stringify(saved)).toBe("draft");
  }).toPass({ timeout: 45_000, intervals: [500, 1_000, 2_000] });
  await page.getByRole("button", { name: new RegExp(title) }).click();
  await waitForEditor(page);
  await expect(page.getByLabel("作品正文")).toContainText("第一段用来验证保存链路。", { timeout: 45_000 });

  // Restoring must not republish: the address stays dark until the author says
  // otherwise, which is the whole difference between a restore and an archive.
  await page.goto(`/articles/${slug}`);
  await expect(
    page.getByRole("heading", { level: 1, name: title }),
    `a restored draft must not be readable at /articles/${slug}`,
  ).toHaveCount(0);
});

/**
 * The deletion closes its loop on the other side.
 *
 * Everything before this test was about the author: the work, the trash, the
 * undo. The other half of a deletion is somebody else's — the sweep takes the
 * comments under the work with it, and those are other people's words. The API
 * writes each commenter a notice; this is the assertion that a reader can
 * actually read it, in a browser, in both frameworks.
 */
test("a reader who commented on a deleted work is told so in their own desk", async ({ page, request }) => {
  // Two accounts, one browser: the author who deletes, and the reader whose
  // comment goes with the work.
  await registerWriter(page, request);
  const title = `浏览器验证通知 ${Date.now().toString(36)}`;
  const slug = await writeAndSave(page, title, true);

  const readerEmail = uniqueEmail("reader");
  const registered = await request.post(`${API_BASE_URL}/api/v1/auth/register`, {
    data: { email: readerEmail, password: PASSWORD },
  });
  expect(registered.status(), `registering ${readerEmail}: ${await registered.text()}`).toBe(201);
  const { accessToken } = (await registered.json()).data as { accessToken: string };

  // The reader's words, posted through the API because the journey is about the
  // inbox rather than the comment form: every click that is not what the test
  // asserts is a way for it to fail for the wrong reason.
  const comment = await request.post(`${API_BASE_URL}/api/v1/articles/${slug}/comments`, {
    data: { content: "这一段我想再读一遍。" },
    headers: { authorization: `Bearer ${accessToken}`, origin: API_BASE_URL },
  });
  expect(comment.status(), `commenting on ${slug}: ${await comment.text()}`).toBe(201);

  await page.goto("/write");
  await waitForEditor(page);
  const entry = page.getByRole("button", { name: new RegExp(title) });
  await expect(entry).toBeVisible({ timeout: 45_000 });
  await entry.click();
  await waitForEditor(page);
  await page.getByRole("button", { name: "删除作品", exact: true }).click();
  await answerDeskDialog(page, /删除《.*》？/, "确认删除");
  await expect(page.getByRole("status").filter({ hasText: "已删除" })).toContainText(title, { timeout: 45_000 });

  // The author receives the reader's comment, but not their own deletion notice.
  const authorInbox = page.getByRole("region", { name: "通知" });
  await expect(authorInbox).toContainText("有人评论了你的作品。", { timeout: 45_000 });
  await expect(authorInbox).not.toContainText("你评论过的一篇作品已被作者删除");

  // The same screen, the other account.
  await page.context().clearCookies();
  await signIn(page, readerEmail);
  await page.goto("/write");
  await waitForEditor(page);

  const inbox = page.getByRole("region", { name: "通知" });
  await expect(inbox, `the reader's desk must carry the notice:\n${await pageDigest(page)}`)
    .toContainText("1 未读", { timeout: 45_000 });
  await expect(inbox).toContainText(/你评论过的一篇作品已被作者删除/);
  // The date is the point of the notice: it is the difference between "this is
  // happening" and "this will happen, and here is when".
  await expect(inbox).toContainText(/你的评论会在 \d{4}-\d{2}-\d{2}/);

  // Marking it read is the reader's answer to it, and the badge follows: an
  // inbox that kept saying "1 未读" after being read would be the one part of
  // this screen a reader comes back to.
  // `exact`: the inbox's own "全部标为已读" also contains these characters.
  await inbox.getByRole("button", { name: "标记已读", exact: true }).click();
  await expect(
    inbox.getByRole("button", { name: "标记已读", exact: true }),
    `the notice must stop asking to be read:\n${await pageDigest(page)}`,
  ).toHaveCount(0, { timeout: 45_000 });
  await expect(inbox.getByRole("heading", { name: "通知", exact: true })).toBeVisible();
  await expect(inbox).toContainText("已载入 1 条，其中 0 条未读；全收件箱 0 条未读。");
  await expect(inbox.getByRole("button", { name: "全部标为已读", exact: true })).toHaveCount(0);
  await expect(page.locator(".nw-bdg")).toHaveCount(0);
  // Read, not erased: the notice stays until the API's own retention takes it.
  await expect(inbox).toContainText(/你评论过的一篇作品已被作者删除/);
});

test("text committed by an IME reaches the editor state and is saved", async ({ page, request }) => {
  await registerWriter(page, request);
  await waitForEditor(page);
  const title = `浏览器验证输入法 ${Date.now().toString(36)}`;
  await page.getByLabel("标题").fill(title);
  await page.getByLabel("作品正文").click();
  // An IME commits a candidate with an `input` event and no keydown/keyup pair
  // for the characters it produced. `insertText` is exactly that shape, so a
  // composition bug that only shows up with a Chinese IME is reachable from CI
  // instead of only from a desktop with an IME installed.
  await page.keyboard.insertText(FIRST_PARAGRAPH);
  await expect(page.getByLabel("作品正文")).toContainText("第一段用来验证保存链路。");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await savedSlug(page, title, "draft");

  // It has to survive the round trip, not just the screen: reopening the work
  // rebuilds the editor from the blocks the API stored.
  await page.reload();
  await waitForEditor(page);
  await page.getByRole("button", { name: new RegExp(title) }).click();
  await expect(page.getByLabel("作品正文")).toContainText("第一段用来验证保存链路。", { timeout: 45_000 });
});

test("formatting applied without a mouse survives the save round trip", async ({ page, request }) => {
  await registerWriter(page, request);
  await waitForEditor(page);
  const title = `浏览器验证键盘 ${Date.now().toString(36)}`;
  await page.getByLabel("标题").fill(title);
  await page.getByLabel("作品正文").click();
  await page.keyboard.type(FIRST_PARAGRAPH);
  await expect(page.getByLabel("作品正文")).toContainText("第一段用来验证保存链路。");

  // Keyboard only: select the paragraph, then bold it with the editor's own
  // shortcut — no pointer. A toolbar that answers only the mouse is not
  // accessible, and this is the keyboard path the editor itself provides.
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Control+B");
  await expect(page.getByLabel("作品正文").locator("strong")).toContainText("第一段用来验证保存链路。", { timeout: 30_000 });

  // The article contract carries inline marks, so what the keyboard applied has
  // to come back when the work is reopened, not only stay on this screen.
  await page.getByRole("button", { name: "保存草稿" }).click();
  await savedSlug(page, title, "draft");
  await page.reload();
  await waitForEditor(page);
  await page.getByRole("button", { name: new RegExp(title) }).click();
  await expect(page.getByLabel("作品正文").locator("strong")).toContainText("第一段用来验证保存链路。", { timeout: 45_000 });
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

/**
 * Synthetic response for UI-only failure paths. The lost-response and replay
 * journeys below use the real API/database; modelling the other server answers
 * avoids exhausting the real 30 creates/IP/hour policy in one browser suite.
 */
function simulatedArticle(body: string | null, identity?: { id: string; slug: string }) {
  const input = JSON.parse(body ?? "{}") as { title?: string; summary?: string; locale?: string; workType?: string; publish?: boolean };
  return {
    id: identity?.id ?? crypto.randomUUID(), slug: identity?.slug ?? "simulated-work",
    title: input.title ?? "", summary: input.summary ?? "", locale: input.locale ?? "zh-CN",
    workType: input.workType ?? "other", status: input.publish ? "published" : "draft",
    contentBlocksVersion: 1, contentBlocks: [{ id: "p1", type: "paragraph", text: "simulated" }],
  };
}

// The first save is a create, not an update. A response lost after the commit
// must not turn the author's next click into another work.
test("first save retries one committed work, later saves update it, and another draft gets a new key", async ({ page, request }) => {
  await registerWriter(page, request);
  await waitForEditor(page);
  const attempts: { key: string | undefined; body: string | null }[] = [];
  const updates: (string | undefined)[] = [];
  let committedId = "";

  await page.route("**/api/authoring/articles", async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    attempts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
    if (attempts.length === 1) {
      const committed = await route.fetch();
      expect(committed.status()).toBe(201);
      committedId = (await committed.json()).data.id as string;
      await route.abort("failed");
    } else {
      await route.continue();
    }
  });
  await page.route("**/api/authoring/articles/*", async (route) => {
    if (route.request().method() === "PUT") updates.push(route.request().headers()["idempotency-key"]);
    await route.continue();
  });

  await page.getByLabel("标题").fill("一次保存，只有一篇");
  await page.getByLabel("作品正文").click();
  await page.keyboard.type("断线重试不应该产生第二篇作品。");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(committedId).toBeTruthy();
  expect(attempts).toHaveLength(1);
  expect(attempts[0].key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("status").filter({ hasText: "上次创建已确认" })).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect((await savedArticles(page)).map((article) => article.id)).toEqual([committedId]);

  await page.getByLabel("标题").fill("保存后的更新");
  const update = page.waitForResponse((response) => response.url().includes(`/api/authoring/articles/${committedId}`) && response.request().method() === "PUT");
  await page.getByRole("button", { name: "保存草稿" }).click();
  expect((await update).status()).toBe(200);
  expect(updates).toEqual([undefined]);
  expect((await savedArticles(page)).map((article) => article.id)).toEqual([committedId]);

  await page.getByRole("button", { name: "新建作品 +" }).click();
  await waitForEditor(page);
  await page.getByLabel("标题").fill("独立的新草稿");
  await page.getByLabel("作品正文").click();
  await page.keyboard.type("另一篇作品有另一把键。");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("status").filter({ hasText: "草稿已保存。" })).toBeVisible();
  expect(attempts).toHaveLength(3);
  expect(attempts[2].key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  expect(attempts[2].key).not.toBe(attempts[0].key);
  expect(await savedArticles(page)).toHaveLength(2);
});

test("an uncertain save keeps its original body, blocks document switches and preserves subsequent edits", async ({ page, request }) => {
  await registerWriter(page, request);
  await waitForEditor(page);
  const attempts: { key: string | undefined; body: string | null }[] = [];
  const updates: { key: string | undefined; body: string | null }[] = [];
  let committedId = "";
  let stored!: () => void;
  const committed = new Promise<void>((resolve) => { stored = resolve; });
  let release!: () => void;
  const responseGate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/authoring/articles", async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    attempts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
    if (attempts.length === 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      committedId = (await response.json()).data.id as string;
      stored();
      await responseGate;
      await route.abort("failed");
    } else {
      await route.continue();
    }
  });
  await page.route("**/api/authoring/articles/*", async (route) => {
    if (route.request().method() === "PUT") updates.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
    await route.continue();
  });

  await page.getByLabel("标题").fill("原来的标题");
  await page.getByLabel("作品正文").click();
  await page.keyboard.type("原来的正文。");
  // Two events before React has a chance to render its disabled button.
  await page.getByRole("button", { name: "保存草稿" }).evaluate((element: HTMLButtonElement) => { element.click(); element.click(); });
  await committed;
  expect(attempts).toHaveLength(1);
  await expect(page.getByRole("button", { name: "新建作品 +" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "退出登录" })).toBeDisabled();
  await page.getByLabel("标题").fill("后来修改的标题");
  await page.getByLabel("作品正文").click();
  await page.keyboard.press("End");
  await page.keyboard.type("后来修改的正文。");
  release();
  await expect(page.getByRole("alert")).toContainText("暂时无法确认");
  await expect(page.getByRole("link", { name: "在新标签页核对作品列表" })).toHaveAttribute("target", "_blank");

  const leavingPage = page.waitForEvent("dialog");
  const reload = page.evaluate(() => window.location.reload()).catch(() => null);
  const unloadWarning = await leavingPage;
  expect(unloadWarning.type()).toBe("beforeunload");
  await unloadWarning.dismiss();
  await reload;

  // A client-side link must not quietly discard the only copy of the pending
  // key or the author's unsaved edits.
  await page.getByRole("link", { name: "媒体库" }).click();
  const leave = page.getByRole("dialog", { name: "上次保存尚未确认" });
  await expect(leave).toBeVisible();
  await leave.getByRole("button", { name: "取消" }).click();
  await expect(leave).not.toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/write");

  // Publishing the edited form is not a retry of saving the original draft.
  await page.getByRole("button", { name: "发布作品" }).click();
  await expect(page.getByRole("alert")).toContainText("上次保存");
  expect(attempts).toHaveLength(1);
  await page.getByRole("button", { name: "确认上次保存" }).click();
  await expect(page.getByRole("status").filter({ hasText: "当前修改尚未保存" })).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  await expect(page.getByLabel("标题")).toHaveValue("后来修改的标题");
  await expect(page.getByLabel("作品正文")).toContainText("后来修改的正文。");
  expect((await savedArticles(page)).map((article) => article.id)).toEqual([committedId]);

  const publish = page.waitForResponse((response) => response.url().includes(`/api/authoring/articles/${committedId}`) && response.request().method() === "PUT");
  await page.getByRole("button", { name: "发布作品" }).click();
  expect((await publish).status()).toBe(200);
  await expect(page.getByRole("status").filter({ hasText: "作品已发布。" })).toBeVisible();
  expect(updates).toHaveLength(1);
  expect(updates[0].key).toBeUndefined();
  expect(JSON.parse(updates[0].body!).title).toBe("后来修改的标题");
  const saved = await savedArticles(page);
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ id: committedId, title: "后来修改的标题", status: "published" });
});

test("an unconfirmed create cannot be retried under a different signed-in account", async ({ page, request }) => {
  const originalEmail = await registerWriter(page, request);
  await waitForEditor(page);
  const attempts: { key: string | undefined; body: string | null }[] = [];
  let committedId = "";
  await page.route("**/api/authoring/articles", async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    attempts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
    if (attempts.length === 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      committedId = (await response.json()).data.id as string;
      await route.abort("failed");
    } else {
      await route.continue();
    }
  });
  await page.getByLabel("标题").fill("只属于原账户的作品");
  await page.getByLabel("作品正文").click();
  await page.keyboard.type("这次重试不能写到另一个账户。");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("alert")).toContainText("暂时无法确认");

  const otherEmail = uniqueEmail("another-writer");
  const registered = await request.post(`${API_BASE_URL}/api/v1/auth/register`, { data: { email: otherEmail, password: PASSWORD } });
  expect(registered.status()).toBe(201);
  await signIn(page, otherEmail);
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("alert")).toContainText("账户已变化");
  expect(await savedArticles(page)).toHaveLength(0);
  expect(attempts[1]).toEqual(attempts[0]);

  await signIn(page, originalEmail);
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("status").filter({ hasText: "上次创建已确认" })).toBeVisible();
  expect(attempts[2]).toEqual(attempts[0]);
  expect((await savedArticles(page)).map((article) => article.id)).toEqual([committedId]);
});

test("401, conflict and malformed success never silently replace an uncertain create key", async ({ page, request }) => {
  await registerWriter(page, request);
  await waitForEditor(page);
  const attempts: { key: string | undefined; body: string | null }[] = [];
  let replay: ReturnType<typeof simulatedArticle> | null = null;
  await page.route("**/api/authoring/articles", async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    attempts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
    if (attempts.length === 1) {
      await route.fulfill({ status: 401, contentType: "application/json", body: '{"error":{"code":"UNAUTHENTICATED"}}' });
    } else if (attempts.length === 2) {
      await route.fulfill({ status: 409, contentType: "application/json", body: '{"error":{"code":"IDEMPOTENCY_CONFLICT"}}' });
    } else if (attempts.length === 3) {
      replay = simulatedArticle(attempts[2].body);
      // Superficially plausible, but missing locale, type and document version.
      const { id, slug, title, status, contentBlocks } = replay;
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ data: { id, slug, title, status, contentBlocks } }) });
    } else {
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ data: replay }) });
    }
  });
  await page.getByLabel("标题").fill("异常后的恢复");
  await page.getByLabel("作品正文").click();
  await page.keyboard.type("不能把不确定的响应当成没有保存。");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("alert")).toContainText("登录");
  await expect(page.getByRole("alert").getByRole("link")).toHaveAttribute("target", "_blank");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("alert")).toContainText("冲突");
  expect(attempts[1]).toEqual(attempts[0]);
  await page.getByRole("button", { name: "放弃上次未确认的请求" }).click();
  const discard = page.getByRole("dialog", { name: "放弃未确认的保存？" });
  await expect(discard).toContainText("可能已经创建");
  await discard.getByRole("button", { name: "确认放弃" }).click();
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("alert")).toContainText("暂时无法确认");
  expect(attempts[2].key).not.toBe(attempts[1].key);
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("status").filter({ hasText: "上次创建已确认" })).toBeVisible();
  expect(attempts[3]).toEqual(attempts[2]);
  await expect(page.getByLabel("标题")).toHaveValue("异常后的恢复");
});

test("a locally rejected initial request permits a corrected first save", async ({ page, request }) => {
  await registerWriter(page, request);
  await waitForEditor(page);
  const attempts: { key: string | undefined; body: string | null }[] = [];
  await page.route("**/api/authoring/articles", async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    attempts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
    if (attempts.length === 1) {
      await route.fulfill({ status: 400, contentType: "application/json", headers: { "x-authoring-not-forwarded": "1" }, body: '{"error":{"code":"BAD_USER_INPUT","message":"Please correct the input."}}' });
    } else {
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ data: simulatedArticle(attempts[1].body) }) });
    }
  });
  await page.getByLabel("标题").fill("需要修正的标题");
  await page.getByLabel("作品正文").click();
  await page.keyboard.type("修正前的正文。");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("alert")).toContainText("Please correct the input.");
  await page.getByLabel("标题").fill("修正后的标题");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("status").filter({ hasText: "草稿已保存。" })).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[1].key).not.toBe(attempts[0].key);
  expect(JSON.parse(attempts[1].body!).title).toBe("修正后的标题");
});

test("a later 400 cannot erase a previously uncertain create", async ({ page, request }) => {
  await registerWriter(page, request);
  await waitForEditor(page);
  const attempts: { key: string | undefined; body: string | null }[] = [];
  await page.route("**/api/authoring/articles", async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    attempts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
    if (attempts.length === 1) {
      // No answer proves whether this first attempt reached the server.
      await route.abort("failed");
    } else if (attempts.length === 2) {
      // The retry itself never left the proxy, but the first might have.
      await route.fulfill({ status: 400, contentType: "application/json", headers: { "x-authoring-not-forwarded": "1" }, body: '{"error":{"code":"BAD_USER_INPUT","message":"rejected"}}' });
    } else {
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ data: simulatedArticle(attempts[0].body) }) });
    }
  });
  await page.getByLabel("标题").fill("仍需确认的作品");
  await page.getByLabel("作品正文").click();
  await page.keyboard.type("稍后拒绝不等于第一次没有提交。");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("alert")).toContainText("暂时无法确认");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("alert")).toContainText("上次保存");
  expect(attempts[1]).toEqual(attempts[0]);
  await page.getByLabel("标题").fill("修改后的标题");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("alert")).toContainText("上次保存");
  expect(attempts).toHaveLength(2);
  await page.getByRole("button", { name: "确认上次保存" }).click();
  await expect(page.getByRole("status").filter({ hasText: "当前修改尚未保存" })).toBeVisible();
  expect(attempts[2]).toEqual(attempts[0]);
  await expect(page.getByLabel("标题")).toHaveValue("修改后的标题");
});

test("editing while the first save succeeds is not reported as already saved", async ({ page, request }) => {
  await registerWriter(page, request);
  await waitForEditor(page);
  let received!: () => void;
  const arrived = new Promise<void>((resolve) => { received = resolve; });
  let simulated: ReturnType<typeof simulatedArticle> | null = null;
  const creates: string[] = [];
  const updates: string[] = [];
  let release!: () => void;
  const responseGate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/authoring/articles", async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    creates.push(route.request().postData() ?? "");
    simulated = simulatedArticle(creates[0]);
    received();
    await responseGate;
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ data: simulated }) });
  });
  await page.route("**/api/authoring/articles/*", async (route) => {
    if (route.request().method() !== "PUT") { await route.continue(); return; }
    updates.push(route.request().postData() ?? "");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: simulatedArticle(updates[0], simulated!) }) });
  });
  await page.getByLabel("标题").fill("已发送的标题");
  await page.getByLabel("作品正文").click();
  await page.keyboard.type("已发送的正文。");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await arrived;
  await page.getByLabel("标题").fill("保存期间的新标题");
  release();
  await expect(page.getByRole("status").filter({ hasText: "当前修改尚未保存" })).toBeVisible();
  await expect(page.getByLabel("标题")).toHaveValue("保存期间的新标题");
  expect(JSON.parse(creates[0]).title).toBe("已发送的标题");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("status").filter({ hasText: "草稿已保存。" })).not.toContainText("当前修改尚未保存");
  expect(updates).toHaveLength(1);
  expect(JSON.parse(updates[0]).title).toBe("保存期间的新标题");
});

test("even an initial 400 can follow a commit and must not silently retire the key", async ({ page, request }) => {
  await registerWriter(page, request);
  await waitForEditor(page);
  const attempts: { key: string | undefined; body: string | null }[] = [];
  let committedId = "";
  await page.route("**/api/authoring/articles", async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    attempts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
    if (attempts.length === 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      committedId = (await response.json()).data.id as string;
      // An error while serializing a response can be reported after the write.
      await route.fulfill({ status: 400, contentType: "application/json", body: '{"error":{"code":"BAD_USER_INPUT","message":"response failed"}}' });
    } else {
      await route.continue();
    }
  });
  await page.getByLabel("标题").fill("第一次返回错误但已提交");
  await page.getByLabel("作品正文").click();
  await page.keyboard.type("错误状态并不一定证明没有创建。");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("alert")).toContainText("上次保存");
  await page.getByLabel("标题").fill("修改后的文本");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("alert")).toContainText("上次保存");
  expect(attempts).toHaveLength(1);
  await page.getByRole("button", { name: "确认上次保存" }).click();
  await expect(page.getByRole("status").filter({ hasText: "当前修改尚未保存" })).toBeVisible();
  expect(attempts[1]).toEqual(attempts[0]);
  expect((await savedArticles(page)).map((article) => article.id)).toEqual([committedId]);
});

test("a replay reports the server's current version without claiming the open editor saved over it", async ({ page, request }) => {
  await registerWriter(page, request);
  await waitForEditor(page);
  const attempts: { key: string | undefined; body: string | null }[] = [];
  let committedId = "";
  let slug = "";
  await page.route("**/api/authoring/articles", async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    attempts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
    if (attempts.length === 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      const data = (await response.json()).data as { id: string; slug: string };
      committedId = data.id;
      slug = data.slug;
      await route.abort("failed");
    } else {
      await route.continue();
    }
  });
  await page.getByLabel("标题").fill("此页面原来的标题");
  await page.getByLabel("作品正文").click();
  await page.keyboard.type("此页面原来的正文。");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("alert")).toContainText("暂时无法确认");

  // Simulate another tab editing the committed work before the lost-response
  // retry. Replay returns the current resource, not the first response bytes.
  const otherBody = { ...JSON.parse(attempts[0].body!), slug, title: "其他页面的新标题" };
  const other = await page.request.put(`/api/authoring/articles/${committedId}`, {
    headers: { origin: currentOrigin() },
    data: otherBody,
  });
  expect(other.status()).toBe(200);
  await page.getByRole("button", { name: "保存草稿" }).click();
  const status = page.getByRole("status").filter({ hasText: "上次创建已确认" });
  await expect(status).toContainText("服务器返回的是当前版本");
  await expect(status.getByRole("link", { name: "在新标签页核对服务器版本" })).toHaveAttribute("target", "_blank");
  await expect(page.getByLabel("标题")).toHaveValue("此页面原来的标题");
  expect(attempts[1]).toEqual(attempts[0]);
  expect(await savedArticles(page)).toMatchObject([{ id: committedId, title: "其他页面的新标题" }]);
});

test("changing only publish intent cannot reuse an uncertain create as a different request", async ({ page, request }) => {
  await registerWriter(page, request);
  await waitForEditor(page);
  const attempts: { key: string | undefined; body: string | null }[] = [];
  let committedId = "";
  await page.route("**/api/authoring/articles", async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    attempts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
    if (attempts.length === 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      committedId = (await response.json()).data.id as string;
      await route.abort("failed");
    } else {
      await route.continue();
    }
  });
  await page.getByLabel("标题").fill("发布状态也是保存意图的一部分");
  await page.getByLabel("作品正文").click();
  await page.keyboard.type("先发布，再决定是否撤回。");
  await page.getByRole("button", { name: "发布作品" }).click();
  await expect(page.getByRole("alert")).toContainText("暂时无法确认");
  expect(JSON.parse(attempts[0].body!).publish).toBe(true);
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("alert")).toContainText("上次保存");
  expect(attempts).toHaveLength(1);
  await page.getByRole("button", { name: "确认上次保存" }).click();
  await expect(page.getByRole("status").filter({ hasText: "所选操作尚未执行" })).toBeVisible();
  expect(attempts[1]).toEqual(attempts[0]);
  expect((await savedArticles(page))[0]).toMatchObject({ id: committedId, status: "published" });
  await page.getByRole("button", { name: "转为草稿" }).click();
  await answerDeskDialog(page, "转为草稿？", "确认转为草稿");
  await expect(page.getByRole("status").filter({ hasText: "作品已转为草稿" })).toBeVisible();
  expect((await savedArticles(page))[0]).toMatchObject({ id: committedId, status: "draft" });
});

test("English and historical Traditional Chinese editions remain discoverable, editable and restorable", async ({ page, request }) => {
  await registerWriter(page, request);
  await waitForEditor(page);

  const english = `English locale journey ${Date.now().toString(36)}`;
  await page.getByLabel("作品语言").selectOption("en");
  await page.getByLabel("标题").fill(english);
  await page.getByLabel("作品正文").click();
  await page.keyboard.type("An English work survives a reload.");
  const creation = page.waitForResponse((response) => response.url().endsWith("/api/authoring/articles") && response.request().method() === "POST");
  await page.getByRole("button", { name: "发布作品" }).click();
  const createdResponse = await creation;
  expect(createdResponse.status(), await createdResponse.text()).toBe(201);
  const created = (await createdResponse.json()).data as { id: string; slug: string; locale: string };
  expect(created.locale).toBe("en");
  await expect(page.getByRole("status").filter({ hasText: "作品已发布。" })).toContainText(`/en/articles/${created.slug}`);
  await expect(page.getByRole("link", { name: "查看已发布作品" })).toHaveAttribute("href", `/en/articles/${created.slug}`);

  // This is the real public page, not just a plausible-looking success address.
  await page.goto(`/en/articles/${created.slug}`);
  await expect(page.getByRole("heading", { level: 1, name: english })).toBeVisible({ timeout: 45_000 });
  await page.goto("/write");
  await waitForEditor(page);
  const shelf = page.getByRole("complementary", { name: "我的作品" });
  await expect(shelf.getByRole("button", { name: new RegExp(english) })).toBeVisible();
  await shelf.getByRole("button", { name: new RegExp(english) }).click();
  await expect(page.getByLabel("作品语言")).toHaveValue("en");
  await expect(page.getByLabel("作品正文")).toContainText("An English work survives a reload.");
  await page.getByLabel("标题").fill("Edited English edition");
  await page.getByLabel("作品正文").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" And later editing.");
  const update = page.waitForResponse((response) => response.url().includes(`/api/authoring/articles/${created.id}`) && response.request().method() === "PUT");
  await page.getByRole("button", { name: "保存更新" }).click();
  expect((await update).status()).toBe(200);
  await expect(page.getByRole("status").filter({ hasText: "作品已发布。" })).toBeVisible();

  // Explicitly choosing another locale adds a translation to this same id.
  // Both editions must be separately selectable; switching back must remount
  // the correct document rather than leaving the previous edition's content.
  await page.getByLabel("作品语言").selectOption("zh-CN");
  await page.getByLabel("标题").fill("同一作品的中文译本");
  await page.getByLabel("作品正文").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("独立的中文正文。");
  let translationWrites = 0;
  page.on("request", (req) => {
    if (req.url().includes(`/api/authoring/articles/${created.id}`) && req.method() === "PUT") translationWrites += 1;
  });
  await page.getByRole("button", { name: "保存更新" }).click();
  const languageWarning = page.getByRole("dialog", { name: "保存到其他语言？" });
  await expect(languageWarning).toContainText("已有版本");
  await languageWarning.getByRole("button", { name: "取消" }).click();
  expect(translationWrites, "cancelling cannot overwrite another edition").toBe(0);
  await expect(page.getByLabel("标题")).toHaveValue("同一作品的中文译本");
  const translation = page.waitForResponse((response) => response.url().includes(`/api/authoring/articles/${created.id}`) && response.request().method() === "PUT");
  await page.getByRole("button", { name: "保存更新" }).click();
  await languageWarning.getByRole("button", { name: "确认保存" }).click();
  expect((await translation).status()).toBe(200);
  await expect(shelf.getByRole("button", { name: /Edited English edition/ })).toBeVisible();
  await expect(shelf.getByRole("button", { name: /同一作品的中文译本/ })).toBeVisible();
  await shelf.getByRole("button", { name: /Edited English edition/ }).click();
  await expect(page.getByLabel("作品语言")).toHaveValue("en");
  await expect(page.getByLabel("作品正文")).toContainText("And later editing.");
  // A target translation now exists. Cancelling the warning must leave it intact.
  await page.getByLabel("作品语言").selectOption("zh-CN");
  await page.getByRole("button", { name: "保存更新" }).click();
  await expect(languageWarning).toBeVisible();
  await languageWarning.getByRole("button", { name: "取消" }).click();
  expect(translationWrites).toBe(1);
  await shelf.getByRole("button", { name: /同一作品的中文译本/ }).click();
  await expect(page.getByLabel("作品语言")).toHaveValue("zh-CN");
  await expect(page.getByLabel("作品正文")).toContainText("独立的中文正文。");

  // Deletion is at work level, so the two language rows leave together and a
  // restore brings both back. Switching to a sibling edition while the delete
  // is in flight must still reset that now-deleted editor.
  let releaseDelete!: () => void;
  let deletedOnServer!: () => void;
  const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
  const deleteCommitted = new Promise<void>((resolve) => { deletedOnServer = resolve; });
  await page.route(`**/api/authoring/articles/${created.id}`, async (route) => {
    if (route.request().method() !== "DELETE") { await route.continue(); return; }
    const response = await route.fetch();
    deletedOnServer();
    await deleteGate;
    await route.fulfill({ response });
  });
  const deleteResponse = page.waitForResponse((response) => response.url().includes(`/api/authoring/articles/${created.id}`) && response.request().method() === "DELETE");
  await page.getByRole("button", { name: "删除作品", exact: true }).click();
  const languageDelete = page.getByRole("dialog", { name: /删除《.*》？/ });
  await expect(languageDelete).toContainText("所有语言版本");
  await languageDelete.getByRole("button", { name: "确认删除" }).click();
  await deleteCommitted;
  await shelf.getByRole("button", { name: /Edited English edition/ }).click();
  await expect(page.getByLabel("作品语言")).toHaveValue("en");
  releaseDelete();
  expect((await deleteResponse).status()).toBe(200);
  await expect(page.getByLabel("标题")).toHaveValue("");
  const trash = page.getByRole("region", { name: "回收站" });
  await expect(trash.getByRole("button", { name: "还原《Edited English edition》" })).toBeVisible();
  await expect(trash.getByRole("button", { name: "还原《同一作品的中文译本》" })).toBeVisible();
  await trash.getByRole("button", { name: "还原《Edited English edition》" }).click();
  await expect(page.getByRole("status").filter({ hasText: "已还原" })).toContainText("Edited English edition");
  await expect(shelf.getByRole("button", { name: /Edited English edition/ })).toBeVisible();
  await expect(shelf.getByRole("button", { name: /同一作品的中文译本/ })).toBeVisible();

  // Seed an existing zh-TW edition through the real proxy/API; the desk does
  // not offer that retired locale for a new work, but must preserve old rows.
  const legacyTitle = "原有繁體中文作品";
  const legacy = await page.request.post("/api/authoring/articles", {
    headers: { origin: currentOrigin() },
    data: { slug: `historic-${Date.now().toString(36)}`, title: legacyTitle, locale: "zh-TW", publish: false,
      contentBlocks: [{ id: "p1", type: "paragraph", text: "原有的繁體正文。" }] },
  });
  expect(legacy.status(), await legacy.text()).toBe(201);
  const legacyId = ((await legacy.json()).data as { id: string }).id;
  await page.reload();
  await waitForEditor(page);
  await expect(page.getByLabel("作品语言").locator('option[value="zh-TW"]')).toHaveCount(0);
  await expect(shelf.getByRole("button", { name: new RegExp(legacyTitle) })).toBeVisible();
  await shelf.getByRole("button", { name: new RegExp(legacyTitle) }).click();
  await expect(page.getByLabel("作品语言")).toHaveValue("zh-TW");
  await expect(page.getByLabel("作品正文")).toContainText("原有的繁體正文。");
  // Looking at another option must not make the stored legacy option disappear.
  await page.getByLabel("作品语言").selectOption("en");
  await page.getByLabel("作品语言").selectOption("zh-TW");
  await expect(page.getByLabel("作品正文")).toContainText("原有的繁體正文。");
  await page.getByLabel("标题").fill("編輯後的繁體中文作品");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("status").filter({ hasText: "草稿已保存。" })).toBeVisible();
  const traditional = await page.request.get("/api/authoring/articles?locale=zh-TW");
  expect(traditional.status()).toBe(200);
  const traditionalWorks = (await traditional.json()).data as { locale: string; title: string }[];
  expect(traditionalWorks).toContainEqual(expect.objectContaining({ locale: "zh-TW", title: "編輯後的繁體中文作品" }));
  await page.getByRole("button", { name: "删除作品", exact: true }).click();
  await answerDeskDialog(page, /删除《.*》？/, "确认删除");
  await expect(trash.getByRole("button", { name: "还原《編輯後的繁體中文作品》" })).toBeVisible();
  await trash.getByRole("button", { name: "还原《編輯後的繁體中文作品》" }).click();
  await expect(shelf.getByRole("button", { name: /編輯後的繁體中文作品/ })).toBeVisible();
  await shelf.getByRole("button", { name: /編輯後的繁體中文作品/ }).click();
  await expect(page.getByLabel("作品语言")).toHaveValue("zh-TW");
  await expect(page.getByLabel("作品正文")).toContainText("原有的繁體正文。");

  // An update can finish after the author opens another work. Its old callback
  // must not replace the selected identity under the newly mounted editor.
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const committed = new Promise<void>((resolve) => { reached = resolve; });
  await page.route(`**/api/authoring/articles/${created.id}`, async (route) => {
    if (route.request().method() !== "PUT") { await route.continue(); return; }
    const response = await route.fetch();
    reached();
    await gate;
    await route.fulfill({ response });
  });
  await shelf.getByRole("button", { name: /Edited English edition/ }).click();
  await page.getByLabel("标题").fill("English update in flight");
  const oldSave = page.waitForResponse((response) => response.url().includes(`/api/authoring/articles/${created.id}`) && response.request().method() === "PUT");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await committed;
  await shelf.getByRole("button", { name: /編輯後的繁體中文作品/ }).click();
  await expect(page.getByLabel("作品语言")).toHaveValue("zh-TW");
  release();
  expect((await oldSave).status()).toBe(200);
  await expect(shelf.getByRole("button", { name: /English update in flight/ })).toBeVisible();
  await expect(shelf.getByRole("button", { name: /編輯後的繁體中文作品/ })).toHaveAttribute("aria-current", "true");
  await page.getByLabel("标题").fill("仍在編輯的繁體作品");
  const legacySave = page.waitForResponse((response) => response.url().includes(`/api/authoring/articles/${legacyId}`) && response.request().method() === "PUT");
  await page.getByRole("button", { name: "保存草稿" }).click();
  expect((await legacySave).status()).toBe(200);
  await expect(page.getByRole("status").filter({ hasText: "草稿已保存。" })).toBeVisible();

  // Deleting a different work while this one is opened has the opposite rule:
  // the late completion must not reset the current editor or its typed content.
  let releaseOtherDelete!: () => void;
  let otherDeleted!: () => void;
  const otherGate = new Promise<void>((resolve) => { releaseOtherDelete = resolve; });
  const otherCommitted = new Promise<void>((resolve) => { otherDeleted = resolve; });
  await page.route(`**/api/authoring/articles/${created.id}`, async (route) => {
    if (route.request().method() !== "DELETE") { await route.fallback(); return; }
    const response = await route.fetch();
    otherDeleted();
    await otherGate;
    await route.fulfill({ response });
  });
  await shelf.getByRole("button", { name: /English update in flight/ }).click();
  const otherDelete = page.waitForResponse((response) => response.url().includes(`/api/authoring/articles/${created.id}`) && response.request().method() === "DELETE");
  await page.getByRole("button", { name: "删除作品", exact: true }).click();
  await answerDeskDialog(page, /删除《.*》？/, "确认删除");
  await otherCommitted;
  await shelf.getByRole("button", { name: /仍在編輯的繁體作品/ }).click();
  await expect(page.getByLabel("作品语言")).toHaveValue("zh-TW");
  await page.getByLabel("标题").fill("尚未保存的繁體修改");
  releaseOtherDelete();
  expect((await otherDelete).status()).toBe(200);
  await expect(shelf.getByRole("button", { name: /English update in flight/ })).toHaveCount(0);
  await expect(page.getByLabel("标题")).toHaveValue("尚未保存的繁體修改");
  await expect(shelf.getByRole("button", { name: /仍在編輯的繁體作品/ })).toHaveAttribute("aria-current", "true");
});

test("an older API cannot silently present a single locale as the complete writing desk", async ({ page, request }) => {
  await registerWriter(page, request);
  await page.route((url) => url.pathname === "/api/authoring/articles" && url.searchParams.get("allLocales") === "true", async (route) => {
    // The old API ignores the unknown query and returns an apparently valid
    // zh-CN-only list. Treating this as complete would hide existing editions.
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) });
  });
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("无法确认所有语言版本");
  await expect(page.getByText("还没有草稿或已发布作品。")).toHaveCount(0);
});

test("a success response with the wrong language cannot retire an uncertain create", async ({ page, request }) => {
  await registerWriter(page, request);
  await waitForEditor(page);
  const attempts: { key: string | undefined; body: string | null }[] = [];
  await page.route("**/api/authoring/articles", async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    attempts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
    const data = simulatedArticle(route.request().postData());
    if (attempts.length === 1) data.locale = "zh-CN";
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ data }) });
  });
  await page.getByLabel("作品语言").selectOption("en");
  await page.getByLabel("标题").fill("Wrong language response");
  await page.getByLabel("作品正文").click();
  await page.keyboard.type("The original intent must remain available.");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("alert")).toContainText("暂时无法确认");
  await expect(page.getByRole("button", { name: "新建作品 +" })).toBeDisabled();
  await page.getByRole("button", { name: "确认上次保存" }).click();
  await expect(page.getByRole("status").filter({ hasText: "上次创建已确认" })).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(JSON.parse(attempts[0].body!).locale).toBe("en");
});


test("a stale editor keeps its draft and cannot overwrite another window's saved revision", async ({ page, request }) => {
  await registerWriter(page, request);
  await writeAndSave(page, "条件保存测试", false);
  await expect(page.getByRole("status").filter({ hasText: "草稿已保存。" })).toBeVisible();
  const [article] = (await (await page.request.get("/api/authoring/articles")).json()).data;
  expect(typeof article.revision).toBe("string");
  const remote = await page.request.put(`/api/authoring/articles/${article.id}`, {
    headers: { origin: currentOrigin() },
    data: { slug: article.slug, title: "其他窗口的最新作品", locale: article.locale, publish: false,
      expectedRevision: article.revision, contentBlocks: [{ id: "remote", type: "paragraph", text: "远端新正文。" }] },
  });
  expect(remote.status()).toBe(200);
  await page.getByLabel("标题").fill("需要保留的本地草稿");
  await page.getByLabel("作品正文").fill("当前窗口里尚未保存的正文。");
  const response = page.waitForResponse((result) => result.request().method() === "PUT" && result.url().endsWith(`/api/authoring/articles/${article.id}`));
  await page.getByRole("button", { name: "保存草稿" }).click();
  expect((await response).status()).toBe(409);
  await expect(page.getByRole("alert")).toContainText("当前草稿仍保留，请先复制备份");
  await expect(page.getByLabel("标题")).toHaveValue("需要保留的本地草稿");
  await expect(page.getByLabel("作品正文")).toContainText("当前窗口里尚未保存的正文。");
  const [kept] = (await (await page.request.get("/api/authoring/articles")).json()).data;
  expect(kept.title).toBe("其他窗口的最新作品");
  expect(JSON.stringify(kept.contentBlocks)).toContain("远端新正文。");
});
