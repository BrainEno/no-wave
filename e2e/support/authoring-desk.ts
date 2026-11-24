/**
 * Shared helpers for the authoring journey specs (`e2e/authoring*.spec.ts`).
 * Not a spec: Playwright discovers only `*.spec.ts`, so this file is imported.
 */
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { test } from "./csp-fixture.ts";

/**
 * Everything the page sent to and received from the authoring API.
 *
 * Printed for a failing test. "The click did nothing", "the click hit another
 * button" and "the request was rejected" look identical from the outside, and
 * only the traffic tells them apart.
 */
/** Console output and uncaught exceptions: a handler that throws looks like a
 *  click that did nothing, and the page error is the only trace it leaves. */
export const desk: { traffic: string[]; consoleLog: string[] } = {
  traffic: [],
  consoleLog: [],
};

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
export const PASSWORD = "e2e-browser-password";

/** The API both frameworks proxy to; every project shares one database. */
export const API_BASE_URL =
  process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:4000";

/**
 * The origin the current project is driving.
 *
 * Read from the project rather than from the environment: the two projects differ
 * only in `baseURL`, and the login proxy rejects a mutation whose `Origin` is not
 * exactly its own — so the header has to follow the project, not a constant.
 */
export function currentOrigin(): string {
  const baseURL = test.info().project.use.baseURL;
  if (!baseURL) throw new Error("every browser project must define a baseURL");
  return new URL(baseURL).origin;
}

export type SavedArticle = {
  id: string;
  slug: string;
  title: string;
  status: "draft" | "published";
};

export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

/**
 * A compact snapshot of what the page actually rendered.
 *
 * CI logs are the only place a browser failure can be read, and a bare
 * "locator not found" says nothing about a page that rendered something else.
 * The digest is attached to assertion messages so it lands in the failure text.
 */
export async function pageDigest(page: Page): Promise<string> {
  try {
    return (await page.locator("body").ariaSnapshot()).slice(0, 1200);
  } catch {
    return (await page.content()).slice(0, 1200);
  }
}

export type SessionCookie = {
  name: string;
  value: string;
  path: string;
  maxAge: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Lax" | "Strict" | "None";
};

/**
 * Read the session cookies out of a login response.
 *
 * They are written into the browser context explicitly rather than relying on
 * the API client sharing its cookie jar with the page: the suite is about the
 * browser, and it should not depend on that sharing being true.
 */
export function sessionCookies(
  headers: { name: string; value: string }[],
): SessionCookie[] {
  const cookies: SessionCookie[] = [];
  for (const header of headers) {
    if (header.name.toLowerCase() !== "set-cookie") continue;
    const parts = header.value
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
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
        case "path":
          cookie.path = value.trim();
          break;
        case "max-age":
          cookie.maxAge = Number.parseInt(value.trim(), 10) || cookie.maxAge;
          break;
        case "httponly":
          cookie.httpOnly = true;
          break;
        case "secure":
          cookie.secure = true;
          break;
        case "samesite": {
          const sameSite = value.trim().toLowerCase();
          if (sameSite === "strict") cookie.sameSite = "Strict";
          else if (sameSite === "none") cookie.sameSite = "None";
          else cookie.sameSite = "Lax";
          break;
        }
        default:
          break;
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
export async function signIn(page: Page, email: string): Promise<void> {
  // Through the same-origin proxy the application uses. The proxy rejects
  // mutations without an exact same-origin Origin header, which a plain HTTP
  // client does not send.
  const origin = currentOrigin();
  const login = await page.request.post("/api/auth/login", {
    data: { email, password: PASSWORD },
    headers: { origin },
  });
  expect(
    login.status(),
    `signing the browser in as ${email}: ${await login.text()}`,
  ).toBe(200);
  const cookies = sessionCookies(await login.headersArray());
  expect(
    cookies.length,
    `the login response must set session cookies; headers: ${JSON.stringify(await login.headersArray())}`,
  ).toBeGreaterThan(0);
  // `domain` + `path` (not `url`): Playwright derives the path from a url's
  // directory, and the access cookie is deliberately scoped to /api/authoring
  // so it is never sent to page routes.
  await page.context().addCookies(
    cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: new URL(origin).hostname,
      path: cookie.path,
      expires: Math.floor(Date.now() / 1000) + cookie.maxAge,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
    })),
  );
}

/**
 * Create an account with a profile and hand the browser its session.
 *
 * The profile is not decoration: the public reader drops articles whose author
 * has none, so a published work would be unreachable without it.
 */
export async function registerWriter(
  page: Page,
  request: APIRequestContext,
): Promise<string> {
  const email = uniqueEmail("writer");
  const registered = await request.post(
    `${API_BASE_URL}/api/v1/auth/register`,
    {
      data: { email, password: PASSWORD },
    },
  );
  expect(
    registered.status(),
    `registering ${email}: ${await registered.text()}`,
  ).toBe(201);
  const { accessToken } = (await registered.json()).data as {
    accessToken: string;
  };

  const profile = await request.put(`${API_BASE_URL}/api/v1/me/profile`, {
    data: { displayName: "无浪作者", bio: "浏览器验证账户。", locale: "zh-CN" },
    headers: { authorization: `Bearer ${accessToken}`, origin: API_BASE_URL },
  });
  expect(
    profile.status(),
    `creating the author profile: ${await profile.text()}`,
  ).toBe(200);

  await signIn(page, email);
  await page.goto("/write");
  try {
    await expect(page.getByRole("heading", { name: /写作台/ })).toBeVisible({
      timeout: 45_000,
    });
  } catch (caught) {
    // Distinguish "no session", "an API call hangs" and "client JS never ran":
    // all three leave the page on its server-rendered loading state.
    const probe = await page
      .evaluate(async () => {
        const status = async (path: string): Promise<number> => {
          const response = await fetch(path, {
            credentials: "same-origin",
            cache: "no-store",
          });
          return response.status;
        };
        return {
          session: await status("/api/authoring/session"),
          articles: await status("/api/authoring/articles"),
          hydrated:
            typeof (window as unknown as { next?: unknown }).next === "object",
          scripts: document.scripts.length,
        };
      })
      .catch((error: unknown) => `probe failed: ${String(error)}`);
    throw new Error(
      `/write did not open the authoring desk (probe: ${JSON.stringify(probe)}); page:\n${await pageDigest(page)}\n${String(caught)}`,
    );
  }
  return email;
}

/** Wait until the Lexical editor has hydrated: its toolbar exists client-side only. */
export async function waitForEditor(page: Page): Promise<void> {
  await expect(page.getByLabel("标题")).toBeVisible();
  await expect(page.getByRole("toolbar", { name: "富文本格式" })).toBeVisible({
    timeout: 45_000,
  });
}

export async function savedArticles(page: Page): Promise<SavedArticle[]> {
  const response = await page.request.get("/api/authoring/articles");
  expect(response.status(), "reading the author's article list").toBe(200);
  const body = (await response.json()) as { data: SavedArticle[] };
  return Array.isArray(body.data) ? body.data : [];
}

export const FIRST_PARAGRAPH =
  "无浪是一只没有波浪的文学站点，第一段用来验证保存链路。";

export const SECOND_PARAGRAPH =
  "第二段用来验证摘要会取正文开头，而不是把整篇文章塞进去。";

/** Write a title and two paragraphs, then save; returns the generated address. */
export async function writeAndSave(
  page: Page,
  title: string,
  publish: boolean,
): Promise<string> {
  await waitForEditor(page);
  await page.getByLabel("标题").fill(title);
  await page.getByLabel("作品正文").click();
  await page.keyboard.type(FIRST_PARAGRAPH);
  await page.keyboard.press("Enter");
  await page.keyboard.type(SECOND_PARAGRAPH);
  // The text has to reach the editor state, not just the DOM, before saving.
  await expect(page.getByLabel("作品正文")).toContainText(
    "第一段用来验证保存链路。",
  );

  await page
    .getByRole("button", { name: publish ? "发布作品" : "保存草稿" })
    .click();
  return await savedSlug(page, title, publish ? "published" : "draft");
}

/**
 * Wait for the article to exist with the expected status and return its slug.
 *
 * Polled rather than read once: the workspace saves asynchronously, and the
 * slug is the durable outcome the rest of the assertions need.
 */
export async function savedSlug(
  page: Page,
  title: string,
  status: SavedArticle["status"],
): Promise<string> {
  let articles: SavedArticle[] = [];
  try {
    await expect(async () => {
      articles = await savedArticles(page);
      const match = articles.find((article) => article.title === title);
      expect(
        match,
        `no article titled "${title}" in ${JSON.stringify(articles.map((article) => [article.title, article.status]))}`,
      ).toBeDefined();
      expect(match?.status).toBe(status);
    }).toPass({ timeout: 45_000, intervals: [500, 1_000, 2_000] });
  } catch (caught) {
    throw new Error(
      `the save did not produce a ${status} article; page:\n${await pageDigest(page)}\n${String(caught)}`,
    );
  }
  const slug = articles.find((article) => article.title === title)?.slug ?? "";
  expect(
    slug,
    `a generated slug for "${title}": ${JSON.stringify(articles.map((article) => article.slug))}`,
  ).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  return slug;
}

/**
 * Answer one of the desk's own confirmations (#F-12).
 *
 * These used to be `window.confirm`, so the suite could answer them with
 * `page.on("dialog")` and never look at the page. They are now a native
 * `<dialog>` the product owns: the name is the question, the buttons are the
 * answer, and a missing dialog is a visible failure instead of a silent delete.
 */
export async function answerDeskDialog(
  page: Page,
  name: string | RegExp,
  answer: string,
): Promise<void> {
  const dialog = page.getByRole("dialog", { name });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: answer }).click();
  await expect(dialog).not.toBeVisible();
}

/**
 * Synthetic response for UI-only failure paths. The lost-response and replay
 * journeys below use the real API/database; modelling the other server answers
 * avoids exhausting the real 30 creates/IP/hour policy in one browser suite.
 */
export function simulatedArticle(
  body: string | null,
  identity?: { id: string; slug: string },
) {
  const input = JSON.parse(body ?? "{}") as {
    title?: string;
    summary?: string;
    locale?: string;
    workType?: string;
    publish?: boolean;
  };
  return {
    id: identity?.id ?? crypto.randomUUID(),
    slug: identity?.slug ?? "simulated-work",
    title: input.title ?? "",
    summary: input.summary ?? "",
    locale: input.locale ?? "zh-CN",
    workType: input.workType ?? "other",
    status: input.publish ? "published" : "draft",
    contentBlocksVersion: 1,
    contentBlocks: [{ id: "p1", type: "paragraph", text: "simulated" }],
  };
}

/**
 * Record the desk's network traffic and console output for every test in the
 * importing spec file, and print both when a test fails. Call once at module level.
 */
export function registerDeskTraffic(): void {
  test.beforeEach(async ({ page }) => {
    desk.traffic = [];
    desk.consoleLog = [];
    const record = (line: string): void => {
      if (desk.traffic.length < 40) desk.traffic.push(line);
    };
    const recordConsole = (line: string): void => {
      if (desk.consoleLog.length < 40) desk.consoleLog.push(line);
    };
    page.on("console", (message) =>
      recordConsole(`${message.type()}: ${message.text().slice(0, 300)}`),
    );
    page.on("pageerror", (error) =>
      recordConsole(`pageerror: ${String(error).slice(0, 300)}`),
    );
    const watched = (url: string): boolean =>
      /\/api\/(authoring|auth)/.test(url);
    page.on("request", (request) => {
      if (!watched(request.url())) return;
      record(
        `-> ${request.method()} ${new URL(request.url()).pathname} ${(request.postData() ?? "").slice(0, 200)}`,
      );
    });
    page.on("response", (response) => {
      if (!watched(response.url())) return;
      record(`<- ${response.status()} ${new URL(response.url()).pathname}`);
    });
    page.on("requestfailed", (request) => {
      if (!watched(request.url())) return;
      record(
        `!! ${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`,
      );
    });
  });
  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status !== "failed" && testInfo.status !== "timedOut") return;
    console.log(
      `FAILED ${testInfo.title} at ${page.url()}\ntraffic:\n${desk.traffic.join("\n")}\nconsole:\n${desk.consoleLog.join("\n")}\n${await pageDigest(page)}`,
    );
  });
}
