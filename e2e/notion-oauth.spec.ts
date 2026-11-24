import { expect, type BrowserContext, type Route } from "@playwright/test";
import { test } from "./support/csp-fixture.ts";
import { registerThroughForm, uniqueEmail } from "./support/accounts.ts";

/**
 * One-shot Notion OAuth on the desk (ADR 0053).
 *
 * What only a browser can show: that 「用 Notion 授权」 opens a popup, that the
 * callback page takes the code off its address bar and hands the token back to
 * the desk without `window.opener`, that the desk then pulls with it exactly as
 * with a pasted token — and that the token ends up in no storage, URL or cookie.
 *
 * Everything past our own pages is stood in for: our API's three OAuth calls,
 * Notion's authorize page (answered with the redirect Notion would send), and the
 * pull. No test reaches api.notion.com; what the API does with a code is covered
 * by notion-oauth.integration.test.ts.
 */

const OAUTH_TOKEN = "ntn_E2E_ONLY_oauth_access_token_0123456789";
const CODE = "E2E-ONLY-CODE-0001";
const STATE =
  "v1.4102444800.E2E-ONLY-state-nonce-000000000000000000000.E2E-ONLY-state-mac-00000000000000000000000";
const LINK = "https://www.notion.so/me/Works-0123456789abcdef0123456789abcdef";
const AUTHORIZE = "https://api.notion.com/v1/oauth/authorize";

const title = (text: string) => ({
  Name: {
    type: "title",
    title: [
      {
        plain_text: text,
        type: "text",
        text: { content: text, link: null },
        href: null,
        annotations: {
          bold: false,
          italic: false,
          underline: false,
          strikethrough: false,
          code: false,
          color: "default",
        },
      },
    ],
  },
});
const ROWS = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    properties: title("授权后拉取的第一篇"),
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    properties: title("授权后拉取的第二篇"),
  },
];

type NotionPage = "approve" | "deny" | "stay";

/**
 * Stand in for our OAuth endpoints, Notion's authorize page and the pull, for the
 * desk and its popup alike (routes on the context, not the page).
 */
async function mockOAuth(
  context: BrowserContext,
  options: { enabled: () => boolean; notion: () => NotionPage },
) {
  const seen = {
    starts: 0,
    exchanges: [] as { code: string; state: string; pageUrl: string }[],
    authorizeUrls: [] as string[],
    pulls: [] as { token: string; source?: string }[],
  };
  const json = (route: Route, status: number, body: unknown) =>
    route.fulfill({
      status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
      body: JSON.stringify(body),
    });

  await context.route("**/api/authoring/notion-oauth", (route) =>
    json(route, 200, { data: { enabled: options.enabled() } }),
  );
  await context.route("**/api/authoring/notion-oauth/start", (route) => {
    seen.starts += 1;
    const authorizeUrl = `${AUTHORIZE}?client_id=e2e&response_type=code&owner=user&redirect_uri=${encodeURIComponent("https://wave.example/write/notion/oauth/callback")}&state=${encodeURIComponent(STATE)}`;
    return json(route, 200, {
      data: { authorizeUrl, state: STATE, expiresInSeconds: 600 },
    });
  });
  await context.route("**/api/authoring/notion-oauth/exchange", (route) => {
    const body = route.request().postDataJSON() as {
      code: string;
      state: string;
    };
    // The page that sent the exchange has already cleared its address bar.
    seen.exchanges.push({ ...body, pageUrl: route.request().frame().url() });
    return json(route, 200, {
      data: { accessToken: OAUTH_TOKEN, workspaceName: "E2E 工作区" },
    });
  });
  await context.route(`${AUTHORIZE}**`, (route) => {
    const url = new URL(route.request().url());
    seen.authorizeUrls.push(url.toString());
    const state = url.searchParams.get("state") ?? "";
    const callback = new URL(
      "/write/notion/oauth/callback",
      route.request().headers()["referer"] ??
        process.env.E2E_WEB_URL ??
        "http://127.0.0.1:3000",
    );
    const choice = options.notion();
    if (choice === "stay") {
      // The author is still looking at Notion's page.
      return route.fulfill({
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy":
            "default-src 'none'; script-src 'none'; frame-ancestors 'none'",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
        },
        body: "<!doctype html><title>Notion</title><p>选择页面</p>",
      });
    }
    callback.search =
      choice === "approve"
        ? new URLSearchParams({ code: CODE, state }).toString()
        : new URLSearchParams({ error: "access_denied", state }).toString();
    return route.fulfill({
      status: 302,
      headers: { location: callback.toString() },
    });
  });
  await context.route("**/api/authoring/notion-fetch", (route) => {
    const body = route.request().postDataJSON() as {
      token: string;
      source?: string;
    };
    seen.pulls.push(body);
    return json(route, 200, {
      data: {
        source: { id: "ds-e2e", title: "E2E 授权库" },
        rows: ROWS,
        cursor: null,
      },
    });
  });
  return seen;
}

test("authorizing in a popup fills the token, the callback clears its code, and the pull uses the token like a pasted one", async ({
  page,
  context,
}) => {
  const seen = await mockOAuth(context, {
    enabled: () => true,
    notion: () => "approve",
  });
  await registerThroughForm(page, uniqueEmail("notion-oauth"), "/write/notion");

  await page.getByLabel("数据库链接").fill(LINK);
  const popupOpened = page.waitForEvent("popup");
  await page.getByRole("button", { name: "用 Notion 授权" }).click();
  const popup = await popupOpened;
  // The callback closes its own window once the desk has the token.
  await popup.waitForEvent("close");

  await expect(page.getByText("已通过 Notion 授权：E2E 工作区")).toBeVisible();
  await expect(page.getByText("已连接：E2E 授权库 · 2 个条目")).toBeVisible();

  // Notion was asked for a user-owned authorization carrying the state we started.
  expect(seen.starts).toBe(1);
  expect(new URL(seen.authorizeUrls[0]!).searchParams.get("owner")).toBe(
    "user",
  );
  expect(new URL(seen.authorizeUrls[0]!).searchParams.get("state")).toBe(STATE);
  // The callback exchanged the code once, from a URL that no longer carried it.
  expect(seen.exchanges.map(({ code, state }) => ({ code, state }))).toEqual([
    { code: CODE, state: STATE },
  ]);
  expect(seen.exchanges[0]!.pageUrl).toMatch(
    /\/write\/notion\/oauth\/callback$/,
  );
  // The pull used the authorized token and the link typed before authorizing.
  expect(seen.pulls).toEqual([
    { token: OAUTH_TOKEN, mode: "rows", source: LINK },
  ]);
  await expect(page.getByLabel("Notion 令牌")).toHaveValue(OAUTH_TOKEN);

  // As with a pasted token: memory only, never on the page or in storage, gone on reload.
  await expect(page.locator("body")).not.toContainText(OAUTH_TOKEN);
  const stored = await page.evaluate(() =>
    JSON.stringify([
      { ...localStorage },
      { ...sessionStorage },
      location.href,
      document.cookie,
    ]),
  );
  expect(stored).not.toContain(OAUTH_TOKEN);
  await page.reload({ waitUntil: "load" });
  await expect(page.getByLabel("Notion 令牌")).toHaveValue("");
});

test("a refusal in Notion, a cancelled wait and an unconfigured instance all leave pasting a token as it was", async ({
  page,
  context,
}) => {
  let enabled = true;
  let notion: NotionPage = "deny";
  const seen = await mockOAuth(context, {
    enabled: () => enabled,
    notion: () => notion,
  });
  await registerThroughForm(
    page,
    uniqueEmail("notion-oauth-refused"),
    "/write/notion",
  );

  // Refused on Notion's page: the callback tells the desk, and nothing is exchanged.
  let popupOpened = page.waitForEvent("popup");
  await page.getByRole("button", { name: "用 Notion 授权" }).click();
  let popup = await popupOpened;
  await expect(page.getByRole("alert")).toContainText("你在 Notion 取消了授权");
  await expect(popup.getByRole("alert")).toContainText(
    "你在 Notion 取消了授权",
  );
  expect(popup.url()).not.toContain("access_denied");
  await popup.close();
  expect(seen.exchanges).toHaveLength(0);
  await expect(page.getByLabel("Notion 令牌")).toHaveValue("");

  // Still on Notion's page: the desk waits, and 取消授权 stops waiting. The desk cut
  // the popup's opener, so it may not be able to close the window; the author can.
  notion = "stay";
  popupOpened = page.waitForEvent("popup");
  await page.getByRole("button", { name: "用 Notion 授权" }).click();
  popup = await popupOpened;
  await expect(
    page.getByRole("button", { name: "等待 Notion 授权…" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "连接并读取条目" }),
  ).toBeDisabled();
  await expect(page.getByText("取消后可以直接关掉那个窗口")).toBeVisible();
  // The popup never had a handle on the desk.
  expect(await popup.evaluate(() => window.opener === null)).toBe(true);
  await page.getByRole("button", { name: "取消授权" }).click();
  await expect(
    page.getByRole("button", { name: "用 Notion 授权" }),
  ).toBeEnabled();
  if (!popup.isClosed()) await popup.close();
  await expect(page.getByRole("alert")).toHaveCount(0);

  // An instance without the OAuth settings offers no button; the paste steps remain.
  enabled = false;
  await page.reload({ waitUntil: "load" });
  await expect(page.getByLabel("Notion 令牌")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "用 Notion 授权" }),
  ).toHaveCount(0);
  expect(seen.pulls).toHaveLength(0);
});
