import { expect, type Page, type Route } from "@playwright/test";
import { test } from "./support/csp-fixture.ts";
import { registerThroughForm, uniqueEmail } from "./support/accounts.ts";
import { mockNotionImport, titleOf, type MockImportRequest } from "./support/notion-import-mock.ts";

/**
 * The optional "fill a missing Date from the creation date" choice (P2).
 *
 * What only the browser can show: the choice is off unless the author ticks it;
 * ticking it changes what the dry run sends — only the published pages without a
 * Date — and every page it filled is named before the confirm; unticking it and
 * planning again sends the author's own properties. Both the pull and the import
 * are stood in for: no test reaches api.notion.com, and the import is throttled
 * (see support/notion-import-mock.ts).
 */

const TOKEN = "ntn_E2E_ONLY_not_a_real_secret_0123456789";
const LINK = "https://www.notion.so/me/Works-0123456789abcdef0123456789abcdef";

const title = (text: string) => ({ type: "title", title: [{ plain_text: text, type: "text", text: { content: text, link: null }, href: null,
  annotations: { bold: false, italic: false, underline: false, strikethrough: false, code: false, color: "default" } }] });
const checkbox = (value: boolean) => ({ type: "checkbox", checkbox: value });

// Noon UTC: the same calendar day in every timezone the browser might run in.
const ROWS = [
  { id: "11111111-1111-4111-8111-111111111111", createdTime: "2023-03-15T12:00:00.000Z", properties: { Name: title("没有日期的旧作"), Published: checkbox(true), Date: { type: "date", date: null } } },
  { id: "22222222-2222-4222-8222-222222222222", createdTime: "2023-04-01T12:00:00.000Z", properties: { Name: title("自己写了日期的"), Published: checkbox(true), Date: { type: "date", date: { start: "2020-01-02" } } } },
  { id: "33333333-3333-4333-8333-333333333333", createdTime: "2023-05-01T12:00:00.000Z", properties: { Name: title("还是草稿的"), Published: checkbox(false) } },
];

async function mockPull(page: Page): Promise<void> {
  await page.route("**/api/authoring/notion-fetch", async (route: Route) => {
    const body = route.request().postDataJSON() as { mode: string; pageIds?: string[] };
    const data = body.mode === "rows"
      ? { source: { id: "ds-e2e", title: "E2E 作品库" }, rows: ROWS, cursor: null }
      : { pages: (body.pageIds ?? []).map((id) => ({ id, blocks: [] })), issues: [], done: body.pageIds ?? [] };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data }) });
  });
}

const dateOf = (request: MockImportRequest, name: string) =>
  (request.bundle.pages.find((p) => titleOf(p) === name)?.properties.Date as { date?: { start?: string } | null } | undefined)?.date?.start ?? null;

test("a pulled database fills only the published pages without a Date, and only when the author asks", async ({ page }) => {
  await registerThroughForm(page, uniqueEmail("notion-date"), "/write/notion");
  await mockPull(page);
  const imports = await mockNotionImport(page);

  await page.getByLabel("Notion 令牌").fill(TOKEN);
  await page.getByLabel("数据库链接").fill(LINK);
  await page.getByRole("button", { name: "连接并读取条目" }).click();
  await expect(page.getByText("已选 3 / 3 页")).toBeVisible();

  const choice = page.getByRole("checkbox", { name: "用 Notion 创建日期补上缺失的 Date" });
  await expect(choice).not.toBeChecked();
  await expect(page.getByText(/所选页面中有 1 页已发布但没有 Date/)).toBeVisible();

  // Off: what is sent is what Notion holds.
  await page.getByRole("button", { name: "试跑所选文章" }).click();
  await expect(page.getByText(/计划：新建 3 件/)).toBeVisible();
  expect(dateOf(imports[0]!, "没有日期的旧作")).toBeNull();
  await expect(page.getByText(/已用创建日期补/)).toHaveCount(0);

  // On: the choice drops the old plan, and the next one fills one page and names it.
  await choice.check();
  await expect(page.getByText(/计划：新建 3 件/)).toHaveCount(0);
  await page.getByRole("button", { name: "试跑所选文章" }).click();
  await expect(page.getByText(/计划：新建 3 件/)).toBeVisible();
  const sent = imports[1]!;
  expect(dateOf(sent, "没有日期的旧作")).toBe("2023-03-15T00:00:00.000Z");
  expect(dateOf(sent, "自己写了日期的")).toBe("2020-01-02");
  expect(dateOf(sent, "还是草稿的")).toBeNull();
  await expect(page.getByText("以下 1 页已发布但没有 Date，已按你的选择用创建日期补上", { exact: false })).toContainText("《没有日期的旧作》→ 2023-03-15");
  await expect(page.locator(".nw-import-page", { hasText: "没有日期的旧作" })).toContainText("Date 为空，已用创建日期补为 2023-03-15。");
  await expect(page.locator(".nw-import-page", { hasText: "自己写了日期的" })).not.toContainText("创建日期");

  // The confirm writes exactly what was planned.
  await page.getByRole("button", { name: /确认导入（写入 3 件作品）/ }).click();
  await expect(page.getByText(/已导入：新建 3 件/)).toBeVisible();
  expect(imports[2]!.apply).toBe(true);
  expect(imports[2]!.bundle).toEqual(sent.bundle);
  // Creation instants are metadata for the desk, never part of what is imported.
  expect(JSON.stringify(imports)).not.toContain("createdTime");
});

test("an export's 创建时间 column offers the same choice, and unticking it sends the author's own properties", async ({ page }) => {
  await registerThroughForm(page, uniqueEmail("notion-date-file"), "/write/notion");
  const imports = await mockNotionImport(page);
  await page.getByRole("tab", { name: "上传导出文件" }).click();
  await page.locator("#notion-bundle-file").setInputFiles([
    { name: "旧作 0123456789abcdef0123456789abcdef.md", mimeType: "text/markdown", buffer: Buffer.from("# 旧作\n\nPublished: Yes\n\n正文") },
    { name: "作品库 fedcba9876543210fedcba9876543210_all.csv", mimeType: "text/csv", buffer: Buffer.from("Name,创建时间,Published\n旧作,2022年7月9日 21:15,Yes\n") },
  ]);
  const choice = page.getByRole("checkbox", { name: "用 Notion 创建日期补上缺失的 Date" });
  await choice.check();
  await page.getByRole("button", { name: "试跑所选文章" }).click();
  await expect(page.locator(".nw-import-page", { hasText: "旧作" })).toContainText("已用创建日期补为 2022-07-09");
  expect(dateOf(imports[0]!, "旧作")).toBe("2022-07-09T00:00:00.000Z");

  await choice.uncheck();
  await page.getByRole("button", { name: "试跑所选文章" }).click();
  await expect(page.getByText(/计划：新建 1 件/)).toBeVisible();
  expect(dateOf(imports[1]!, "旧作")).toBeNull();
  await expect(page.getByText(/已用创建日期补/)).toHaveCount(0);
});
