import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { test } from "./support/article-view-stack.ts";
import { registerThroughForm, uniqueEmail } from "./support/accounts.ts";

// Each journey owns a disposable real production stack: authoring safety tests
// must not consume other suites' per-IP creation budget or raise that budget.
async function writer(page: Page) {
  await registerThroughForm(page, uniqueEmail("writing-tools"), "/write");
  await expect(page.getByLabel("作品正文")).toHaveAttribute("contenteditable", "true");
}
async function write(page: Page, title = "未完的海风", text = "海浪带来海浪，句子还没有结束。") {
  await page.getByLabel("标题", { exact: true }).fill(title);
  await page.getByLabel("作品正文").fill(text);
  await expect(page.getByLabel("作品正文")).toHaveText(text);
}
async function save(page: Page) {
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "草稿已保存。" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "有未保存的修改" })).toHaveCount(0);
}
async function tools(page: Page, panel: "文稿检查与大纲" | "正文查找替换" | "本机备份与恢复") {
  const summary = page.getByText("文稿工具：检查、大纲、替换与本机备份", { exact: true });
  if (await summary.evaluate(element => !(element.parentElement as HTMLDetailsElement).open)) await summary.click();
  await page.getByRole("button", { name: panel, exact: true }).click();
}
async function downloadedBackup(page: Page): Promise<string> {
  await tools(page, "本机备份与恢复");
  const file = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 JSON 文稿备份" }).click();
  const download = await file;
  expect(download.suggestedFilename()).toMatch(/\.json$/);
  const path = await download.path();
  expect(path).not.toBeNull();
  return readFile(path!, "utf8");
}
async function uploadBackup(page: Page, text: string, name = "manuscript.json") {
  await tools(page, "本机备份与恢复");
  await page.getByLabel("读取 JSON 文稿备份", { exact: true }).setInputFiles({ name, mimeType: "application/json", buffer: Buffer.from(text) });
}
function backup(title: string, text: string, extras: Record<string, unknown> = {}) {
  const element = (type: string, children: unknown[]) => ({ type, version: 1, children, direction: null, format: "", indent: 0 });
  return JSON.stringify({ format: "no-wave-writing-backup", version: 1, createdAt: "2026-11-12T00:00:00.000Z", draft: {
    title, summary: "备份摘要", locale: "zh-CN", workType: "essay", editorState: { root: element("root", [element("paragraph", [{ type: "text", version: 1, text, format: 0, detail: 0, mode: "normal", style: "" }])]) }, ...extras,
  } });
}
async function onlyBody(page: Page) {
  for (const label of ["恢复标题", "恢复摘要", "恢复作品语言", "恢复作品类型"]) await page.getByRole("checkbox", { name: label, exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "恢复正文（含格式）", exact: true }).check();
}

test("ordinary edits are protected across document/new/logout/router/unload exits, and cancel keeps the input", async ({ page }) => {
  await writer(page);
  await write(page, "已保存的作品", "已经保存在服务器的正文。");
  await save(page);
  await page.getByRole("button", { name: "新建作品 +" }).click();
  await write(page);
  const dialog = page.getByRole("dialog", { name: "放弃未保存的修改？" });
  for (const action of [page.getByRole("button", { name: /^已保存的作品/ }), page.getByRole("button", { name: "新建作品 +" }), page.getByRole("button", { name: "退出登录", exact: true })]) {
    await action.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.getByLabel("标题", { exact: true })).toHaveValue("未完的海风");
  }
  await page.getByRole("link", { name: "媒体库", exact: true }).click();
  const route = page.getByRole("dialog", { name: "离开未保存的文稿？" });
  await expect(route).toBeVisible();
  await route.getByRole("button", { name: "取消", exact: true }).click();
  const warning = page.waitForEvent("dialog");
  const reload = page.evaluate(() => window.location.reload()).catch(() => null);
  const native = await warning;
  expect(native.type()).toBe("beforeunload");
  await native.dismiss();
  await reload;
  await expect(page.getByLabel("作品正文")).toContainText("句子还没有结束");
  await page.getByRole("button", { name: "新建作品 +" }).click();
  await dialog.getByRole("button", { name: "放弃修改并切换" }).click();
  await expect(page.getByLabel("标题", { exact: true })).toHaveValue("");
  await page.getByRole("link", { name: "媒体库", exact: true }).click();
  await expect(page).toHaveURL(/\/write\/media$/);
});

test("PUT success acknowledges only the submitted snapshot and a later save clears the ordinary guard", async ({ page }) => {
  await writer(page);
  await write(page);
  await save(page);
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const received = new Promise<void>(resolve => { arrived = resolve; });
  await page.route("**/api/authoring/articles/*", async route => {
    if (route.request().method() !== "PUT") { await route.continue(); return; }
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    arrived();
    await gate;
    await route.fulfill({ response });
  });
  await page.getByLabel("标题", { exact: true }).fill("提交时的标题");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await received;
  await page.getByRole("textbox", { name: "摘要", exact: true }).fill("请求途中继续写的摘要");
  release();
  await expect(page.getByRole("status").filter({ hasText: "当前修改尚未保存" })).toBeVisible();
  await page.getByRole("button", { name: "新建作品 +" }).click();
  await page.getByRole("dialog", { name: "放弃未保存的修改？" }).getByRole("button", { name: "取消", exact: true }).click();
  await save(page);
  await page.getByRole("button", { name: "新建作品 +" }).click();
  await expect(page.getByLabel("标题", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: /^提交时的标题/ }).click();
  await expect(page.getByRole("textbox", { name: "摘要", exact: true })).toHaveValue("请求途中继续写的摘要");
  await page.getByRole("link", { name: "媒体库", exact: true }).click();
  await expect(page).toHaveURL(/\/write\/media$/);
});

test("a failed version-conflict save leaves ordinary edits protected", async ({ page }) => {
  await writer(page);
  await write(page);
  await save(page);
  await page.route("**/api/authoring/articles/*", route => route.request().method() === "PUT" ? route.fulfill({ status: 409, json: { error: { code: "ARTICLE_VERSION_CONFLICT" } } }) : route.continue());
  await page.getByLabel("标题", { exact: true }).fill("不能丢的冲突草稿");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("当前草稿仍保留");
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "放弃未保存的修改？" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByLabel("标题", { exact: true })).toHaveValue("不能丢的冲突草稿");
});

test("a rich-text replacement is one undoable batch and preserves link destinations and outside marks on save", async ({ page }) => {
  await writer(page);
  const created = await page.request.post("/api/authoring/articles", { headers: { origin: new URL(page.url()).origin }, data: {
    title: "富文本替换验证", locale: "zh-CN", workType: "essay", publish: false, contentBlocksVersion: 1,
    contentBlocks: [{ id: "p", type: "paragraph", text: "前海浪后海浪", inlines: [
      { text: "前海", marks: ["bold"] }, { text: "浪后", marks: ["italic"], href: "https://example.test/wave" }, { text: "海浪" },
    ] }],
  } });
  expect(created.status()).toBe(201);
  await page.reload();
  await page.getByRole("button", { name: /^富文本替换验证/ }).click();
  await expect(page.getByLabel("作品正文")).toHaveText("前海浪后海浪");
  await tools(page, "正文查找替换");
  await page.getByLabel("查找文字", { exact: true }).fill("海浪");
  await page.getByLabel("替换为", { exact: true }).fill("潮汐");
  await page.getByRole("button", { name: "预览替换", exact: true }).click();
  await expect(page.getByRole("list", { name: "替换预览" }).getByRole("checkbox")).toHaveCount(2);
  await page.getByRole("button", { name: "下一处匹配", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("海浪");
  await page.getByRole("button", { name: "下一处匹配", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "已定位第 2 / 2 处" })).toBeVisible();
  await page.getByRole("button", { name: "上一处匹配", exact: true }).click();
  await page.getByRole("checkbox", { name: "替换第 1 处", exact: true }).check();
  await page.getByRole("button", { name: "替换所选（1）", exact: true }).click();
  await expect(page.getByLabel("作品正文")).toHaveText("前潮汐后海浪");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.getByLabel("作品正文")).toHaveText("前海浪后海浪");
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await expect(page.getByLabel("作品正文")).toHaveText("前潮汐后海浪");
  await save(page);
  const stored = (await (await page.request.get("/api/authoring/articles")).json()).data[0].contentBlocks[0];
  expect(stored.inlines).toEqual([{ text: "前潮汐", marks: ["bold"] }, { text: "后", marks: ["italic"], href: "https://example.test/wave" }, { text: "海浪" }]);
});

test("replacement preview expires on metadata and format-only changes instead of applying old positions", async ({ page }) => {
  await writer(page);
  await write(page);
  await tools(page, "正文查找替换");
  await page.getByLabel("查找文字", { exact: true }).fill("海浪");
  await page.getByLabel("替换为", { exact: true }).fill("潮汐");
  await page.getByRole("button", { name: "预览替换", exact: true }).click();
  await page.getByRole("button", { name: "选择全部预览项" }).click();
  await page.getByRole("textbox", { name: "摘要", exact: true }).fill("后来补的摘要");
  await expect(page.getByRole("alert")).toContainText("预览已过期");
  await expect(page.getByRole("button", { name: "替换所选（2）", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "预览替换", exact: true }).click();
  await page.getByRole("button", { name: "选择全部预览项" }).click();
  await page.getByLabel("作品正文").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ControlOrMeta+b");
  await expect(page.getByRole("alert")).toContainText("预览已过期");
  await expect(page.getByLabel("作品正文")).toHaveText("海浪带来海浪，句子还没有结束。");
});

test("outline navigation locates the live heading and structural checks are visible without changing content", async ({ page }) => {
  await writer(page);
  await write(page, "大纲验证", "第一节");
  await page.getByLabel("作品正文").click();
  await page.getByRole("button", { name: "H2", exact: true }).click();
  await tools(page, "文稿检查与大纲");
  const outline = page.getByRole("list", { name: "文稿大纲" });
  await expect(outline.getByRole("button", { name: "H2 第一节" })).toBeVisible();
  await outline.getByRole("button", { name: "H2 第一节" }).click();
  await expect(page.getByLabel("作品正文")).toBeFocused();
  await page.keyboard.press("Home");
  await page.keyboard.type("新");
  await expect(outline.getByRole("button", { name: "H2 新第一节" })).toBeVisible();
  await expect(page.getByLabel("作品正文")).toHaveText("新第一节");
});

test("JSON download captures unsaved runtime content and restoring checked metadata never saves or publishes", async ({ page }) => {
  await writer(page);
  await write(page);
  const json = await downloadedBackup(page);
  const parsed = JSON.parse(json);
  expect(parsed.draft.title).toBe("未完的海风");
  expect(JSON.stringify(parsed.draft.editorState)).toContain("句子还没有结束");
  expect(Object.keys(parsed)).toEqual(["format", "version", "createdAt", "draft"]);
  await page.getByLabel("标题", { exact: true }).fill("当前要保留的标题");
  await page.getByRole("textbox", { name: "摘要", exact: true }).fill("摘要不能被覆盖");
  await page.getByLabel("作品正文").fill("正文也不能被覆盖。");
  await uploadBackup(page, json);
  await expect(page.getByRole("region", { name: "本机备份与恢复" })).toContainText("备份校验通过");
  for (const label of ["恢复摘要", "恢复作品语言", "恢复作品类型", "恢复正文（含格式）"]) await page.getByRole("checkbox", { name: label, exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "恢复标题", exact: true }).check();
  await page.getByRole("button", { name: "恢复所选字段到编辑区" }).click();
  await expect(page.getByLabel("标题", { exact: true })).toHaveValue("未完的海风");
  await expect(page.getByRole("textbox", { name: "摘要", exact: true })).toHaveValue("摘要不能被覆盖");
  await expect(page.getByLabel("作品正文")).toHaveText("正文也不能被覆盖。");
  expect((await (await page.request.get("/api/authoring/articles")).json()).data).toEqual([]);
});

test("restoring a body is undoable and an expired restore preview cannot overwrite later edits", async ({ page }) => {
  await writer(page);
  await write(page, "本篇作品", "当前正文");
  const json = backup("备份作品", "早先正文");
  await uploadBackup(page, json);
  await onlyBody(page);
  await page.getByRole("textbox", { name: "摘要", exact: true }).fill("读取以后继续写");
  await expect(page.getByRole("button", { name: "恢复所选字段到编辑区" })).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText("恢复预览已过期");
  await uploadBackup(page, json);
  await onlyBody(page);
  await page.getByRole("button", { name: "恢复所选字段到编辑区" }).click();
  await expect(page.getByLabel("作品正文")).toHaveText("早先正文");
  await expect(page.getByLabel("标题", { exact: true })).toHaveValue("本篇作品");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.getByLabel("作品正文")).toHaveText("当前正文");
});

test("invalid backups and remote-image previews have no network side effects; loading images requires explicit consent", async ({ page }) => {
  await writer(page);
  await write(page);
  const invalid = JSON.parse(backup("危险文件", "不可替换当前正文"));
  invalid.draft.editorState.root.children[0].type = "html";
  await uploadBackup(page, JSON.stringify(invalid));
  await expect(page.getByRole("status").filter({ hasText: "无法读取文稿备份" })).toBeVisible();
  await expect(page.getByLabel("作品正文")).toContainText("句子还没有结束");
  const remote = JSON.parse(backup("带图备份", "远程图片预览"));
  remote.draft.editorState.root.children.push({ type: "image", version: 1, src: "https://images.example.test/preview.png", alt: "远程示例" });
  let requests = 0;
  await page.route("https://images.example.test/**", async route => { requests++; await route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6JkAAAAASUVORK5CYII=", "base64") }); });
  await uploadBackup(page, JSON.stringify(remote));
  await expect(page.getByRole("button", { name: "恢复所选字段到编辑区" })).toBeDisabled();
  expect(requests).toBe(0);
  await page.getByRole("checkbox", { name: /我同意向图片地址发出请求/ }).check();
  await page.getByRole("button", { name: "恢复所选字段到编辑区" }).click();
  await expect(page.getByLabel("作品正文").getByRole("img", { name: "远程示例" })).toBeVisible();
  await expect.poll(() => requests).toBe(1);
  expect((await (await page.request.get("/api/authoring/articles")).json()).data).toEqual([]);
});

test("late FileReader completion cannot replace a newer preview or an editor changed during the read", async ({ page }) => {
  await page.addInitScript(() => {
    const native = FileReader.prototype.readAsText;
    FileReader.prototype.readAsText = function(file, encoding) {
      if (file instanceof File && file.name === "slow.json") {
        const callback = this.onload;
        this.onload = event => { (window as unknown as { releaseWritingRead(): void }).releaseWritingRead = () => { callback?.call(this, event); }; };
      }
      native.call(this, file, encoding);
    };
  });
  await writer(page);
  await write(page);
  await uploadBackup(page, backup("慢文件", "慢正文"), "slow.json");
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { releaseWritingRead?: unknown }).releaseWritingRead)).toBe("function");
  await page.getByRole("textbox", { name: "摘要", exact: true }).fill("读取过程中新增");
  await page.evaluate(() => (window as unknown as { releaseWritingRead(): void }).releaseWritingRead());
  await expect(page.getByRole("status").filter({ hasText: "读取期间文稿已变化" })).toBeVisible();
  await uploadBackup(page, backup("又一个慢文件", "旧正文"), "slow.json");
  await uploadBackup(page, backup("新文件", "新正文"), "new.json");
  await expect(page.getByRole("region", { name: "本机备份与恢复" })).toContainText("备份标题：新文件");
  await page.evaluate(() => (window as unknown as { releaseWritingRead(): void }).releaseWritingRead());
  await expect(page.getByRole("region", { name: "本机备份与恢复" })).toContainText("备份标题：新文件");
  await expect(page.getByLabel("作品正文")).toContainText("句子还没有结束");
});

test("a save finishing behind a navigation confirmation closes the prompt without navigating or losing content", async ({ page }) => {
  await writer(page);
  await write(page);
  await save(page);
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const received = new Promise<void>(resolve => { arrived = resolve; });
  await page.route("**/api/authoring/articles/*", async route => {
    if (route.request().method() !== "PUT") { await route.continue(); return; }
    const response = await route.fetch();
    arrived();
    await gate;
    await route.fulfill({ response });
  });
  await page.getByLabel("标题", { exact: true }).fill("刚刚保存的标题");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await received;
  await page.getByRole("link", { name: "媒体库", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "离开未保存的文稿？" })).toBeVisible();
  release();
  await expect(page.getByRole("dialog", { name: "离开未保存的文稿？" })).not.toBeVisible();
  await expect(page).toHaveURL(/\/write$/);
  await expect(page.getByLabel("标题", { exact: true })).toHaveValue("刚刚保存的标题");
  await page.getByRole("link", { name: "媒体库", exact: true }).click();
  await expect(page).toHaveURL(/\/write\/media$/);
});

test("edits made after confirming logout remain recoverable when the asynchronous logout finishes", async ({ page }) => {
  await writer(page);
  await write(page);
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const received = new Promise<void>(resolve => { arrived = resolve; });
  await page.route("**/api/auth/logout", async route => { const response = await route.fetch(); arrived(); await gate; await route.fulfill({ response }); });
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await page.getByRole("dialog", { name: "放弃未保存的修改？" }).getByRole("button", { name: "放弃修改并退出" }).click();
  await received;
  await page.getByLabel("标题", { exact: true }).fill("退出途中写下的标题");
  release();
  await expect(page.getByRole("alert")).toContainText("当前未保存输入仍保留");
  await expect(page.getByLabel("标题", { exact: true })).toHaveValue("退出途中写下的标题");
  const json = JSON.parse(await downloadedBackup(page));
  expect(json.draft.title).toBe("退出途中写下的标题");
});


test("selected backup blocks append in file order, keep the current title, and undo as one operation", async ({ page }) => {
  await writer(page);
  await write(page, "当前标题", "当前正文");
  const incoming = JSON.parse(backup("备份标题", "备份一"));
  const node = incoming.draft.editorState.root.children[0];
  incoming.draft.editorState.root.children.push({ ...structuredClone(node), children: [{ ...node.children[0], text: "备份二" }] }, { ...structuredClone(node), children: [{ ...node.children[0], text: "备份三" }] });
  await uploadBackup(page, JSON.stringify(incoming));
  await onlyBody(page);
  await page.getByRole("combobox", { name: "正文恢复方式", exact: true }).selectOption("append");
  await expect(page.getByRole("button", { name: "恢复所选字段到编辑区" })).toBeDisabled();
  await page.getByRole("checkbox", { name: "追加备份第 3 块", exact: true }).check();
  await page.getByRole("checkbox", { name: "追加备份第 1 块", exact: true }).check();
  await page.getByRole("button", { name: "恢复所选字段到编辑区" }).click();
  await expect(page.getByLabel("作品正文")).toHaveText("当前正文备份一备份三");
  await expect(page.getByLabel("标题", { exact: true })).toHaveValue("当前标题");
  expect((await (await page.request.get("/api/authoring/articles")).json()).data).toEqual([]);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.getByLabel("作品正文")).toHaveText("当前正文");
});

test("the reference inventory is offline, identifies ambiguous labels, and navigates without following URLs", async ({ page }) => {
  await writer(page);
  await write(page);
  const incoming = JSON.parse(backup("参考核对", "来源来源"));
  const block = incoming.draft.editorState.root.children[0];
  block.children = ["https://example.test/a", "https://example.test/b"].map(url => ({ type: "link", version: 1, children: [{ type: "text", version: 1, text: "来源", format: 0 }], direction: null, format: "", indent: 0, url }));
  await uploadBackup(page, JSON.stringify(incoming));
  await onlyBody(page);
  await page.getByRole("button", { name: "恢复所选字段到编辑区" }).click();
  let visited = 0;
  await page.route("https://example.test/**", async route => { visited++; await route.abort(); });
  await tools(page, "文稿检查与大纲");
  await page.getByText("链接与图片核对清单", { exact: true }).click();
  const inventory = page.getByRole("list", { name: "链接与图片核对清单" });
  await expect(inventory).toContainText("相同链接文字指向不同地址");
  await page.getByRole("checkbox", { name: "只看需要核对的引用" }).check();
  await page.getByRole("button", { name: "定位第 1 组第 1 处引用", exact: true }).click();
  await expect(page.getByLabel("作品正文")).toBeFocused();
  expect(visited).toBe(0);
  await expect(page).toHaveURL(/\/write$/);
});

test("an uncertain create keeps its exact retry bytes while tools can back up later input but cannot apply changes", async ({ page }) => {
  await writer(page);
  const attempts: string[] = [];
  await page.route("**/api/authoring/articles", async route => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    attempts.push(route.request().postData()!);
    if (attempts.length === 1) { const response = await route.fetch(); expect(response.status()).toBe(201); await route.abort("failed"); }
    else await route.continue();
  });
  await write(page, "提交的标题", "海浪的原稿");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("暂时无法确认");
  await page.getByLabel("标题", { exact: true }).fill("后来编辑的标题");
  const local = JSON.parse(await downloadedBackup(page));
  expect(local.draft.title).toBe("后来编辑的标题");
  await tools(page, "正文查找替换");
  await page.getByLabel("查找文字", { exact: true }).fill("海浪");
  await page.getByLabel("替换为", { exact: true }).fill("潮汐");
  await page.getByRole("button", { name: "预览替换", exact: true }).click();
  await page.getByRole("button", { name: "选择全部预览项" }).click();
  await expect(page.getByRole("button", { name: "替换所选（1）", exact: true })).toBeDisabled();
  await uploadBackup(page, backup("旧备份", "不能恢复的正文"));
  await expect(page.getByRole("button", { name: "恢复所选字段到编辑区" })).toBeDisabled();
  await page.getByRole("button", { name: "确认上次保存", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "上次创建已确认" })).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toBe(attempts[0]);
  await expect(page.getByLabel("标题", { exact: true })).toHaveValue("后来编辑的标题");
  await expect(page.getByLabel("作品正文")).toHaveText("海浪的原稿");
});

test("opening an existing rich document is clean after Lexical hydration and its runtime backup reopens without false differences", async ({ page }) => {
  await writer(page);
  const created = await page.request.post("/api/authoring/articles", { headers: { origin: new URL(page.url()).origin }, data: {
    title: "完整格式的已存作品", locale: "zh-CN", workType: "essay", publish: false, contentBlocksVersion: 1,
    contentBlocks: [
      { id: "h", type: "heading", level: 2, text: "节标题" },
      { id: "p", type: "paragraph", text: "同一链接", inlines: [{ text: "同一", marks: ["bold"], href: "https://example.test/read" }, { text: "链接", marks: ["italic"], href: "https://example.test/read" }] },
      { id: "q", type: "quote", text: "引用文字" },
      { id: "l", type: "list", ordered: false, items: ["列表一", "列表二"] },
      { id: "c", type: "code", language: "text", code: "const wave = true;" },
    ],
  } });
  expect(created.status()).toBe(201);
  await page.reload();
  await page.getByRole("button", { name: /^完整格式的已存作品/ }).click();
  await expect(page.getByLabel("作品正文")).toContainText("同一链接");
  await expect(page.getByRole("status").filter({ hasText: "有未保存的修改" })).toHaveCount(0);
  const json = await downloadedBackup(page);
  await uploadBackup(page, json);
  await expect(page.getByRole("status").filter({ hasText: "备份校验通过" })).toBeVisible();
  await expect(page.getByRole("button", { name: "恢复所选字段到编辑区" })).toBeDisabled();
  await page.getByRole("link", { name: "媒体库", exact: true }).click();
  await expect(page).toHaveURL(/\/write\/media$/);
});

test("expanded writing panels have accessible visible names, usable targets and no horizontal overflow on desktop or mobile", async ({ page }) => {
  await writer(page);
  await write(page);
  const incoming = JSON.parse(backup("展开工具验收", "海浪来源海浪"));
  const text = (value: string) => ({ type: "text", version: 1, text: value, format: 0 });
  incoming.draft.editorState.root.children[0].children = [text("海浪"), {
    type: "link", version: 1, url: `https://example.test/${"long-source-".repeat(100)}`, children: [text("来源")],
  }, text("海浪")];
  await uploadBackup(page, JSON.stringify(incoming));
  await onlyBody(page);
  await page.getByRole("button", { name: "恢复所选字段到编辑区" }).click();
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 900 });
    for (const panel of ["文稿检查与大纲", "正文查找替换", "本机备份与恢复"] as const) {
      await tools(page, panel);
      if (panel === "文稿检查与大纲") await page.getByText("链接与图片核对清单", { exact: true }).click();
      if (panel === "正文查找替换") {
        await page.getByLabel("查找文字", { exact: true }).fill("海浪");
        await page.getByLabel("替换为", { exact: true }).fill("潮声");
        await page.getByRole("button", { name: "预览替换", exact: true }).click();
        await page.getByRole("button", { name: "定位正文：第 1 处匹配", exact: true }).click();
        await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("海浪");
      }
      const audit = await new AxeBuilder({ page }).include(".nw-writing-tools").analyze();
      expect(audit.violations.filter(issue => issue.impact === "serious" || issue.impact === "critical")).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const smallButtons = await page.locator(".nw-writing-tools button:visible").evaluateAll(buttons => buttons.filter(button => button.getBoundingClientRect().height < 44).map(button => button.textContent));
      expect(smallButtons).toEqual([]);
    }
  }
});
