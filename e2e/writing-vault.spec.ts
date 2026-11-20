import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import {
  createWritingBackup,
  parseWritingBackup,
} from "../packages/web-ui/src/lib/writing-backup.ts";
import { createWritingCollection } from "../packages/web-ui/src/lib/writing-collection.ts";
import { analyzeWritingMerge } from "../packages/web-ui/src/lib/writing-merge.ts";
import { createWritingMergePlan } from "../packages/web-ui/src/lib/writing-merge-plan.ts";
import { WritingVaultCryptography } from "../packages/web-ui/src/lib/writing-vault-crypto.ts";
import { test } from "./support/article-view-stack.ts";

const stamp = new Date("2026-11-12T00:00:00.000Z");
const password = "fixture only 文稿 correct horse";
const nextPassword = "replacement fixture 文稿 battery";
const original = (title = "PRIVATE_TITLE", body = "PRIVATE_BODY") =>
  "\ufeff " +
  createWritingBackup(
    {
      title,
      summary: "PRIVATE_SUMMARY",
      locale: "zh-CN",
      workType: "essay",
      editorState: {
        root: {
          type: "root",
          version: 1,
          children: [
            {
              type: "paragraph",
              version: 1,
              children: [{ type: "text", version: 1, text: body }],
            },
            {
              type: "image",
              version: 1,
              src: "https://private-vault.example.test/NEVER_FETCH.png",
              alt: "PRIVATE_ALT",
            },
          ],
        },
      },
    },
    stamp,
  ) +
  "\r\n";
const inputBytes = (text: string) => new TextEncoder().encode(text);
const vault = (page: Page) =>
  page.getByRole("region", { name: "本机文稿加密备份工作台", exact: true });
const output = (page: Page) =>
  page.getByRole("region", { name: "本机加密工具的已校验输出", exact: true });
const review = (page: Page) =>
  page.getByRole("region", { name: "本机载荷只读复核", exact: true });
async function start(page: Page) {
  await page.goto(
    "/write/vault?file=https%3A%2F%2Fprivate-vault.example.test%2Fnever.json&password=NEVER_USE",
  );
  await expect(page).toHaveURL(/\/write\/vault$/);
  await expect(
    page.getByRole("heading", { name: "本机文稿加密备份", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "专用本机工作线程已就绪" }),
  ).toBeVisible();
}
async function load(
  page: Page,
  buffer: Uint8Array | string,
  name = "PRIVATE_ORIGINAL.json",
) {
  await page.getByLabel("本机 JSON 或加密文件", { exact: true }).setInputFiles({
    name,
    mimeType: name.endsWith(".nwvault")
      ? "application/octet-stream"
      : "application/json",
    buffer: Buffer.from(buffer),
  });
  await expect(
    page.getByRole("region", { name: "当前明确选择的文件", exact: true }),
  ).toBeVisible();
}
async function seal(page: Page) {
  await page.getByLabel("新加密口令", { exact: true }).fill(password);
  await page.getByLabel("再次输入新口令", { exact: true }).fill(password);
  await page.getByLabel("我理解忘记口令无法恢复", { exact: false }).check();
  await page
    .getByRole("button", { name: "加密并回解自检", exact: true })
    .click();
  await expect(output(page)).toContainText("已从实际封装的密文回解");
  await expect(review(page)).toHaveCount(0);
}
async function download(page: Page, plain = false): Promise<Buffer> {
  await output(page).getByRole("checkbox").check();
  const pending = page.waitForEvent("download");
  await page
    .getByRole("button", {
      name: plain ? "下载解密后的原始 JSON" : "下载新加密副本",
      exact: true,
    })
    .click();
  const saved = await pending;
  expect(saved.suggestedFilename()).toBe(
    plain
      ? "no-wave-decrypted-backup.json"
      : "no-wave-encrypted-writing-v1.nwvault",
  );
  const path = await saved.path();
  expect(path).not.toBeNull();
  return readFile(path!);
}
async function encrypted(text = original()): Promise<Uint8Array<ArrayBuffer>> {
  return (
    await new WritingVaultCryptography().seal(
      inputBytes(text),
      password,
      new AbortController().signal,
    )
  ).bytes;
}

test("native Worker encryption, explicit download/readback and offline unlock preserve exact original bytes and never fetch file URLs", async ({
  page,
  context,
}) => {
  const remote: string[] = [],
    writes: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).hostname === "private-vault.example.test")
      remote.push(request.url());
    if (
      !["GET", "HEAD"].includes(request.method()) &&
      !request.url().startsWith("blob:")
    )
      writes.push(request.method());
  });
  await start(page);
  const text = original(
    "PRIVATE_TITLE",
    "<script>globalThis.PRIVATE_ATTACK=true</script> 中文🙂",
  );
  await load(page, text);
  await expect(review(page)).toContainText("PRIVATE_TITLE");
  await expect(review(page).locator("img,script,iframe")).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (globalThis as unknown as { PRIVATE_ATTACK?: boolean }).PRIVATE_ATTACK,
    ),
  ).toBeUndefined();
  await context.setOffline(true);
  try {
    await seal(page);
    await expect(vault(page)).not.toContainText("PRIVATE_TITLE");
    const locked = await download(page);
    expect(locked.includes(Buffer.from("PRIVATE_TITLE"))).toBe(false);
    await page
      .getByLabel("重新选择已下载的副本", { exact: true })
      .setInputFiles({
        name: "renamed.bin",
        mimeType: "application/octet-stream",
        buffer: locked,
      });
    await expect(
      page.getByRole("region", { name: "手动下载副本复读核对", exact: true }),
    ).toContainText("所选副本与本次输出逐字节一致");
    await load(page, locked, "locked.nwvault");
    await page.getByLabel("解密口令", { exact: true }).fill(password);
    await page.getByRole("button", { name: "解密并预览", exact: true }).click();
    await expect(review(page)).toContainText("PRIVATE_TITLE");
    await expect(page.getByLabel("解密口令", { exact: true })).toHaveValue("");
    expect(await download(page, true)).toEqual(Buffer.from(text));
    expect(remote).toEqual([]);
    expect(writes).toEqual([]);
  } finally {
    await context.setOffline(false);
  }
});

test("wrong password, damaged authentication tag and illegal KDF parameters return no plaintext, with empty password DOM", async ({
  page,
}) => {
  await start(page);
  const good = await encrypted();
  await load(page, good, "locked.nwvault");
  await page
    .getByLabel("解密口令", { exact: true })
    .fill("wrong fixture 文稿 password");
  await page.getByRole("button", { name: "解密并预览", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("认证失败");
  await expect(review(page)).toHaveCount(0);
  await expect(output(page)).toHaveCount(0);
  await expect(page.getByLabel("解密口令", { exact: true })).toHaveValue("");
  const damaged = good.slice();
  damaged[damaged.length - 1]! ^= 1;
  await load(page, damaged, "damaged.nwvault");
  await page.getByLabel("解密口令", { exact: true }).fill(password);
  await page.getByRole("button", { name: "解密并预览", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("认证失败");
  await expect(vault(page)).not.toContainText("PRIVATE_TITLE");
  const illegal = Buffer.from(good),
    header = illegal.subarray(12, 12 + illegal.readUInt32BE(8));
  const offset = header.indexOf(Buffer.from("600000"));
  expect(offset).toBeGreaterThan(0);
  Buffer.from("999999").copy(illegal, 12 + offset);
  await page.getByLabel("本机 JSON 或加密文件", { exact: true }).setInputFiles({
    name: "expensive.nwvault",
    mimeType: "application/octet-stream",
    buffer: illegal,
  });
  await expect(page.getByRole("alert")).toContainText("没有启动密码计算");
  await expect(
    page.getByRole("region", { name: "当前明确选择的文件", exact: true }),
  ).toHaveCount(0);
});

test("verify-only and manual password rotation never expose a plaintext result or discard the original encrypted file", async ({
  page,
}) => {
  const originalBytes = await encrypted();
  await start(page);
  await load(page, originalBytes, "old.nwvault");
  await page.getByLabel("解密口令", { exact: true }).fill(password);
  await page
    .getByRole("button", { name: "只验证，不展开文稿", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "仅核验的无正文结果", exact: true }),
  ).toContainText("未保留明文字节");
  await expect(review(page)).toHaveCount(0);
  await expect(output(page)).toHaveCount(0);
  await expect(vault(page)).not.toContainText("PRIVATE_TITLE");
  await page.getByLabel("更换口令，不输出明文", { exact: true }).check();
  await page.getByLabel("原解密口令", { exact: true }).fill(password);
  await page.getByLabel("替换加密口令", { exact: true }).fill(nextPassword);
  await page.getByLabel("再次输入新口令", { exact: true }).fill(nextPassword);
  await page.getByLabel("我理解忘记口令无法恢复", { exact: false }).check();
  await page
    .getByRole("button", { name: "认证并另存新口令副本", exact: true })
    .click();
  await expect(output(page)).toContainText("已从实际封装的密文回解");
  await expect(review(page)).toHaveCount(0);
  const rotated = await download(page);
  const native = new WritingVaultCryptography(),
    signal = new AbortController().signal;
  expect(
    (await native.open(new Uint8Array(rotated), nextPassword, signal)).bytes,
  ).toEqual(inputBytes(original()));
  await expect(
    native.open(new Uint8Array(rotated), password, signal),
  ).rejects.toMatchObject({ code: "authentication" });
  expect((await native.open(originalBytes, password, signal)).bytes).toEqual(
    inputBytes(original()),
  );
});

test("collection and source-bound decision plans use their existing validators; view filters cannot alter the encrypted membership", async ({
  page,
}) => {
  const backup = parseWritingBackup(original());
  const collection = await createWritingCollection(
    [
      { group: "one", backup },
      {
        group: "two",
        backup: parseWritingBackup(original("OTHER_PRIVATE_TITLE")),
      },
    ],
    stamp,
  );
  await start(page);
  await load(page, collection.text);
  await page.getByLabel("复核标题或摘要筛选", { exact: true }).fill("OTHER_");
  await expect(review(page)).toContainText("筛选可见 1 / 2 篇");
  await seal(page);
  const opened = await new WritingVaultCryptography().open(
    new Uint8Array(await download(page)),
    password,
    new AbortController().signal,
  );
  expect(opened.review.documents).toHaveLength(2);
  expect(opened.bytes).toEqual(inputBytes(collection.text));
  const analysis = await analyzeWritingMerge({
    base: backup,
    current: backup,
    incoming: backup,
  });
  const plan = await createWritingMergePlan(
    analysis,
    [{ unit: analysis.units[0]!.id, choice: "base" }],
    stamp,
  );
  await load(page, plan.text);
  await expect(
    page.getByRole("region", {
      name: "加密工作台中的只读取舍计划",
      exact: true,
    }),
  ).toContainText("必须回三方工作台重新选择三份原文件");
  await seal(page);
  const decoded = await new WritingVaultCryptography().open(
    new Uint8Array(await download(page)),
    password,
    new AbortController().signal,
  );
  expect(decoded.review.kind).toBe("merge-plan");
  expect(decoded.bytes).toEqual(inputBytes(plan.text));
});

test("a real completed Worker reply delayed past cancellation cannot revive output or bypass the single-flight fence", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = Worker.prototype.addEventListener;
    const state = globalThis as unknown as {
      holdVault: boolean;
      heldVaultReplies: (() => void)[];
    };
    state.holdVault = false;
    state.heldVaultReplies = [];
    Worker.prototype.addEventListener = function (
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (listener === null) return;
      if (type !== "message" || typeof listener !== "function")
        return original.call(this, type, listener, options);
      return original.call(
        this,
        type,
        (event: Event) => {
          const data: unknown = (event as MessageEvent).data;
          if (
            state.holdVault &&
            data &&
            typeof data === "object" &&
            (data as { kind: string }).kind === "complete"
          )
            state.heldVaultReplies.push(() => listener.call(this, event));
          else listener.call(this, event);
        },
        options,
      );
    };
  });
  await start(page);
  await load(page, original());
  await page.evaluate(() => {
    (globalThis as unknown as { holdVault: boolean }).holdVault = true;
  });
  await page.getByLabel("新加密口令", { exact: true }).fill(password);
  await page.getByLabel("再次输入新口令", { exact: true }).fill(password);
  await page.getByLabel("我理解忘记口令无法恢复", { exact: false }).check();
  await page
    .getByRole("button", { name: "加密并回解自检", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (globalThis as unknown as { heldVaultReplies: unknown[] })
            .heldVaultReplies.length,
      ),
    )
    .toBe(1);
  await page
    .getByRole("button", { name: "取消当前读取或密码操作", exact: true })
    .click();
  await expect(output(page)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "加密并回解自检", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "清除全部文件与结果", exact: true })
    .click();
  await page.evaluate(() => {
    const state = globalThis as unknown as {
      holdVault: boolean;
      heldVaultReplies: (() => void)[];
    };
    state.holdVault = false;
    for (const deliver of state.heldVaultReplies.splice(0)) deliver();
  });
  await expect(
    page.getByRole("status").filter({ hasText: "专用本机工作线程已就绪" }),
  ).toBeVisible();
  await expect(output(page)).toHaveCount(0);
  await expect(review(page)).toHaveCount(0);
});

test("page lifecycle and full-document CSP navigation clear both plaintext and password DOM, without creating persistent vault state", async ({
  page,
}) => {
  await start(page);
  const before = await page.evaluate(async () => ({
    local: Object.keys(localStorage).sort(),
    databases: (await indexedDB.databases()).map((item) => item.name).sort(),
  }));
  await load(page, original());
  await page.getByLabel("新加密口令", { exact: true }).fill(password);
  await page.getByLabel("在屏幕上显示本次口令", { exact: false }).check();
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent("pagehide")),
  );
  await expect(review(page)).toHaveCount(0);
  await expect(page.locator(".nw-vault-password input")).toHaveCount(0);
  await page.evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    ),
  );
  await expect(vault(page)).not.toContainText("PRIVATE_TITLE");
  await load(page, original());
  const moved = page.waitForResponse(
    (response) =>
      response.request().isNavigationRequest() &&
      new URL(response.url()).pathname === "/write/collections",
  );
  await page.getByRole("link", { name: "本机集合工具", exact: true }).click();
  expect((await moved).headers()["content-security-policy"]).toContain(
    "worker-src 'none'",
  );
  // Real history traversal is checked whether Chromium reloads or admits BFCache;
  // the synthetic persisted event above separately exercises its synchronous fence.
  await page.goBack();
  await expect(vault(page)).not.toContainText("PRIVATE_TITLE");
  await expect(page.locator(".nw-vault-password input")).toHaveCount(0);
  await page.goForward();
  await expect(page).toHaveURL(/\/write\/collections$/);
  const returned = page.waitForResponse(
    (response) =>
      response.request().isNavigationRequest() &&
      new URL(response.url()).pathname === "/write/vault",
  );
  await page.getByRole("link", { name: "本机加密备份", exact: true }).click();
  expect((await returned).headers()["content-security-policy"]).toContain(
    "worker-src 'self'",
  );
  await expect(vault(page)).not.toContainText("PRIVATE_TITLE");
  expect(
    await page.evaluate(async () => ({
      local: Object.keys(localStorage).sort(),
      databases: (await indexedDB.databases()).map((item) => item.name).sort(),
    })),
  ).toEqual(before);
});

test("keyboard-labelled controls remain accessible at phone width and long private literals do not overflow or become HTML", async ({
  page,
}) => {
  await start(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await load(
    page,
    original(
      "PRIVATE_" + "x".repeat(190),
      '<a href="https://private-vault.example.test">not a link</a>',
    ),
  );
  await expect(
    review(page).locator("a[href*='private-vault'],img,script"),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  const results = await new AxeBuilder({ page }).include(".nw-vault").analyze();
  expect(results.violations).toEqual([]);
});

test("large raw JSON is paged by UTF-8 bytes, bounded literal matches navigate without modifying any output, and closing clears its private query", async ({
  page,
}) => {
  await start(page);
  const text = original("PRIVATE_PAGED", "中文🙂[a.*]".repeat(5000));
  await load(page, text);
  await page
    .getByText("查看原始 JSON（分页纯文字，含私密内容）", { exact: true })
    .click();
  const raw = page.getByRole("region", {
    name: "原始 JSON 分页文字",
    exact: true,
  });
  await expect(raw).toContainText("正在显示 [0,");
  await raw
    .getByRole("button", { name: "最后一页原始文字", exact: true })
    .click();
  await expect(
    raw.getByRole("button", { name: "下一页原始文字", exact: true }),
  ).toBeDisabled();
  await raw
    .getByLabel("原始 JSON 字面检索", { exact: true })
    .fill("中文🙂[a.*]");
  await raw
    .getByRole("button", { name: "从文件开头检索", exact: true })
    .click();
  const results = page.getByRole("region", {
    name: "原始 JSON 字节检索结果",
    exact: true,
  });
  await expect(results).toContainText("显示 100 处匹配");
  await expect(results.getByRole("button")).toHaveCount(100);
  await raw
    .getByRole("button", { name: "继续检索后续偏移", exact: true })
    .click();
  await expect(results).toContainText("显示 100 处匹配");
  await page
    .getByText("查看原始 JSON（分页纯文字，含私密内容）", { exact: true })
    .click();
  await expect(raw).toHaveCount(0);
  await page
    .getByText("查看原始 JSON（分页纯文字，含私密内容）", { exact: true })
    .click();
  await expect(
    raw.getByLabel("原始 JSON 字面检索", { exact: true }),
  ).toHaveValue("");
  await expect(results).toHaveCount(0);
  await seal(page);
  expect(
    (
      await new WritingVaultCryptography().open(
        new Uint8Array(await download(page)),
        password,
        new AbortController().signal,
      )
    ).bytes,
  ).toEqual(inputBytes(text));
});
