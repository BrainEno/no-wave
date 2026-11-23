import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { createWritingBackup, parseWritingBackup } from "../packages/web-ui/src/lib/writing-backup.ts";
import { createWritingCollection, parseWritingCollection } from "../packages/web-ui/src/lib/writing-collection.ts";
import type { WritingDraft } from "../packages/web-ui/src/lib/writing-session.ts";
import { test } from "./support/article-view-stack.ts";
import { registerThroughForm, uniqueEmail } from "./support/accounts.ts";

const stamp = new Date("2026-11-12T00:00:00.000Z");
function draft(title: string, text = "PRIVATE_BODY 海浪与星光", locale = "zh-CN"): WritingDraft {
  return { title, summary: "PRIVATE_SUMMARY", locale, workType: "other", editorState: { root: { type: "root", version: 1, children: [
    { type: "paragraph", version: 1, children: [{ type: "text", version: 1, text }] },
    { type: "image", version: 1, src: "https://private-image.example.test/NEVER_FETCH.png", alt: "private image label" },
  ] } } };
}
async function collection(drafts: WritingDraft[]) {
  return (await createWritingCollection(drafts.map((item, index) => ({ group: String(index), backup: parseWritingBackup(createWritingBackup(item, stamp)) })), stamp)).text;
}
async function start(page: Page) {
  await page.goto("/write/collections?file=https%3A%2F%2Fprivate-image.example.test%2FNEVER_FETCH.json");
  await expect(page).toHaveURL(/\/write\/collections$/);
  await expect(page.getByRole("heading", { name: "本机文稿集合", exact: true })).toBeVisible();
}
async function load(page: Page, slot: "左侧" | "右侧", text: string, name = "local.json") {
  await page.getByLabel(`${slot}本机备份文件`, { exact: true }).setInputFiles({ name, mimeType: "application/json", buffer: Buffer.from(text) });
  await expect(page.getByRole("region", { name: `${slot}集合来源`, exact: true }).getByRole("status")).toContainText(/结构.*校验/);
}
async function download(page: Page, button: string) {
  const event = page.waitForEvent("download");
  await page.getByRole("button", { name: button, exact: true }).click();
  const file = await event;
  return { name: file.suggestedFilename(), text: await readFile((await file.path())!, "utf8") };
}

test("an anonymous loaded tool works offline, keeps hidden explicit choices, exports a verified subset and never requests embedded media", async ({ page, context }) => {
  const requests: string[] = [];
  page.on("request", request => { if (new URL(request.url()).hostname === "private-image.example.test" || request.method() !== "GET") requests.push(request.url()); });
  await start(page);
  const text = await collection([draft("左稿2"), draft("左稿10", "Another body", "en")]);
  await page.evaluate(() => document.fonts.ready);
  await context.setOffline(true);
  await load(page, "左侧", text, "private-left.json");
  await load(page, "右侧", createWritingBackup(draft("右稿", "Right body"), stamp), "legacy.json");
  await expect(page.getByRole("region", { name: "右侧集合来源" })).toContainText("原文件没有集合摘要");
  await page.getByRole("checkbox", { name: "选择右侧《右稿》d1", exact: true }).check();
  await page.getByRole("checkbox", { name: "选择左侧《左稿2》d1", exact: true }).check();
  await page.getByRole("combobox", { name: "来源文件", exact: true }).selectOption("left");
  await expect(page.getByText(/其中 1 篇被当前筛选隐藏/)).toBeVisible();
  await page.getByRole("button", { name: "校验并准备所选子集合", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "准备完成：2 篇 / 2 组" })).toBeVisible();
  const subset = await download(page, "下载所选子集合");
  const parsed = await parseWritingCollection(subset.text);
  expect(parsed.collection.entries.map(entry => entry.backup.draft.title)).toEqual(["左稿2", "右稿"]);
  expect(parsed.collection.entries.map(entry => entry.group)).toEqual(["w1", "w2"]);
  const single = await download(page, "导出单篇《左稿2》左侧");
  expect(parseWritingBackup(single.text).draft.title).toBe("左稿2");
  await page.getByRole("button", { name: "生成本机引用依赖清单", exact: true }).click();
  const inventory = page.getByRole("region", { name: "集合图片与链接依赖", exact: true });
  await expect(inventory.getByRole("status")).toContainText("3 处 / 1 个地址组");
  await expect(inventory.locator("img,a[href*='private-image.example.test']")).toHaveCount(0);
  await inventory.getByText("只读查看使用处（3）", { exact: true }).click();
  await inventory.getByRole("button", { name: "只读查看引用所在文稿 left:d1", exact: true }).click();
  await expect(page.getByRole("region", { name: "只读文稿《左稿2》", exact: true })).toContainText("PRIVATE_BODY");
  expect(requests).toEqual([]);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain("PRIVATE_BODY");
});

test("literal cross-manuscript search locates a late-block hit without editing, and changed queries invalidate old results", async ({ page }) => {
  await start(page);
  await load(page, "左侧", await collection([draft("Search draft", "开头".repeat(1000) + " unique.x 结尾") ]));
  await page.getByLabel("正文检索文字", { exact: true }).fill("unique.x");
  await page.getByRole("button", { name: "检索本机正文", exact: true }).click();
  const results = page.getByRole("list", { name: "跨文稿正文匹配", exact: true });
  await expect(results.getByRole("listitem")).toHaveCount(1);
  await page.getByRole("button", { name: "只读定位第 1 处匹配", exact: true }).click();
  const context = page.getByLabel("正文检索定位上下文", { exact: true });
  await expect(context.locator("mark")).toHaveText("unique.x");
  await expect(context.locator("..")).toBeFocused();
  await page.getByLabel("正文检索文字", { exact: true }).fill("new query");
  await expect(results).toHaveCount(0);
  expect(await page.locator("[contenteditable='true']").count()).toBe(0);
  await page.getByRole("button", { name: "检索本机正文", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "找到 0 处" })).toBeVisible();
});

test("manual pairing, review plan preview/application and content-free reports never infer identity or auto-restore a manuscript", async ({ page }) => {
  await start(page);
  await load(page, "左侧", await collection([draft("=PRIVATE_TITLE()", "PRIVATE_BODY left"), draft("Unpaired local", "Second")]), "=PRIVATE_FILE().json");
  await load(page, "右侧", await collection([draft("=PRIVATE_TITLE()", "PRIVATE_BODY right")]));
  await expect(page.getByText("已有 0 对；左侧未配对 2 篇，右侧未配对 1 篇。", { exact: true })).toBeVisible();
  await page.getByRole("checkbox", { name: "选择左侧《=PRIVATE_TITLE()》d1", exact: true }).check();
  await page.getByRole("combobox", { name: "左侧文稿", exact: true }).selectOption("left:d1");
  await page.getByRole("combobox", { name: "右侧文稿", exact: true }).selectOption("right:d1");
  await page.getByRole("button", { name: "加入明确配对", exact: true }).click();
  const plan = await download(page, "下载当前核对计划");
  expect(plan.text).not.toMatch(/PRIVATE|Unpaired|title|summary|filename/);
  await page.getByRole("button", { name: "清空子集合选择", exact: true }).click();
  await page.getByRole("button", { name: "移除此配对", exact: true }).click();
  const planInput = page.getByLabel("读取本机核对计划", { exact: true });
  await planInput.setInputFiles({ name: "plan.json", mimeType: "application/json", buffer: Buffer.from(plan.text) });
  await expect(page.getByLabel("核对计划应用预览", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "选择左侧《=PRIVATE_TITLE()》d1", exact: true })).not.toBeChecked();
  await page.getByRole("checkbox", { name: "选择左侧《Unpaired local》d2", exact: true }).check();
  await expect(page.getByLabel("核对计划应用预览", { exact: true })).toHaveCount(0);
  await planInput.setInputFiles({ name: "plan.json", mimeType: "application/json", buffer: Buffer.from(plan.text) });
  await page.getByRole("button", { name: "明确应用预览中的选择与配对", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "选择左侧《=PRIVATE_TITLE()》d1", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "选择左侧《Unpaired local》d2", exact: true })).not.toBeChecked();
  const before = JSON.parse((await download(page, "下载无正文 JSON 报告")).text);
  expect(before.pairs[0].state).toBe("unchecked");
  await page.getByRole("button", { name: "运行只读差异核对", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "全部明确配对已核对完成" })).toBeVisible();
  await page.getByText("《=PRIVATE_TITLE()》 / 《=PRIVATE_TITLE()》 · 有差异", { exact: true }).click();
  await expect(page.getByRole("list", { name: "离线配对正文差异", exact: true }).getByLabel("左侧内容", { exact: true })).toHaveText("lef");
  await expect(page.getByRole("list", { name: "离线配对正文差异", exact: true }).getByLabel("右侧内容", { exact: true })).toHaveText("righ");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  const report = await download(page, "下载无正文 JSON 报告");
  expect(report.text).not.toMatch(/PRIVATE|Unpaired|https:|authorId|revision|token/);
  expect(JSON.parse(report.text).pairs[0]).toMatchObject({ state: "different", limited: false, changes: [{ kind: "changed", leftBlock: 1, rightBlock: 1, formatChanged: false, truncated: false }] });
  expect(JSON.parse(report.text).coverage).toEqual({ documents: 3, pairs: 1, checkedPairs: 1, uncheckedPairs: 0, unpairedDocuments: 1, limitedDocuments: 0, limitedPairs: 0 });
  expect(JSON.parse(report.text).unpaired).toEqual(["left:d2"]);
  await page.getByRole("checkbox", { name: "报告明确包含私密标题与文件名（默认不含）", exact: true }).check();
  const csv = (await download(page, "下载无正文 CSV 报告")).text;
  expect(csv).toContain("'=PRIVATE_TITLE()"); expect(csv).toContain("'=PRIVATE_FILE().json");
  expect(csv).not.toMatch(/PRIVATE_BODY|PRIVATE_SUMMARY|private-image/);
  for (const value of ["coverage", "checkedPairs", "unpairedDocuments", "entries", "codeBlocks", "minutes", "block", "leftBlock", "rightBlock"]) expect(csv).toContain(`"${value}"`);
});

test("duplicate-field ambiguity is rejected before adoption and ordinary underscore-prefixed manuscripts still export a restore-compatible single file", async ({ page }) => {
  await start(page);
  const text = await collection([draft("_PRIVATE_DOWNLOAD")]);
  await page.getByLabel("左侧本机备份文件", { exact: true }).setInputFiles({ name: "ambiguous.json", mimeType: "application/json", buffer: Buffer.from(text.replace('"version":1', '"version":2,"\\u0076ersion":1')) });
  await expect(page.getByRole("region", { name: "左侧集合来源", exact: true }).getByRole("alert")).toContainText("重复或歧义");
  await expect(page.getByRole("list", { name: "本机文稿条目", exact: true })).toHaveCount(0);
  await load(page, "左侧", text);
  const single = await download(page, "导出单篇《_PRIVATE_DOWNLOAD》左侧");
  expect(single.name).toBe("_PRIVATE_DOWNLOAD-2026-11-12.json");
  expect(parseWritingBackup(single.text).draft.title).toBe("_PRIVATE_DOWNLOAD");
});

test("corrupt digests, invalid UTF-8 and oversize inputs are refused as a whole before any private content is adopted", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeReader = window.FileReader;
    window.FileReader = class extends NativeReader {
      readAsArrayBuffer(file: Blob) { document.documentElement.dataset.collectionReads = String(Number(document.documentElement.dataset.collectionReads ?? 0) + 1); super.readAsArrayBuffer(file); }
    };
  });
  await start(page);
  const text = await collection([draft("Never adopted")]);
  const input = page.getByLabel("左侧本机备份文件", { exact: true });
  await input.setInputFiles({ name: "corrupt.json", mimeType: "application/json", buffer: Buffer.from(text.replace("Never adopted", "Tampered title")) });
  const slot = page.getByRole("region", { name: "左侧集合来源", exact: true });
  await expect(slot.getByRole("alert")).toContainText("摘要不匹配");
  await expect(page.getByRole("list", { name: "本机文稿条目", exact: true })).toHaveCount(0);
  await input.setInputFiles({ name: "invalid.json", mimeType: "application/json", buffer: Buffer.from([0xc3, 0x28]) });
  await expect(slot.getByRole("alert")).toContainText("UTF-8");
  const reads = await page.locator("html").getAttribute("data-collection-reads");
  await input.setInputFiles({ name: "large.json", mimeType: "application/json", buffer: Buffer.alloc(16 * 1024 * 1024 + 1, 32) });
  await expect(slot.getByRole("alert")).toContainText("未读取文件");
  expect(await page.locator("html").getAttribute("data-collection-reads")).toBe(reads);
});

test("a delayed native file digest cannot replace a new file, and pagehide/BFCache clear private DOM synchronously", async ({ page }) => {
  await page.addInitScript(() => {
    const native = crypto.subtle.digest.bind(crypto.subtle);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const state = window as unknown as { holdCollectionDigest: boolean; releaseCollectionDigest: () => void };
    state.holdCollectionDigest = true; state.releaseCollectionDigest = release;
    crypto.subtle.digest = async (...args) => {
      if (state.holdCollectionDigest) { state.holdCollectionDigest = false; document.documentElement.dataset.digestHeld = "yes"; await gate; }
      return native(...args);
    };
  });
  await start(page);
  const input = page.getByLabel("左侧本机备份文件", { exact: true });
  await input.setInputFiles({ name: "old.json", mimeType: "application/json", buffer: Buffer.from(await collection([draft("OLD_PRIVATE")])) });
  await expect(page.locator("html")).toHaveAttribute("data-digest-held", "yes");
  await load(page, "左侧", await collection([draft("NEW_PRIVATE")]), "new.json");
  await page.evaluate(() => (window as unknown as { releaseCollectionDigest(): void }).releaseCollectionDigest());
  await expect(page.getByRole("heading", { name: "NEW_PRIVATE", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "OLD_PRIVATE", exact: true })).toHaveCount(0);
  await page.getByLabel("正文检索文字", { exact: true }).fill("PRIVATE_QUERY");
  const immediately = await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })); return document.querySelector("main")!.textContent; });
  expect(immediately).not.toMatch(/NEW_PRIVATE|PRIVATE_QUERY|new\.json|PRIVATE_BODY/);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await expect(page.getByRole("list", { name: "本机文稿条目", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("左侧本机备份文件", { exact: true })).toHaveValue("");
});

test("the loaded mobile workbench escapes hostile-looking names, stays within the viewport and passes axe", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await start(page);
  const title = '<img src=x onerror="alert(1)">' + "超长标题".repeat(25);
  await load(page, "左侧", await collection([draft(title)]), "<script>never</script>.json");
  await page.getByRole("button", { name: `只读查看《${title}》左侧`, exact: true }).click();
  await expect(page.getByRole("region", { name: `只读文稿《${title}》`, exact: true }).locator("img,script")).toHaveCount(0);
  await page.getByRole("button", { name: "生成本机引用依赖清单", exact: true }).click();
  await expect(page.getByRole("region", { name: "集合图片与链接依赖", exact: true }).getByRole("status")).toContainText("扫描完成");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

async function catalogue(page: Page) {
  await registerThroughForm(page, uniqueEmail("collections"), "/write/library");
  await expect(page.getByRole("button", { name: "刷新当前页", exact: true })).toBeEnabled();
  const entries: { id: string; title: string; locale: string }[] = [];
  for (const [index, locale] of ["zh-CN", "en", "zh-CN"].entries()) {
    const title = `Collection edition ${index}`;
    const response = await page.request.post("/api/authoring/articles", { headers: { origin: new URL(page.url()).origin }, data: { title, locale, workType: "other", publish: false, contentBlocksVersion: 1, contentBlocks: [{ id: "p", type: "paragraph", text: `EXACT_COLLECTION_BODY_${index}` }] } });
    expect(response.status()).toBe(201);
    entries.push({ id: (await response.json()).data.id, title, locale });
  }
  await page.getByRole("button", { name: "刷新当前页", exact: true }).click();
  await expect(page.getByRole("list", { name: "目录条目", exact: true }).getByRole("checkbox")).toHaveCount(3);
  for (const entry of entries.slice(0, 2)) await page.getByRole("checkbox", { name: new RegExp(`选择《${entry.title}》`) }).check();
  await page.getByText("所选正文集合备份（最多 20 个语言版本）", { exact: true }).click();
  return entries;
}

test("catalogue exports only the explicitly selected exact editions sequentially and the resulting file opens in the local tool", async ({ page }) => {
  const entries = await catalogue(page), reads: string[] = [], writes: string[] = [];
  page.on("request", request => { if (request.method() !== "GET") writes.push(request.url()); });
  let inFlight = 0, peak = 0;
  await page.route("**/api/authoring/catalogue/*?locale=*", async route => {
    inFlight++; peak = Math.max(peak, inFlight); reads.push(route.request().url());
    expect(route.request().headers()["x-expected-author"]).toBeTruthy();
    const response = await route.fetch(); expect(response.status()).toBe(200);
    inFlight--; await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "读取所选正文并准备集合", exact: true }).click();
  await expect(page.getByRole("button", { name: "下载已校验正文集合", exact: true })).toBeEnabled();
  expect(peak).toBe(1); expect(reads).toHaveLength(2);
  expect(reads[0]).toContain(`${entries[0]!.id}?locale=zh-CN`);
  expect(reads[1]).toContain(`${entries[1]!.id}?locale=en`);
  expect(reads.join("\n")).not.toContain(entries[2]!.id);
  const file = await download(page, "下载已校验正文集合");
  const result = await parseWritingCollection(file.text);
  expect(result.collection.entries.map(entry => entry.backup.draft.locale)).toEqual(["zh-CN", "en"]);
  expect(file.text).not.toMatch(/authorId|revision|slug|publishedAt|accessToken|idempotency/i);
  expect(file.text).toContain("EXACT_COLLECTION_BODY_0");
  expect(writes).toEqual([]);
  await page.getByRole("link", { name: "打开本机集合工具", exact: true }).click();
  await load(page, "左侧", file.text, file.name);
  await expect(page.getByRole("list", { name: "本机文稿条目", exact: true }).getByRole("listitem")).toHaveCount(2);
});

test("catalogue body cancellation stops the queue; a 429 retains its cooldown and never automatically replays remaining reads", async ({ page }) => {
  await catalogue(page);
  let release!: () => void, arrived!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const observed = new Promise<void>(resolve => { arrived = resolve; });
  let calls = 0;
  await page.route("**/api/authoring/catalogue/*?locale=*", async route => { calls++; const response = await route.fetch(); arrived(); await held; await route.fulfill({ response }); });
  await page.getByRole("button", { name: "读取所选正文并准备集合", exact: true }).click();
  await observed;
  await page.getByRole("button", { name: "停止正文读取", exact: true }).click(); release();
  await expect(page.getByRole("alert").filter({ hasText: "已停止正文读取" })).toBeVisible();
  await expect(page.getByRole("button", { name: "下载已校验正文集合", exact: true })).toBeDisabled();
  expect(calls).toBe(1);
  await page.unroute("**/api/authoring/catalogue/*?locale=*");
  await page.clock.install();
  calls = 0;
  await page.route("**/api/authoring/catalogue/*?locale=*", async route => { calls++; if (calls === 2) await route.fulfill({ status: 429, headers: { "retry-after": "60" }, json: { error: { code: "RATE_LIMITED" } } }); else await route.continue(); });
  await page.getByRole("button", { name: "读取所选正文并准备集合", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "正文请求受限" })).toBeVisible();
  await expect(page.getByRole("button", { name: "读取所选正文并准备集合", exact: true })).toBeDisabled();
  await page.clock.fastForward(61_000);
  await expect(page.getByRole("button", { name: "读取所选正文并准备集合", exact: true })).toBeEnabled();
  expect(calls).toBe(2);
  await expect(page.getByRole("button", { name: "下载已校验正文集合", exact: true })).toBeDisabled();
});

test("a pending fresh-session download cannot release old bodies after equal-valued reselection or a changed actual account", async ({ page }) => {
  const entries = await catalogue(page);
  await page.getByRole("button", { name: "读取所选正文并准备集合", exact: true }).click();
  const save = page.getByRole("button", { name: "下载已校验正文集合", exact: true });
  await expect(save).toBeEnabled();
  let release!: () => void, arrived!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), observed = new Promise<void>(resolve => { arrived = resolve; });
  await page.route("**/api/authoring/session", async route => { const response = await route.fetch(); arrived(); await held; await route.fulfill({ response }); });
  const downloads: string[] = []; page.on("download", file => downloads.push(file.suggestedFilename()));
  await save.click(); await observed;
  const selected = page.getByRole("checkbox", { name: new RegExp(`选择《${entries[0]!.title}》`) });
  await selected.uncheck(); await selected.check(); release();
  await expect(save).toBeDisabled();
  await page.unroute("**/api/authoring/session");
  await page.getByRole("button", { name: "读取所选正文并准备集合", exact: true }).click(); await expect(save).toBeEnabled();
  await page.route("**/api/authoring/session", route => route.fulfill({ status: 200, json: { data: { id: "different-actual-account" } } }));
  await save.click();
  await expect(page.getByRole("alert").filter({ hasText: "登录账户已改变" })).toBeVisible();
  await expect(page.getByRole("region", { name: "正文集合备份", exact: true })).toHaveCount(0);
  expect(downloads).toEqual([]);
});
