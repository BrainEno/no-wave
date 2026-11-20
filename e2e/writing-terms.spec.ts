import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import {
  createWritingBackup,
  parseWritingBackup,
} from "../packages/web-ui/src/lib/writing-backup.ts";
import { createWritingCollection } from "../packages/web-ui/src/lib/writing-collection.ts";
import type { WritingNode } from "../packages/web-ui/src/lib/writing-document.ts";
import { test } from "./support/article-view-stack.ts";
const stamp = new Date("2026-11-12T00:00:00Z");
const rules = JSON.stringify({
  format: "no-wave-writing-terms",
  version: 1,
  rules: [
    { preferred: "No Wave", alternatives: ["NoWave"], boundary: "substring" },
    { preferred: "Wave", alternatives: [], boundary: "substring" },
    { preferred: "No Wave", alternatives: [], boundary: "substring" },
    { preferred: "NEVER_SEEN_PRIVATE", alternatives: [], boundary: "word" },
  ],
});
const paragraph = (text: string): WritingNode => ({
  type: "paragraph",
  version: 1,
  children: [{ type: "text", version: 1, text }],
});
async function collection(texts: string[][]) {
  return (
    await createWritingCollection(
      texts.map((lines, index) => ({
        group: String(index),
        backup: parseWritingBackup(
          createWritingBackup(
            {
              title: `PRIVATE_TITLE_${index}`,
              summary: "PRIVATE_SUMMARY",
              locale: "en",
              workType: "essay",
              editorState: {
                root: {
                  type: "root",
                  version: 1,
                  children: lines.map(paragraph),
                },
              },
            },
            stamp,
          ),
        ),
      })),
      stamp,
    )
  ).text;
}
async function start(page: Page) {
  await page.goto(
    "/write/terms?file=https%3A%2F%2Fprivate-terms.example.test%2FNEVER_READ.json&recipe=PRIVATE_URL",
  );
  await expect(page).toHaveURL(/\/write\/terms$/);
  await expect(
    page.getByRole("heading", { name: "本机术语一致性审阅", exact: true }),
  ).toBeVisible();
}
async function load(
  page: Page,
  texts = [["🦊 No Wave then NoWave.", "No Wave"], ["NoWave WAVE"]],
) {
  await page
    .getByLabel("术语审阅备份或集合文件", { exact: true })
    .setInputFiles({
      name: "PRIVATE_SOURCE.json",
      mimeType: "application/json",
      buffer: Buffer.from(await collection(texts)),
    });
  await expect(
    page
      .getByRole("region", { name: "术语审阅来源", exact: true })
      .getByRole("status"),
  ).toContainText("来源校验通过");
  await page.getByLabel("术语词表 JSON 草稿", { exact: true }).fill(rules);
}
async function analyze(page: Page) {
  await page
    .getByRole("button", { name: "分析本机术语分布", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "本机术语命中审阅", exact: true }),
  ).toBeVisible();
}
async function prepare(page: Page) {
  await page
    .getByRole("button", { name: "准备术语无明文报告", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "下载术语无明文报告", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel("我已核对术语报告的全局范围、未覆盖前沿与隐私限制", {
      exact: true,
    })
    .check();
}

test("匿名离线审阅保留同形、包含、重叠与原文位置，按文稿筛选不会缩小手动无明文报告", async ({
  page,
}) => {
  await start(page);
  await load(page);
  await page.context().setOffline(true);
  await analyze(page);
  const review = page.getByRole("region", {
    name: "本机术语命中审阅",
    exact: true,
  });
  await expect(review.getByRole("status")).toContainText("全局 10 个命中主张");
  await expect(
    page.getByLabel("词表同形包含关系", { exact: true }),
  ).toContainText("同形于");
  const trigger = page.getByRole("button", {
    name: "定位术语 m1",
    exact: true,
  });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const detail = page.getByLabel("术语原文定位详情", { exact: true });
  await expect(detail).toBeFocused();
  await expect(detail).toContainText("UTF-16 [3, 10) / 代码点 [2, 9)");
  await expect(detail.locator("mark[data-selected]")).not.toHaveCount(0);
  await page
    .getByRole("button", { name: "关闭术语定位并返回触发按钮", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(trigger).toBeFocused();
  await page.getByLabel("术语文稿筛选", { exact: true }).selectOption("d2");
  await expect(
    page.getByLabel("术语命中清单", { exact: true }).locator(":scope > li"),
  ).toHaveCount(2);
  await page
    .getByRole("button", { name: "将本页术语标记为有意使用", exact: true })
    .click();
  await expect(review.getByRole("status")).toContainText(
    "已标记 2 个，尚未核对 8 个",
  );
  await prepare(page);
  const event = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "下载术语无明文报告", exact: true })
    .click();
  const downloaded = await event,
    path = await downloaded.path();
  expect(path).not.toBeNull();
  const text = await readFile(path!, "utf8"),
    report = JSON.parse(text);
  expect(report.matches).toHaveLength(10);
  expect(report.review.unreviewed).toBe(8);
  expect(text).not.toMatch(
    /No Wave|NoWave|PRIVATE|SUMMARY|TITLE|never\.png|children|needle|preferred|alternatives/,
  );
  expect(downloaded.suggestedFilename()).toMatch(
    /^no-wave-terms-report-\d{4}-\d{2}-\d{2}\.json$/,
  );
  await page.getByLabel("术语词表 JSON 草稿", { exact: true }).fill("{");
  await expect(review).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "下载术语无明文报告", exact: true }),
  ).toHaveCount(0);
});

test("ASCII 模式不猜全半角繁简，修改规则/条件与同文件重选同步撤销旧标记和下载", async ({
  page,
}) => {
  await start(page);
  await load(page, [["No Wave no wave Ｎｏ Ｗａｖｅ"]]);
  await analyze(page);
  await expect(
    page
      .getByRole("region", { name: "本机术语命中审阅", exact: true })
      .getByRole("status"),
  ).toContainText("全局 3 个");
  await prepare(page);
  await page
    .getByLabel("术语文字模式", { exact: true })
    .selectOption("ascii-fold");
  await expect(
    page.getByRole("button", { name: "下载术语无明文报告", exact: true }),
  ).toHaveCount(0);
  await analyze(page);
  await expect(
    page
      .getByRole("region", { name: "本机术语命中审阅", exact: true })
      .getByRole("status"),
  ).toContainText("全局 6 个");
  await prepare(page);
  await load(page, [["No Wave no wave Ｎｏ Ｗａｖｅ"]]);
  await expect(
    page.getByRole("button", { name: "下载术语无明文报告", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "本机术语命中审阅", exact: true }),
  ).toHaveCount(0);
});

test("严格词表导入拒绝重复字段、错误 UTF-8 与超限输入，不借用旧词表继续分析", async ({
  page,
}) => {
  await start(page);
  await load(page);
  await analyze(page);
  const input = page.getByLabel("术语词表 JSON 文件", { exact: true });
  await input.setInputFiles({
    name: "broken.json",
    mimeType: "application/json",
    buffer: Buffer.from([0xc3, 0x28]),
  });
  await expect(page.getByRole("alert")).toContainText("UTF-8");
  await expect(
    page.getByRole("button", { name: "分析本机术语分布", exact: true }),
  ).toBeDisabled();
  await input.setInputFiles({
    name: "duplicate.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      '{"format":"no-wave-writing-terms","version":2,"version":1,"rules":[]}',
    ),
  });
  await expect(page.getByRole("alert")).toContainText("重复");
  await input.setInputFiles({
    name: "huge.json",
    mimeType: "application/json",
    buffer: Buffer.alloc(128 * 1024 + 1, 32),
  });
  await expect(page.getByRole("alert")).toContainText("128 KiB");
  await input.setInputFiles({
    name: "valid.json",
    mimeType: "application/json",
    buffer: Buffer.from(rules),
  });
  await expect(
    page.getByLabel("术语词表 JSON 草稿", { exact: true }),
  ).toHaveValue(rules);
  await analyze(page);
});

test("不完整预算前沿明确可见，取消与同步隐私清除不会复活结果；离页返回不自动重读", async ({
  page,
}) => {
  await start(page);
  await load(page, [["No Wave ".repeat(1800)]]);
  await analyze(page);
  await expect(
    page
      .getByRole("region", { name: "术语覆盖与未扫描范围", exact: true })
      .getByRole("status"),
  ).toContainText("未扫描前沿");
  await expect(
    page.getByRole("region", { name: "本机术语命中审阅", exact: true }),
  ).toContainText("下界");
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await expect(
    page.getByLabel("术语词表 JSON 草稿", { exact: true }),
  ).toHaveValue("");
  await expect(page.locator("body")).not.toContainText("PRIVATE_SOURCE.json");
  await load(page);
  await analyze(page);
  await page.getByRole("link", { name: "本机集合工具", exact: true }).click();
  await expect(page).toHaveURL(/\/write\/collections$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/write\/terms$/);
  await expect(
    page.getByLabel("术语词表 JSON 草稿", { exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByRole("region", { name: "本机术语命中审阅", exact: true }),
  ).toHaveCount(0);
  await load(page, [["No Wave ".repeat(3000)]]);
  await page
    .getByRole("button", { name: "分析本机术语分布", exact: true })
    .click();
  await page
    .getByRole("button", { name: "停止术语读取或分析", exact: true })
    .click();
  await expect(
    page.getByText("已取消，旧结果、标记与报告已失效", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "本机术语命中审阅", exact: true }),
  ).toHaveCount(0);
});

test("正文和恶意词条只作惰性文字，未产生应用/媒体请求或浏览器存储；窄屏键盘与 axe 可用", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (
      new URL(request.url()).hostname === "private-terms.example.test" ||
      new URL(request.url()).pathname.startsWith("/api/")
    )
      requests.push(request.url());
  });
  await page.addInitScript(() => {
    (window as unknown as { termsExecuted: boolean }).termsExecuted = false;
  });
  await start(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const hostile =
    '<img src="https://private-terms.example.test/never.png" onerror="window.termsExecuted=true">';
  await load(page, [[hostile + " No Wave"]]);
  await page.getByLabel("术语词表 JSON 草稿", { exact: true }).fill(
    JSON.stringify({
      format: "no-wave-writing-terms",
      version: 1,
      rules: [
        {
          preferred: hostile.slice(0, 70),
          alternatives: [],
          boundary: "substring",
        },
      ],
    }),
  );
  await analyze(page);
  await page.getByRole("button", { name: "定位术语 m1", exact: true }).click();
  expect(
    await page.evaluate(
      () => (window as unknown as { termsExecuted: boolean }).termsExecuted,
    ),
  ).toBe(false);
  expect(requests).toEqual([]);
  expect(
    await page.evaluate(() => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
      overflow: document.documentElement.scrollWidth > innerWidth,
    })),
  ).toEqual({ local: [], session: [], overflow: false });
  const accessibility = await new AxeBuilder({ page })
    .include(".nw-terms")
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await page
    .getByRole("button", { name: "关闭术语定位并返回触发按钮", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "定位术语 m1", exact: true }),
  ).toBeFocused();
});

test("拼写组合画像不把折叠同形当作多种拼写，文稿对照仅比较观察集合并保留全部报告主张", async ({
  page,
}) => {
  await start(page);
  await load(page, [["US us USA"], ["us"], ["nothing"]]);
  await page.getByLabel("术语词表 JSON 草稿", { exact: true }).fill(
    JSON.stringify({
      format: "no-wave-writing-terms",
      version: 1,
      rules: [
        { preferred: "US", alternatives: ["us", "USA"], boundary: "word" },
      ],
    }),
  );
  await page
    .getByLabel("术语文字模式", { exact: true })
    .selectOption("ascii-fold");
  await analyze(page);
  const usage = page.getByRole("region", {
    name: "术语拼写组合画像",
    exact: true,
  });
  await expect(usage).toContainText("全局观察到 2 个拼写类");
  await expect(usage).toContainText("同篇出现多个类的文稿：d1");
  await expect(
    page.getByRole("table", {
      name: "文稿 d1 / d2 的已观察拼写集合对照",
      exact: true,
    }),
  ).toContainText("已观察组合不同");
  await page.getByLabel("拼写对照右文稿", { exact: true }).selectOption("d1");
  await expect(usage).toContainText("请选择两篇不同的文稿，未自动跳到其他文稿");
  await expect(
    page
      .getByRole("region", { name: "本机术语命中审阅", exact: true })
      .getByRole("status"),
  ).toContainText("全局 7 个");
  await prepare(page);
});
