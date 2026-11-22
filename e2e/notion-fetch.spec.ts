import { expect, type Page, type Route } from "@playwright/test";
import { test } from "./support/csp-fixture.ts";
import { registerThroughForm, uniqueEmail } from "./support/accounts.ts";
import { mockNotionImport, titleOf } from "./support/notion-import-mock.ts";

/**
 * Pulling a Notion database straight into the import (ADR 0052).
 *
 * What this file can see that the unit layers cannot: that the desk's default tab
 * takes a pasted token and a link, lists the rows, reads blocks only for the
 * pages left selected, and hands the result to the same dry run and confirm as an
 * uploaded file — and that the token never travels anywhere but the pull.
 *
 * Both endpoints are stood in for. The pull must never reach api.notion.com from a
 * test, and the import is throttled (see support/notion-import-mock.ts); what the
 * API does with a pull is covered by notion-fetch.integration.test.ts.
 */

const TOKEN = "ntn_E2E_ONLY_not_a_real_secret_0123456789";
const LINK = "https://www.notion.so/me/Works-0123456789abcdef0123456789abcdef?v=ffffffffffffffffffffffffffffffff";

const title = (text: string) => ({ Name: { type: "title", title: [{ plain_text: text, type: "text", text: { content: text, link: null }, href: null,
  annotations: { bold: false, italic: false, underline: false, strikethrough: false, code: false, color: "default" } }] } });
const paragraph = (id: string, text: string) => ({ object: "block", id, type: "paragraph", has_children: false,
  paragraph: { rich_text: [{ type: "text", plain_text: text, href: null, text: { content: text, link: null },
    annotations: { bold: false, italic: false, underline: false, strikethrough: false, code: false, color: "default" } }], color: "default" } });

const ROWS = [
  { id: "11111111-1111-4111-8111-111111111111", properties: title("拉取的第一篇") },
  { id: "22222222-2222-4222-8222-222222222222", properties: title("拉取的第二篇") },
  { id: "33333333-3333-4333-8333-333333333333", properties: title("不想导入的一篇") },
];

type FetchBody = { token: string; mode: "rows" | "pages"; source?: string; cursor?: string; pageIds?: string[] };
type Answer = { status: number; headers?: Record<string, string>; body: unknown };

/** Stand in for `POST /api/authoring/notion-fetch`; `respond` may override any call. */
async function mockNotionFetch(page: Page, respond: (body: FetchBody, call: number) => Answer | null = () => null): Promise<FetchBody[]> {
  const seen: FetchBody[] = [];
  await page.route("**/api/authoring/notion-fetch", async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as FetchBody;
    const call = seen.push(body);
    const answer = respond(body, call) ?? (body.mode === "rows"
      ? { status: 200, body: { data: { source: { id: "ds-e2e", title: "E2E 作品库" }, rows: ROWS, cursor: null } } }
      : { status: 200, body: { data: { pages: (body.pageIds ?? []).map((id) => ({ id, blocks: [paragraph(`b-${id}`, `正文 ${id.slice(0, 4)}`)] })), issues: [], done: body.pageIds ?? [] } } });
    return route.fulfill({ status: answer.status, headers: { "content-type": "application/json", ...(answer.headers ?? {}) }, body: JSON.stringify(answer.body) });
  });
  return seen;
}

async function connect(page: Page, token = TOKEN) {
  await expect(page.getByRole("tab", { name: "连接 Notion 直接拉取" })).toHaveAttribute("aria-selected", "true");
  await page.getByLabel("集成令牌").fill(token);
  await page.getByLabel("数据库链接").fill(LINK);
  await page.getByRole("button", { name: "连接并读取条目" }).click();
}

test("a pasted token lists the rows, reads only the selected pages, and goes through the same plan and confirm", async ({ page }) => {
  await registerThroughForm(page, uniqueEmail("notion-fetch"), "/write/notion");
  const pulls = await mockNotionFetch(page);
  const imports = await mockNotionImport(page);

  // A password field the browser does not offer to remember.
  const tokenField = page.getByLabel("集成令牌");
  await expect(tokenField).toHaveAttribute("type", "password");
  await expect(tokenField).toHaveAttribute("autocomplete", "off");

  await connect(page);
  await expect(page.getByText("已连接：E2E 作品库 · 3 个条目")).toBeVisible();
  await expect(page.getByText("已选 3 / 3 页")).toBeVisible();
  // Listing reads no page bodies.
  expect(pulls.map((body) => body.mode)).toEqual(["rows"]);

  await page.getByRole("checkbox", { name: "不想导入的一篇" }).uncheck();
  await page.getByRole("button", { name: "试跑所选文章" }).click();
  await expect(page.getByText(/计划：新建 2 件/)).toBeVisible();

  // Blocks were read for the two selected pages only, and the plan carries them.
  expect(pulls.map((body) => body.mode)).toEqual(["rows", "pages"]);
  expect(pulls[1]!.pageIds).toEqual([ROWS[0]!.id, ROWS[1]!.id]);
  expect(pulls.every((body) => body.token === TOKEN)).toBe(true);
  expect(imports).toHaveLength(1);
  expect(imports[0]!.bundle.pages.map(titleOf)).toEqual(["拉取的第一篇", "拉取的第二篇"]);
  expect(imports[0]!.bundle.pages.every((pageInBundle) => pageInBundle.blocks.length === 1)).toBe(true);

  // Nothing is written before the explicit confirm, and the confirm writes the plan.
  await page.getByRole("button", { name: /确认导入（写入 2 件作品）/ }).click();
  await expect(page.getByText(/已导入：新建 2 件/)).toBeVisible();
  expect(imports.map((request) => request.apply === true)).toEqual([false, true]);
  // The token is for the pull only: no import request carries it.
  expect(JSON.stringify(imports)).not.toContain(TOKEN);
  // A second dry run would not read the same pages again.
  expect(pulls.filter((body) => body.mode === "pages")).toHaveLength(1);
});

test("Notion's refusals name the step to fix, and a mistyped token never leaves the browser", async ({ page }) => {
  await registerThroughForm(page, uniqueEmail("notion-fetch-refused"), "/write/notion");
  let refusal: Answer = { status: 422, body: { error: { code: "NOTION_TOKEN_INVALID", message: "Notion did not accept this integration token." } } };
  const pulls = await mockNotionFetch(page, () => refusal);

  await connect(page, "sk-this-is-not-a-notion-token-0123");
  await expect(page.getByRole("alert")).toContainText("这不像 Notion 集成令牌");
  expect(pulls).toHaveLength(0);

  await connect(page);
  await expect(page.getByRole("alert")).toContainText("Notion 不接受这个令牌");

  refusal = { status: 422, body: { error: { code: "NOTION_NOT_SHARED", message: "not shared" } } };
  await page.getByRole("button", { name: "连接并读取条目" }).click();
  await expect(page.getByRole("alert")).toContainText("「连接」里添加你的集成");
  // No refusal repeats the token on the page.
  await expect(page.locator("body")).not.toContainText(TOKEN);

  // The token lives in the page's memory only: nothing in storage or the URL, and
  // gone after a reload.
  const stored = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }, location.href, document.cookie]));
  expect(stored).not.toContain(TOKEN);
  await page.reload({ waitUntil: "load" });
  await expect(page.getByLabel("集成令牌")).toHaveValue("");
});

test("an oversized page is named and left out, and a rate limit is waited out by itself", async ({ page }) => {
  await registerThroughForm(page, uniqueEmail("notion-fetch-limits"), "/write/notion");
  const pulls = await mockNotionFetch(page, (body, call) => {
    if (body.mode !== "pages") return null;
    // The first slice is throttled; the desk waits the Retry-After and asks again.
    if (call === 2) return { status: 429, headers: { "retry-after": "1" }, body: { error: { code: "NOTION_RATE_LIMITED", message: "slow down" } } };
    const ids = body.pageIds ?? [];
    return { status: 200, body: { data: {
      pages: ids.filter((id) => id !== ROWS[1]!.id).map((id) => ({ id, blocks: [paragraph(`b-${id}`, "正文")] })),
      issues: ids.includes(ROWS[1]!.id) ? [{ id: ROWS[1]!.id, code: "too-many-blocks" }] : [],
      done: ids,
    } } };
  });
  const imports = await mockNotionImport(page);

  await connect(page);
  await expect(page.getByText("已选 3 / 3 页")).toBeVisible();
  await page.getByRole("button", { name: "试跑所选文章" }).click();
  await expect(page.getByText(/秒后自动继续/)).toBeVisible();
  await expect(page.getByText(/计划：新建 2 件/)).toBeVisible();

  // Nothing is lost silently: the page Notion could not give whole is named, with why.
  await expect(page.getByText(/以下 1 页没有从 Notion 读到正文.*《拉取的第二篇》（超过 2000 个块/)).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "拉取的第二篇" })).not.toBeChecked();
  expect(imports[0]!.bundle.pages.map(titleOf)).toEqual(["拉取的第一篇", "不想导入的一篇"]);
  expect(pulls.filter((body) => body.mode === "pages").map((body) => body.pageIds?.length)).toEqual([3, 3]);
});
