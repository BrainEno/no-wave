import { expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { test } from "./support/article-view-stack.ts";
import {
  BROWSER_PASSWORD,
  registerThroughForm,
  uniqueEmail,
} from "./support/accounts.ts";

type Cached = {
  id: string;
  writer: string;
  actor: string;
  revision: number;
  backup: string;
  outcomeUnknown: boolean;
  base: { articleId: string | null };
};
const region = (page: Page) =>
  page.getByRole("region", { name: "可选本机文稿恢复", exact: true });
async function writer(page: Page) {
  page.on("dialog", async (dialog) => {
    if (dialog.type() === "beforeunload") await dialog.accept();
    else await dialog.dismiss();
  });
  await registerThroughForm(page, uniqueEmail("recovery"), "/write");
  await expect(page.getByLabel("作品正文")).toHaveAttribute(
    "contenteditable",
    "true",
  );
  await expect(region(page).getByRole("status")).toContainText("已关闭");
}
async function write(
  page: Page,
  title: string,
  text = "只能由作者手动恢复的正文。",
) {
  await page.getByLabel("标题", { exact: true }).fill(title);
  await page.getByLabel("作品正文", { exact: true }).fill(text);
}
async function enable(page: Page) {
  await region(page)
    .getByRole("checkbox", { name: /我了解缓存未加密/ })
    .check();
  await region(page)
    .getByRole("button", { name: "在此设备启用本机恢复", exact: true })
    .click();
  await expect(region(page).getByRole("status")).toContainText("已启用");
}
async function cache(page: Page, title: string) {
  await expect(
    region(page).getByRole("button", { name: "立即缓存当前输入", exact: true }),
  ).toBeEnabled();
  await region(page)
    .getByRole("button", { name: "立即缓存当前输入", exact: true })
    .click();
  await expect
    .poll(async () =>
      (await cached(page)).some(
        (row) => JSON.parse(row.backup).draft.title === title,
      ),
    )
    .toBe(true);
}
async function cached(page: Page): Promise<Cached[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("no-wave-writing-recovery-v1", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<Cached[]>((resolve, reject) => {
        const tx = db.transaction("drafts", "readonly"),
          request = tx.objectStore("drafts").getAll();
        tx.oncomplete = () => resolve(request.result as Cached[]);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  });
}
async function preview(page: Page, title: string) {
  await region(page)
    .getByRole("button", { name: `预览本机缓存：${title}`, exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "本机缓存恢复预览", exact: true }),
  ).toBeVisible();
}
async function copyPreview(page: Page) {
  const plan = page.getByRole("region", {
    name: "本机缓存恢复预览",
    exact: true,
  });
  const different = plan.getByRole("checkbox", {
    name: /来源作品或服务器修订与当前目标不同/,
  });
  if (await different.count()) await different.check();
  await plan
    .getByRole("button", { name: "将缓存所选字段恢复到编辑区", exact: true })
    .click();
}
function writes(page: Page) {
  let count = 0;
  page.on("request", (request) => {
    if (
      /\/api\/authoring\/articles(?:\/[^/?]+)?$/.test(
        new URL(request.url()).pathname,
      ) &&
      ["POST", "PUT"].includes(request.method())
    )
      count++;
  });
  return () => count;
}

test("default-off is genuinely memory-only; opt-in survives refresh but only explicit preview and apply restore text", async ({
  page,
}) => {
  await writer(page);
  const count = writes(page);
  await write(page, "默认不入盘");
  await expect.poll(async () => (await cached(page)).length).toBe(0);
  await page.reload();
  await expect(page.getByLabel("标题", { exact: true })).toHaveValue("");
  await write(page, "刷新后找回的海风");
  await enable(page);
  await cache(page, "刷新后找回的海风");
  const rows = await cached(page);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.backup).not.toMatch(
    /password|accessToken|refreshToken|idempotency|e2e-browser-password/,
  );
  await page.reload();
  await expect(page.getByLabel("标题", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("作品正文")).not.toContainText("只能由作者");
  await preview(page, "刷新后找回的海风");
  expect(count()).toBe(0);
  await expect(page.getByLabel("标题", { exact: true })).toHaveValue("");
  await copyPreview(page);
  await expect(page.getByLabel("标题", { exact: true })).toHaveValue(
    "刷新后找回的海风",
  );
  await expect(page.getByLabel("作品正文")).toHaveText(
    "只能由作者手动恢复的正文。",
  );
  expect(count()).toBe(0);
  expect(
    (await (await page.request.get("/api/authoring/articles")).json()).data,
  ).toHaveLength(0);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.getByLabel("作品正文")).not.toContainText("只能由作者");
});

test("two real tabs keep independent branches; clearing from one fences the old tab and cannot erase its current input", async ({
  page,
  context,
}) => {
  await writer(page);
  await write(page, "窗口甲的未存稿");
  await enable(page);
  await cache(page, "窗口甲的未存稿");
  const other = await context.newPage();
  await other.goto(page.url());
  await expect(region(other).getByRole("status")).toContainText("已启用");
  await write(other, "窗口乙的未存稿");
  await cache(other, "窗口乙的未存稿");
  await expect.poll(async () => (await cached(other)).length).toBe(2);
  const rows = await cached(other);
  expect(new Set(rows.map((row) => row.writer)).size).toBe(2);
  await page.bringToFront();
  await region(page)
    .getByRole("button", { name: "清除全部本机缓存并关闭", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "清除全部本机缓存并关闭？" })
    .getByRole("button", { name: "清除缓存并关闭", exact: true })
    .click();
  await expect(region(page).getByRole("status")).toContainText("已关闭");
  await expect(region(other)).toContainText("此旧标签已失效");
  await expect(other.getByLabel("标题", { exact: true })).toHaveValue(
    "窗口乙的未存稿",
  );
  await expect.poll(async () => (await cached(other)).length).toBe(0);
  const count = writes(other);
  await other.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(
    other.getByRole("alert").filter({ hasText: "旧标签不能重新写入" }),
  ).toHaveCount(2);
  expect(count()).toBe(0);
  await other.close();
});

test("quota failure injected at the real browser IDB put rolls back the old cache and prevents an uncheckpointed request", async ({
  page,
}) => {
  await writer(page);
  await write(page, "配额前的安全稿");
  await enable(page);
  await cache(page, "配额前的安全稿");
  const before = await cached(page),
    count = writes(page);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (
      ...args: Parameters<IDBObjectStore["put"]>
    ) {
      if (this.name === "drafts")
        throw new DOMException("injected quota failure", "QuotaExceededError");
      return original.apply(this, args);
    };
  });
  await page.getByLabel("标题", { exact: true }).fill("空间不足仍在页面的稿");
  await region(page)
    .getByRole("button", { name: "立即缓存当前输入", exact: true })
    .click();
  await expect(region(page).getByRole("alert")).toContainText("空间不足");
  expect(await cached(page)).toEqual(before);
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "空间不足" }),
  ).toHaveCount(2);
  expect(count()).toBe(0);
  await expect(page.getByLabel("标题", { exact: true })).toHaveValue(
    "空间不足仍在页面的稿",
  );
  expect(
    (await (await page.request.get("/api/authoring/articles")).json()).data,
  ).toHaveLength(0);
});

test("a new account without any UI broadcast cannot see or reuse the previous account's cache", async ({
  page,
}) => {
  await writer(page);
  await write(page, "账号甲的本机私稿");
  await enable(page);
  await cache(page, "账号甲的本机私稿");
  const count = writes(page);
  // Intentionally bypass the UI boundary to prove live session verification,
  // not BroadcastChannel or a cached actor, is the authority.
  const registered = await page.request.post("/api/auth/register", {
    headers: { origin: new URL(page.url()).origin },
    data: { email: uniqueEmail("recovery-b"), password: BROWSER_PASSWORD },
  });
  expect(registered.ok()).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(region(page)).toContainText("此旧标签已失效");
  await expect(
    region(page).getByRole("list", { name: "本机缓存文稿列表" }),
  ).toHaveCount(0);
  expect(await cached(page)).toHaveLength(0);
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  expect(count()).toBe(0);
  await expect(page.getByLabel("标题", { exact: true })).toHaveValue(
    "账号甲的本机私稿",
  );
  await page.reload();
  await expect(region(page).getByRole("status")).toContainText("已关闭");
  await expect(page.getByLabel("标题", { exact: true })).toHaveValue("");
});

test("logout purges manuscripts and broadcasts invalidation while another tab retains only its unsaved in-memory text", async ({
  page,
  context,
}) => {
  await writer(page);
  await write(page, "退出前的本机稿");
  await enable(page);
  await cache(page, "退出前的本机稿");
  const other = await context.newPage();
  await other.goto(page.url());
  await expect(region(other).getByRole("status")).toContainText("已启用");
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await page
    .getByRole("dialog", { name: "放弃未保存的修改？" })
    .getByRole("button", { name: "放弃修改并退出", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "登录或创建账户", exact: true }),
  ).toBeVisible();
  await expect(region(other)).toContainText("此旧标签已失效");
  expect(await cached(other)).toHaveLength(0);
  await other.close();
});

test("input changes and a concurrent persisted revision invalidate manual previews without silently applying their old text", async ({
  page,
}) => {
  await writer(page);
  await write(page, "预览来源");
  await enable(page);
  await cache(page, "预览来源");
  await page.reload();
  await preview(page, "预览来源");
  await page
    .getByRole("textbox", { name: "摘要", exact: true })
    .fill("预览后仍继续输入");
  await expect(
    page.getByRole("region", { name: "本机缓存恢复预览" }).getByRole("alert"),
  ).toContainText("预览已过期");
  await expect(
    page.getByRole("button", { name: "将缓存所选字段恢复到编辑区" }),
  ).toBeDisabled();
  await preview(page, "预览来源");
  const row = (await cached(page)).find(
    (entry) => JSON.parse(entry.backup).draft.title === "预览来源",
  )!;
  await page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("no-wave-writing-recovery-v1", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(["control", "drafts"], "readwrite"),
          request = tx.objectStore("drafts").get(id),
          control = tx.objectStore("control").get("active");
        control.onsuccess = () => {
          const value = request.result,
            backup = JSON.parse(value.backup);
          backup.draft.title = "另一个操作写下的新版本";
          tx.objectStore("drafts").put({
            ...value,
            revision: control.result.serial + 1,
            backup: JSON.stringify(backup),
          });
          tx.objectStore("control").put(
            { ...control.result, serial: control.result.serial + 1 },
            "active",
          );
        };
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }, row.id);
  await copyPreview(page);
  await expect(region(page).getByRole("alert")).toContainText("未覆盖新版本");
  await expect(page.getByLabel("标题", { exact: true })).toHaveValue("");
  await expect(
    page.getByRole("textbox", { name: "摘要", exact: true }),
  ).toHaveValue("预览后仍继续输入");
});

test("a response lost after server commit is never replayed after refresh; recovered uncertainty requires human review", async ({
  page,
}) => {
  await writer(page);
  await write(page, "响应丢失的已创建作品");
  await enable(page);
  await cache(page, "响应丢失的已创建作品");
  const count = writes(page);
  await page.route("**/api/authoring/articles", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "暂时无法确认作品是否已创建" }),
  ).toBeVisible();
  expect((await cached(page))[0]!.outcomeUnknown).toBe(true);
  expect(count()).toBe(1);
  await page.unroute("**/api/authoring/articles");
  await page.reload();
  await preview(page, "响应丢失的已创建作品");
  await copyPreview(page);
  await expect(region(page).getByRole("alert")).toContainText(
    "已拦截新的保存和发布",
  );
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "先核对服务器作品列表" }),
  ).toBeVisible();
  expect(count()).toBe(1);
  expect(
    (await (await page.request.get("/api/authoring/articles")).json()).data,
  ).toHaveLength(1);
  await region(page)
    .getByRole("checkbox", { name: /我已核对服务器作品/ })
    .check();
  await region(page)
    .getByRole("button", { name: "确认核对并解除保存拦截", exact: true })
    .click();
  await expect(
    region(page).getByRole("checkbox", { name: /我已核对服务器作品/ }),
  ).toHaveCount(0);
  expect(count()).toBe(1);
});

test("success settles only its checkpoint, preserves edits made while saving and removes a fully acknowledged cache", async ({
  page,
}) => {
  await writer(page);
  await write(page, "提交时的标题");
  await enable(page);
  await cache(page, "提交时的标题");
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    received = new Promise<void>((resolve) => {
      arrived = resolve;
    });
  await page.route("**/api/authoring/articles", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    arrived();
    await gate;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await received;
  await page
    .getByRole("textbox", { name: "摘要", exact: true })
    .fill("响应期间继续写的摘要");
  release();
  await expect(
    page.getByRole("status").filter({ hasText: "当前修改尚未保存" }),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const row = (await cached(page))[0];
      return row
        ? {
            summary: JSON.parse(row.backup).draft.summary,
            unknown: row.outcomeUnknown,
            associated: row.base.articleId !== null,
          }
        : null;
    })
    .toEqual({
      summary: "响应期间继续写的摘要",
      unknown: false,
      associated: true,
    });
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "草稿已保存。" }),
  ).toBeVisible();
  await expect.poll(async () => (await cached(page)).length).toBe(0);
});

test("storage denial is visible without destroying memory-only authoring, and the opt-in UI is usable on mobile", async ({
  page,
}) => {
  await writer(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await enable(page);
  await write(page, "移动设备本机稿");
  await cache(page, "移动设备本机稿");
  await preview(page, "移动设备本机稿");
  expect(
    (
      await new AxeBuilder({ page })
        .include('[aria-label="可选本机文稿恢复"]')
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.addInitScript(() => {
    IDBFactory.prototype.open = () => {
      throw new DOMException("denied by browser policy", "SecurityError");
    };
  });
  await page.reload();
  await expect(region(page).getByRole("alert")).toContainText(
    "浏览器拒绝本机存储",
  );
  await write(page, "拒绝存储仍能输入");
  await expect(page.getByLabel("作品正文")).toHaveText(
    "只能由作者手动恢复的正文。",
  );
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "草稿已保存。" }),
  ).toBeVisible();
});

test("a session response started before another tab clears consent cannot resurrect the old editor", async ({
  page,
  context,
}) => {
  await writer(page);
  await write(page, "迟到身份不能复活的稿");
  await enable(page);
  await cache(page, "迟到身份不能复活的稿");
  const other = await context.newPage();
  await other.goto(page.url());
  await expect(region(other).getByRole("status")).toContainText("已启用");
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    received = new Promise<void>((resolve) => {
      arrived = resolve;
    });
  await page.route("**/api/authoring/session", async (route) => {
    const response = await route.fetch();
    arrived();
    await gate;
    await route.fulfill({ response });
  });
  await region(page)
    .getByRole("button", { name: "核对账户并刷新本机列表" })
    .click();
  await received;
  await region(other)
    .getByRole("button", { name: "清除全部本机缓存并关闭", exact: true })
    .click();
  await other
    .getByRole("dialog", { name: "清除全部本机缓存并关闭？" })
    .getByRole("button", { name: "清除缓存并关闭", exact: true })
    .click();
  await expect(region(other).getByRole("status")).toContainText("已关闭");
  release();
  await expect(region(page)).toContainText("此旧标签已失效");
  await expect(
    region(page).getByRole("button", {
      name: "在此设备启用本机恢复",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(await cached(page)).toHaveLength(0);
  await other.close();
});

test("cached remote images stay inert during listing and preview, and loading them requires a separate explicit consent", async ({
  page,
}) => {
  await writer(page);
  await write(page, "远程图片恢复稿");
  await enable(page);
  await cache(page, "远程图片恢复稿");
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("no-wave-writing-recovery-v1", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("drafts", "readwrite"),
          request = tx.objectStore("drafts").getAll();
        request.onsuccess = () => {
          const row = request.result[0],
            backup = JSON.parse(row.backup);
          backup.draft.editorState.root.children.push({
            type: "image",
            version: 1,
            src: "https://recovery-image.example.test/tracking.png",
            alt: "合成恢复测试图片",
            caption: "",
          });
          tx.objectStore("drafts").put({
            ...row,
            backup: JSON.stringify(backup),
          });
        };
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  });
  let images = 0;
  await page.route("https://recovery-image.example.test/**", async (route) => {
    images++;
    await route.fulfill({ status: 404, body: "synthetic image request" });
  });
  await page.reload();
  await preview(page, "远程图片恢复稿");
  const plan = page.getByRole("region", {
    name: "本机缓存恢复预览",
    exact: true,
  });
  await expect(
    plan.getByRole("button", { name: "将缓存所选字段恢复到编辑区" }),
  ).toBeDisabled();
  expect(images).toBe(0);
  await plan
    .getByRole("checkbox", { name: /同意恢复后向 1 张远程图片/ })
    .check();
  await plan
    .getByRole("button", { name: "将缓存所选字段恢复到编辑区" })
    .click();
  await expect.poll(() => images).toBe(1);
  await expect(
    page.getByLabel("作品正文").getByRole("img", { name: "合成恢复测试图片" }),
  ).toBeVisible();
});

test("manual source comparison sees a newer real server revision but never merges, writes or updates the editor's base", async ({
  page,
}) => {
  await writer(page);
  await write(page, "服务器基线标题");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "草稿已保存。" }),
  ).toBeVisible();
  await enable(page);
  await page.getByLabel("标题", { exact: true }).fill("尚未保存的本机标题");
  await cache(page, "尚未保存的本机标题");
  const row = (await cached(page))[0]!,
    id = row.base.articleId!;
  const source = (
    await (await page.request.get("/api/authoring/articles")).json()
  ).data.find((item: { id: string }) => item.id === id);
  const remote = await page.request.put(`/api/authoring/articles/${id}`, {
    headers: { origin: new URL(page.url()).origin },
    data: {
      slug: source.slug,
      expectedRevision: source.revision,
      title: "另一窗口的服务器新标题",
      summary: "服务器新摘要",
      locale: "zh-CN",
      workType: "essay",
      publish: false,
      contentBlocksVersion: 1,
      contentBlocks: [
        { id: "remote-paragraph", type: "paragraph", text: "服务器较新的正文" },
      ],
    },
  });
  expect(remote.status(), await remote.text()).toBe(200);
  const count = writes(page);
  await region(page)
    .getByRole("button", {
      name: "核对来源服务器：尚未保存的本机标题",
      exact: true,
    })
    .click();
  const review = page.getByRole("region", {
    name: "来源服务器只读核对",
    exact: true,
  });
  await expect(review).toContainText("服务器已有更高修订");
  await expect(review).toContainText("另一窗口的服务器新标题");
  await expect(review).toContainText("服务器较新的正文");
  await expect(page.getByLabel("标题", { exact: true })).toHaveValue(
    "尚未保存的本机标题",
  );
  expect(await cached(page)).toEqual([row]);
  expect(count()).toBe(0);
  // It also did not advance the editor's expectedRevision: saving the old base
  // remains a genuine optimistic concurrency conflict, never a silent merge.
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "作品已在其他窗口或导入中更新" }),
  ).toBeVisible();
});

test("a late source detail is discarded when the cache changes during the read", async ({
  page,
}) => {
  await writer(page);
  await write(page, "详情读取前的服务器作品");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "草稿已保存。" }),
  ).toBeVisible();
  await enable(page);
  await page.getByLabel("标题", { exact: true }).fill("待核对来源的本机稿");
  await cache(page, "待核对来源的本机稿");
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    received = new Promise<void>((resolve) => {
      arrived = resolve;
    });
  await page.route(
    "**/api/authoring/catalogue/*?locale=zh-CN",
    async (route) => {
      const response = await route.fetch();
      arrived();
      await gate;
      await route.fulfill({ response });
    },
  );
  await region(page)
    .getByRole("button", {
      name: "核对来源服务器：待核对来源的本机稿",
      exact: true,
    })
    .click();
  await received;
  await page.getByLabel("标题", { exact: true }).fill("读取期间继续输入的新稿");
  await cache(page, "读取期间继续输入的新稿");
  release();
  await expect(region(page).getByRole("alert")).toContainText("预览已过期");
  await expect(
    page.getByRole("region", { name: "来源服务器只读核对", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("标题", { exact: true })).toHaveValue(
    "读取期间继续输入的新稿",
  );
});

test("a new tab opened while logout is waiting cannot leave a post-purge manuscript behind", async ({
  page,
  context,
}) => {
  await writer(page);
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    received = new Promise<void>((resolve) => {
      arrived = resolve;
    });
  await page.route("**/api/auth/logout", async (route) => {
    arrived();
    await gate;
    await route.continue();
  });
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await received;
  const other = await context.newPage();
  await other.goto(page.url());
  await expect(region(other).getByRole("status")).toContainText("已关闭");
  await write(other, "退出请求期间新标签写下的稿");
  await enable(other);
  await cache(other, "退出请求期间新标签写下的稿");
  expect(await cached(other)).toHaveLength(1);
  release();
  await expect(
    page.getByRole("link", { name: "登录或创建账户", exact: true }),
  ).toBeVisible();
  await expect.poll(async () => (await cached(other)).length).toBe(0);
  await expect(region(other)).toContainText("此旧标签已失效");
  await other.close();
});
