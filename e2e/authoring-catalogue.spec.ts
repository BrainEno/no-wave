import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { createSqliteClient } from "../apps/api/src/persistence/sqlite.ts";
import { createSqliteStore } from "../apps/api/src/persistence/sqlite-store.ts";
import { test } from "./support/article-view-stack.ts";
import { BROWSER_PASSWORD, registerThroughForm, uniqueEmail } from "./support/accounts.ts";
import type { FontStack } from "./support/font-stack.ts";

const OLD_TITLE = "旧作000";
async function ready(page: Page) {
  await expect(page.getByRole("status").filter({ hasText: "正在读取目录元数据" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "刷新当前页", exact: true })).toBeEnabled();
}
async function setup(page: Page, stack: FontStack, count = 2) {
  await registerThroughForm(page, uniqueEmail("catalogue"), "/write/library");
  await ready(page);
  const session = await page.request.get("/api/authoring/session");
  expect(session.status()).toBe(200);
  const actor = (await session.json()).data.id as string;
  const db = createSqliteClient({ filename: stack.databasePath });
  const store = createSqliteStore(db);
  const records = [];
  try {
    // Seed through the real SQLite adapter: a 106-work browsing fixture must not
    // raise the production API's 30/IP/hour creation limit or consume other journeys' budget.
    for (let index = 0; index < count; index++) records.push(await store.createArticle({ authorId: actor, slug: `catalogue-${index}`, title: index === 0 ? OLD_TITLE : index === count - 1 ? "=SUM(1)" : `目录${String(index).padStart(3, "0")}`,
      summary: index === 0 ? "literal %_ only" : `元数据摘要 ${index}`, locale: "zh-CN", publish: index % 2 === 0, workType: index % 2 === 0 ? "other" : "poetry",
      contentBlocks: [{ id: "p1", type: "paragraph", text: `CATALOGUE-PRIVATE-BODY-${index}` }] }));
    const first = records[0]!;
    for (const locale of ["en", "zh-TW"]) await store.updateArticle({ actorId: actor, articleId: first.id, slug: first.slug, title: locale === "en" ? "Old English edition" : "繁體舊作", summary: locale === "en" ? "English synopsis" : "繁體摘要", locale, publish: true, workType: "other", contentBlocks: [{ id: "p1", type: "paragraph", text: `EXACT-${locale}-PRIVATE-BODY` }] });
    await store.createArticle({ authorId: `outsider-${randomUUID()}`, slug: "other-account-private", title: "OTHER-ACCOUNT-PRIVATE-TITLE", contentBlocks: [{ id: "p1", type: "paragraph", text: "OTHER-PRIVATE-BODY" }] });
    for (const [index, work] of records.entries()) {
      const stamp = new Date(Date.UTC(2026, 0, 1) + index * 86_400_000).toISOString();
      db.prepare("UPDATE articles SET created_at = ?, updated_at = ? WHERE id = ?").run(stamp, stamp, work.id);
      db.prepare("UPDATE article_translations SET created_at = ?, updated_at = ? WHERE article_id = ?").run(stamp, stamp, work.id);
    }
  } finally { db.close(); }
  await page.getByRole("button", { name: "刷新当前页", exact: true }).click();
  await ready(page);
  await expect(page.getByRole("heading", { name: `在用作品 · ${count + 2} 个语言版本 / ${count} 部作品`, exact: true })).toBeVisible();
  return { actor, records };
}
async function search(page: Page, q: string) {
  await page.getByLabel("标题或摘要", { exact: true }).fill(q);
  await page.getByRole("button", { name: "检索目录", exact: true }).click();
  await ready(page);
}
async function csvDownload(page: Page): Promise<string> {
  const event = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出所选 CSV 元数据", exact: true }).click();
  const download = await event;
  expect(download.suggestedFilename()).toMatch(/^no-wave-.*-metadata\.csv$/);
  return readFile((await download.path())!, "utf8");
}

test("the real lightweight catalogue pages beyond 100, keeps selection across pages and exports only protected chosen metadata", async ({ page, readingStack }) => {
  const { records } = await setup(page, readingStack, 106);
  const oldList = await page.request.get("/api/authoring/articles?allLocales=true");
  expect((await oldList.json()).data.some((entry: { id: string; locale: string }) => entry.id === records[0]!.id && entry.locale === "zh-CN")).toBe(false);
  await page.getByLabel("每页版本数").selectOption("10");
  await page.getByRole("button", { name: "检索目录", exact: true }).click(); await ready(page);
  const rows = page.getByRole("list", { name: "目录条目", exact: true });
  const first = rows.getByRole("checkbox").first(); const firstName = await first.getAttribute("aria-label");
  await first.check();
  await page.getByRole("button", { name: "下一页", exact: true }).click(); await ready(page);
  await expect(page.getByText("已浏览第 2 页", { exact: true })).toBeVisible();
  await rows.getByRole("checkbox").first().check();
  await expect(page.getByText(/已选 2 \/ 100/)).toBeVisible();
  await page.getByRole("button", { name: "上一页", exact: true }).click(); await ready(page);
  await expect(page.getByRole("checkbox", { name: firstName!, exact: true })).toBeChecked();
  await search(page, "literal %_");
  await expect(page.getByRole("heading", { name: "在用作品 · 1 个语言版本 / 1 部作品", exact: true })).toBeVisible();
  await expect(page.getByText(/已选 0 \/ 100/)).toBeVisible();
  expect(new URL(page.url()).search).toBe("");
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain("literal %_");
  await search(page, "=SUM(1)");
  await rows.getByRole("checkbox").check();
  await page.getByText("CSV 导出设置与安全预览", { exact: true }).click();
  await expect(page.getByText(/有 1 个单元格需要安全处理/)).toBeVisible();
  const csv = await csvDownload(page);
  expect(csv).toContain('"\'=SUM(1)"');
  expect(csv).not.toContain("CATALOGUE-PRIVATE-BODY");
  expect(csv).not.toContain("revision");
  expect(await page.locator("main").innerText()).not.toContain("OTHER-ACCOUNT-PRIVATE-TITLE");
});

test("an older exact language opens from the catalogue, saves the same id and keeps dirty-navigation protection", async ({ page, readingStack }) => {
  const { records } = await setup(page, readingStack, 106);
  await search(page, OLD_TITLE);
  await page.getByRole("button", { name: "查看语言版本", exact: true }).click();
  const versions = page.getByRole("region", { name: "语言版本预览", exact: true });
  await expect(versions).toContainText("English synopsis");
  await expect(versions).toContainText("繁體摘要");
  await expect(versions.getByRole("heading", { name: "English · 已有版本", exact: true })).toBeVisible();
  await versions.getByRole("link", { name: "打开English版本", exact: true }).click();
  await expect(page.getByLabel("标题", { exact: true })).toHaveValue("Old English edition");
  await expect(page.getByRole("combobox", { name: "作品语言", exact: true })).toHaveValue("en");
  await expect(page.getByLabel("作品正文")).toHaveText("EXACT-en-PRIVATE-BODY");
  await page.getByLabel("标题", { exact: true }).fill("English edited through catalogue");
  await page.getByRole("button", { name: "保存更新", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "作品已发布。" })).toBeVisible();
  const own = await page.request.get(`/api/authoring/catalogue/${records[0]!.id}?locale=en`, { headers: { "x-expected-author": (await (await page.request.get("/api/authoring/session")).json()).data.id } });
  expect(own.status()).toBe(200);
  expect((await own.json()).data).toMatchObject({ id: records[0]!.id, locale: "en", title: "English edited through catalogue", status: "published" });
  await page.getByLabel("作品正文").fill("Later unsaved input");
  await page.getByRole("link", { name: "全部作品目录", exact: true }).first().click();
  const leave = page.getByRole("dialog", { name: "离开未保存的文稿？", exact: true });
  await expect(leave).toBeVisible(); await leave.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByLabel("作品正文")).toHaveText("Later unsaved input");
});

test("a late exact-detail read cannot overwrite subsequent typing and a cancelled document confirmation keeps the current draft", async ({ page, readingStack }) => {
  await setup(page, readingStack);
  await search(page, OLD_TITLE);
  let release!: () => void, observed!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { observed = resolve; });
  await page.route("**/api/authoring/catalogue/*?locale=*", async route => { const response = await route.fetch(); observed(); await held; await route.fulfill({ response }); });
  await page.getByRole("link", { name: `编辑《${OLD_TITLE}》`, exact: true }).click();
  await requested;
  await expect(page.getByLabel("作品正文")).toHaveAttribute("contenteditable", "true");
  await page.getByLabel("标题", { exact: true }).fill("Later new input");
  await page.getByLabel("作品正文").fill("Do not replace this paragraph");
  release();
  await expect(page.getByRole("status").filter({ hasText: "读取期间文稿或保存状态已变化" })).toBeVisible();
  await expect(page.getByLabel("标题", { exact: true })).toHaveValue("Later new input");
  await page.getByRole("button", { name: "重新读取目录所选版本", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "放弃未保存的修改？", exact: true });
  await expect(dialog).toBeVisible(); await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByLabel("作品正文")).toHaveText("Do not replace this paragraph");
});

test("trash restoration requires an all-language confirmation and a failed request is never fabricated as success or replayed", async ({ page, readingStack }) => {
  const { actor, records } = await setup(page, readingStack);
  const db = createSqliteClient({ filename: readingStack.databasePath });
  try { await createSqliteStore(db).deleteArticle({ actorId: actor, articleId: records[0]!.id }); } finally { db.close(); }
  await page.getByLabel("目录范围").selectOption("trash"); await page.getByRole("combobox", { name: "语言", exact: true }).selectOption("en");
  await page.getByRole("button", { name: "检索目录", exact: true }).click(); await ready(page);
  const restore = page.getByRole("button", { name: "还原《Old English edition》", exact: true });
  await restore.click(); const dialog = page.getByRole("dialog", { name: "还原这部作品？", exact: true });
  await expect(dialog).toContainText("全部已有语言版本");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  let posts = 0;
  await page.route("**/api/authoring/catalogue/*/restore?locale=*", async route => { posts++; await route.fulfill({ status: 503, contentType: "application/json", body: "{}" }); });
  await restore.click(); await dialog.getByRole("button", { name: "还原全部语言为草稿", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("还原请求未获成功确认");
  await page.getByRole("button", { name: "刷新当前页", exact: true }).click(); await ready(page);
  expect(posts).toBe(1);
  await page.unroute("**/api/authoring/catalogue/*/restore?locale=*");
  await restore.click(); await dialog.getByRole("button", { name: "还原全部语言为草稿", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "已还原为草稿" })).toBeVisible();
  const editions = await page.request.get(`/api/authoring/catalogue/${records[0]!.id}/editions?scope=active`, { headers: { "x-expected-author": actor } });
  expect((await editions.json()).data.map((entry: { status: string }) => entry.status)).toEqual(["draft", "draft", "draft"]);
  await expect(page.getByRole("heading", { name: "回收站 · 0 个语言版本 / 0 部作品", exact: true })).toBeVisible();
});

test("撤销发布 and 删除 from a catalogue row act on the whole work, refuse a stale revision and leave focus on the result", async ({ page, readingStack }) => {
  const { actor, records } = await setup(page, readingStack);
  const published = records[0]!;
  await expect(page.getByRole("button", { name: "撤销发布《=SUM(1)》", exact: true }), "a draft has nothing to withdraw").toHaveCount(0);
  const withdraw = page.getByRole("button", { name: `撤销发布《${OLD_TITLE}》`, exact: true });
  const dialog = page.getByRole("dialog", { name: "撤销发布这部作品？", exact: true });
  // Another window saves the work while this one is deciding: the catalogue's
  // withdraw reads the edition first, so the save after it is refused, not overwritten.
  let writes = 0;
  await page.route(`**/api/authoring/articles/${published.id}`, async route => {
    writes++;
    const db = createSqliteClient({ filename: readingStack.databasePath });
    try { await createSqliteStore(db).updateArticle({ actorId: actor, articleId: published.id, slug: published.slug, title: OLD_TITLE, summary: "另一窗口的修改", locale: "zh-CN", publish: true, workType: "other", contentBlocks: [{ id: "p1", type: "paragraph", text: "CATALOGUE-PRIVATE-BODY-0" }] }); } finally { db.close(); }
    await route.continue();
  });
  await withdraw.click(); await expect(dialog).toContainText("所有语言版本会转为草稿");
  await dialog.getByRole("button", { name: "撤销发布全部语言", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("又被修改过，没有撤销发布");
  expect(writes).toBe(1);
  await page.unroute(`**/api/authoring/articles/${published.id}`);
  await page.getByRole("button", { name: "刷新当前页", exact: true }).click(); await ready(page);
  await withdraw.click(); await dialog.getByRole("button", { name: "撤销发布全部语言", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: `《${OLD_TITLE}》已撤销发布` })).toBeVisible();
  const editions = await page.request.get(`/api/authoring/catalogue/${published.id}/editions?scope=active`, { headers: { "x-expected-author": actor } });
  expect((await editions.json()).data.map((entry: { status: string }) => entry.status)).toEqual(["draft", "draft", "draft"]);
  const kept = await page.request.get(`/api/authoring/catalogue/${published.id}?locale=zh-CN`, { headers: { "x-expected-author": actor } });
  expect((await kept.json()).data).toMatchObject({ summary: "另一窗口的修改", contentBlocks: [{ text: "CATALOGUE-PRIVATE-BODY-0" }] });

  await page.getByRole("button", { name: "删除《=SUM(1)》", exact: true }).click();
  const remove = page.getByRole("dialog", { name: "删除这部作品？", exact: true });
  await remove.getByRole("button", { name: "删除全部语言", exact: true }).click();
  // The row (and the button that opened the dialog) is gone; focus is on the result, not the page's skip link.
  const outcome = page.locator(".nw-authoring-outcome");
  await expect(outcome).toContainText("《=SUM(1)》已删除（全部语言版本），可在回收站还原");
  await expect(outcome).toBeFocused();
  await expect(page.getByRole("button", { name: "删除《=SUM(1)》", exact: true })).toHaveCount(0);
  await page.getByLabel("目录范围").selectOption("trash");
  await page.getByRole("button", { name: "检索目录", exact: true }).click(); await ready(page);
  await expect(page.getByRole("button", { name: "还原《=SUM(1)》", exact: true })).toBeVisible();
});

test("selected metadata review shows actual cross-window changes and only an explicit complete acceptance changes the CSV snapshot", async ({ page, readingStack }) => {
  const { actor, records } = await setup(page, readingStack);
  await search(page, OLD_TITLE);
  await page.getByRole("list", { name: "目录条目", exact: true }).getByRole("checkbox").check();
  const db = createSqliteClient({ filename: readingStack.databasePath });
  try { await createSqliteStore(db).updateArticle({ actorId: actor, articleId: records[0]!.id, slug: records[0]!.slug, locale: "zh-CN", title: OLD_TITLE, summary: "核对后的摘要", contentBlocks: [{ id: "p1", type: "paragraph", text: "CATALOGUE-PRIVATE-BODY-0" }], publish: false, workType: "other" }); } finally { db.close(); }
  await page.getByText("下载前只读核对与差异审核", { exact: true }).click();
  await page.getByRole("button", { name: "只读核对所选版本", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "1 个所选版本有差异" })).toBeVisible();
  const before = await csvDownload(page); expect(before).toContain("literal %_ only"); expect(before).not.toContain("核对后的摘要");
  await page.getByRole("button", { name: "用完整核对结果更新所选索引", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "已用成功核对的元数据更新所选索引" })).toBeVisible();
  const after = await csvDownload(page); expect(after).toContain("核对后的摘要"); expect(after).not.toContain("CATALOGUE-PRIVATE-BODY");
  await page.getByText("CSV 导出设置与安全预览", { exact: true }).click();
  await page.getByRole("button", { name: "不含摘要简表", exact: true }).click();
  const reduced = await csvDownload(page); expect(reduced).not.toContain("摘要"); expect(reduced).toContain(OLD_TITLE);
  await page.getByText("核对所选清单：1 个版本 / 1 部作品", { exact: true }).click();
  await page.getByRole("button", { name: `移除所选《${OLD_TITLE}》简体中文`, exact: true }).click();
  await expect(page.getByText(/已选 0 \/ 100/)).toBeVisible();
});

test("the narrow catalogue is accessible and hides private state before BFCache capture; focus detects an actual account switch", async ({ page, readingStack }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page, readingStack);
  await search(page, OLD_TITLE);
  await page.getByRole("list", { name: "目录条目", exact: true }).getByRole("checkbox").check();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  expect((await new AxeBuilder({ page }).include("main").analyze()).violations).toEqual([]);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  await expect(page.getByLabel("标题或摘要", { exact: true })).toHaveValue("");
  await expect(page.getByRole("list", { name: "目录条目", exact: true })).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await ready(page);
  await expect(page.getByText(/已选 0 \/ 100/)).toBeVisible();
  const registration = await page.request.post("/api/auth/register", { headers: { origin: readingStack.webBaseUrl }, data: { email: uniqueEmail("catalogue-switched"), password: BROWSER_PASSWORD } });
  expect(registration.status(), await registration.text()).toBe(201);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("alert")).toContainText("登录账户已改变");
  await expect(page.getByRole("list", { name: "目录条目", exact: true })).toHaveCount(0);
});

test("CSV download revalidates the actual session without relying on focus and refuses a switched account's old selection", async ({ page, readingStack }) => {
  await setup(page, readingStack);
  await search(page, OLD_TITLE);
  await page.getByRole("list", { name: "目录条目", exact: true }).getByRole("checkbox").check();
  const downloads: string[] = [];
  page.on("download", download => downloads.push(download.suggestedFilename()));
  const switched = await page.request.post("/api/auth/register", { headers: { origin: readingStack.webBaseUrl }, data: { email: uniqueEmail("csv-switched"), password: BROWSER_PASSWORD } });
  expect(switched.status(), await switched.text()).toBe(201);
  await page.getByRole("button", { name: "导出所选 CSV 元数据", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "登录账户已改变" })).toBeVisible();
  await expect(page.getByRole("list", { name: "目录条目", exact: true })).toHaveCount(0);
  expect(downloads).toEqual([]);
});
