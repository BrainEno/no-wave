import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { cadenceSource } from "../packages/web-ui/src/lib/writing-cadence-test-support.ts";
import type { WritingNode } from "../packages/web-ui/src/lib/writing-document.ts";
import { test } from "./support/article-view-stack.ts";

const texts: (string | WritingNode)[][] = [
  [
    "🦊（「甲」） ([)] ] \u202e\u200b。",
    "甲。乙。丙。",
    {
      type: "image",
      version: 1,
      src: "https://never-cadence.example.test/never.png",
      alt: "PRIVATE_IMAGE",
    },
  ],
  ["乙！！"],
];
async function start(page: Page) {
  await page.goto(
    "/write/cadence?file=https%3A%2F%2Fnever-cadence.example.test%2FPRIVATE_SOURCE&dot=true",
  );
  await expect(page).toHaveURL(/\/write\/cadence$/);
  await expect(
    page.getByRole("heading", { name: "本机标点与停顿节奏审阅", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("将 ASCII 句点也作为停顿（仅保护两侧数字的小数点）", {
      exact: true,
    }),
  ).not.toBeChecked();
}
async function load(page: Page, documents = texts) {
  const input = page.getByLabel("标点审阅备份或集合文件", { exact: true });
  await expect(input).toBeEnabled();
  await input.setInputFiles({
    name: "PRIVATE_LOCAL.json",
    mimeType: "application/json",
    buffer: Buffer.from((await cadenceSource(documents)).prepared.text),
  });
  await expect(
    page
      .getByRole("region", { name: "标点审阅来源", exact: true })
      .getByRole("status"),
  ).toContainText("来源校验通过");
}
async function analyze(page: Page) {
  await page
    .getByRole("button", { name: "分析本机标点与节奏", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "本机标点只读审阅", exact: true }),
  ).toBeVisible();
}
async function prepare(page: Page) {
  await page
    .getByRole("button", { name: "准备标点无正文报告", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "下载标点无正文报告", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel("我已核对标点报告的全局范围、未扫描前沿与元数据隐私风险", {
      exact: true,
    })
    .check();
}

test("匿名离线保留越栈/嵌套与原始坐标，来源URL和媒体不被请求；全局无正文报告不随筛选缩小", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).hostname === "never-cadence.example.test")
      requests.push(request.url());
  });
  await start(page);
  await load(page);
  await page.context().setOffline(true);
  await analyze(page);
  const review = page.getByRole("region", {
    name: "本机标点只读审阅",
    exact: true,
  });
  await expect(review.getByRole("status")).toContainText(
    "全局 6 项观察 / 3 个配对 / 5 个片段",
  );
  await expect(
    page.getByLabel("标点原文安全定位", { exact: true }),
  ).toHaveCount(0);
  const trigger = page.getByRole("button", {
    name: "定位标点项目 f2",
    exact: true,
  });
  await trigger.click();
  const detail = page.getByLabel("标点原文安全定位", { exact: true });
  await expect(detail).toBeFocused();
  await expect(detail).toContainText("UTF-16 [10, 11) / 代码点 [9, 10)");
  await expect(detail).toContainText("⟦U+202E⟧");
  await expect(detail.locator("mark[data-related]")).toHaveCount(2);
  expect(
    await page
      .locator("body")
      .evaluate((element) => element.textContent!.includes("\u202e")),
  ).toBe(false);
  await page
    .getByRole("button", { name: "关闭标点定位并返回触发按钮", exact: true })
    .click();
  await expect(trigger).toBeFocused();
  await page.getByLabel("标点列表文稿", { exact: true }).selectOption("d2");
  await expect(
    page.getByLabel("标点与片段清单", { exact: true }).locator(":scope > li"),
  ).toHaveCount(1);
  await page
    .getByRole("button", { name: "将本页标点项目标记为有意使用", exact: true })
    .click();
  await prepare(page);
  const downloadEvent = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "下载标点无正文报告", exact: true })
    .click();
  const download = await downloadEvent,
    path = await download.path();
  expect(path).not.toBeNull();
  const text = await readFile(path!, "utf8"),
    report = JSON.parse(text);
  expect(report.findings).toHaveLength(6);
  expect(report.pairs).toHaveLength(3);
  expect(report.fragments).toHaveLength(5);
  expect(report.review.marked).toBe(1);
  expect(report.review.unreviewed).toBe(13);
  expect(text).not.toMatch(
    /PRIVATE|never-cadence|children|U\+202E|U\+200B|🦊|「甲」/,
  );
  expect(download.suggestedFilename()).toMatch(
    /^no-wave-cadence-report-\d{4}-\d{2}-\d{2}\.json$/,
  );
  expect(requests).toEqual([]);
  await expect(page.locator('img[src*="never-cadence"]')).toHaveCount(0);
});

test("同直方图不冒充同顺序；明确两篇后才对照，单元轮廓和片段定位保持有界", async ({
  page,
}) => {
  const short = "短。",
    long = "長".repeat(40) + "。";
  await start(page);
  await load(page, [
    [short + long + short + long],
    [short + short + long + long],
  ]);
  await page.getByLabel("长片段阈值（含）", { exact: true }).fill("30");
  await analyze(page);
  await expect(
    page.getByLabel("两稿节奏观察对照", { exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("左侧节奏文稿", { exact: true }).selectOption("d1");
  await page.getByLabel("右侧节奏文稿", { exact: true }).selectOption("d2");
  const compare = page.getByLabel("两稿节奏观察对照", { exact: true });
  await expect(compare).toContainText("最大经验CDF差0/16");
  await expect(compare).toContainText("相同直方图仍可能顺序不同");
  const table = page.getByRole("table", {
    name: "各篇全局画像（不受列表筛选影响）",
    exact: true,
  });
  await expect(table.locator("tbody tr").nth(0)).toContainText("2/2/3");
  await expect(table.locator("tbody tr").nth(1)).toContainText("2/2/1");
  await page
    .getByRole("button", { name: "展开单元节奏轮廓", exact: true })
    .click();
  await page.getByRole("button", { name: /^定位最长片段 s2/ }).click();
  await expect(
    page.getByLabel("标点原文安全定位", { exact: true }),
  ).toContainText("s2");
  await page.getByLabel("右侧节奏文稿", { exact: true }).selectOption("d1");
  await expect(page.getByRole("alert")).toContainText("请选择两篇不同文稿");
  await expect(compare).toHaveCount(0);
});

test("原生文件拒绝错误UTF-8、重复字段与超限；无效中间条件和同文件重选同步撤权", async ({
  page,
}) => {
  await start(page);
  await load(page);
  await analyze(page);
  await prepare(page);
  await page.getByLabel("长片段阈值（含）", { exact: true }).fill("");
  await expect(
    page.getByRole("region", { name: "本机标点只读审阅", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "下载标点无正文报告", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "分析本机标点与节奏", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("长片段阈值（含）", { exact: true }).fill("120");
  await analyze(page);
  await prepare(page);
  await load(page);
  await expect(
    page.getByRole("button", { name: "下载标点无正文报告", exact: true }),
  ).toHaveCount(0);
  const input = page.getByLabel("标点审阅备份或集合文件", { exact: true });
  await input.setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from([0xc3, 0x28]),
  });
  await expect(page.getByRole("alert")).toContainText("UTF-8");
  await input.setInputFiles({
    name: "ambiguous.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"format":0,"format":1}'),
  });
  await expect(page.getByRole("alert")).toContainText("重复");
  await input.setInputFiles({
    name: "huge.json",
    mimeType: "application/json",
    buffer: Buffer.alloc(16 * 1024 * 1024 + 1, 32),
  });
  await expect(page.getByRole("alert")).toContainText("16 MiB");
});

test("超出观察预算不提交半个单元，未扫描前沿和零值清楚可见；隐私过渡同步清空", async ({
  page,
}) => {
  await start(page);
  await load(page, [["先。", "\u200b".repeat(5001)], ["尾。"]]);
  await analyze(page);
  const coverage = page.getByRole("region", {
    name: "标点扫描覆盖",
    exact: true,
  });
  await expect(coverage.getByRole("status")).toContainText(
    "未扫描前沿：合格单元序号1",
  );
  await expect(coverage).toContainText("findings");
  await expect(
    page
      .getByRole("region", { name: "本机标点只读审阅", exact: true })
      .getByRole("status"),
  ).toContainText("全局 0 项观察 / 0 个配对 / 1 个片段");
  await expect(
    page.getByRole("table", {
      name: "各篇全局画像（不受列表筛选影响）",
      exact: true,
    }),
  ).toContainText("未扫描");
  await prepare(page);
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await expect(
    page.getByRole("region", { name: "本机标点只读审阅", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("PRIVATE_LOCAL.json", { exact: false }),
  ).toHaveCount(0);
  await load(page);
  await analyze(page);
  await page.evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    ),
  );
  await expect(
    page.getByRole("region", { name: "本机标点只读审阅", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "分析本机标点与节奏", exact: true }),
  ).toBeDisabled();
});

test("真实键盘可定位、跳转和返回；手机表格可聚焦滚动，安全投影与axe不放宽规则", async ({
  page,
}) => {
  await start(page);
  await load(page);
  await analyze(page);
  await page.getByLabel("左侧节奏文稿", { exact: true }).selectOption("d1");
  await page.getByLabel("右侧节奏文稿", { exact: true }).selectOption("d2");
  const trigger = page.getByRole("button", {
    name: "定位标点项目 f2",
    exact: true,
  });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByLabel("标点原文安全定位", { exact: true }),
  ).toBeFocused();
  await page.getByLabel("定位原始UTF-16偏移", { exact: true }).fill("999999");
  await page
    .getByRole("button", { name: "跳转标点原文偏移", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toContainText("原始UTF-16整数偏移");
  await page
    .getByRole("button", { name: "关闭标点定位并返回触发按钮", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(trigger).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await expect(
    page.getByLabel("可横向滚动的文稿节奏表", { exact: true }),
  ).toHaveAttribute("tabindex", "0");
  const audit = await new AxeBuilder({ page }).analyze();
  expect(audit.violations).toEqual([]);
});

test("集合入口和退出均跨真实Document，离页返回不自动复原本机文件、DOM或报告", async ({
  page,
}) => {
  await page.goto("/write/collections");
  await page.getByRole("link", { name: "本机标点与节奏", exact: true }).click();
  await load(page);
  await analyze(page);
  await prepare(page);
  await page.evaluate(() => {
    Object.assign(window, { cadenceNavigationWitness: "old-document" });
  });
  await page.getByRole("link", { name: "本机集合工具", exact: true }).click();
  await expect(page).toHaveURL(/\/write\/collections$/);
  expect(await page.evaluate(() => "cadenceNavigationWitness" in window)).toBe(
    false,
  );
  await page.goBack();
  await expect(page).toHaveURL(/\/write\/cadence$/);
  await expect(
    page.getByRole("heading", { name: "本机标点与停顿节奏审阅", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "本机标点只读审阅", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "下载标点无正文报告", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "分析本机标点与节奏", exact: true }),
  ).toBeDisabled();
});

test("冷启动在隐私监听和客户端事件就绪前禁用原生文件入口，不吞掉用户首次选择", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/*.js", async (route) => {
    await gate;
    await route.continue();
  });
  try {
    await page.goto("/write/cadence", { waitUntil: "commit" });
    const input = page.getByLabel("标点审阅备份或集合文件", { exact: true });
    await input.waitFor({ state: "attached" });
    expect(await input.isDisabled()).toBe(true);
  } finally {
    release();
  }
  await load(page);
  await analyze(page);
  await expect(
    page.getByRole("region", { name: "本机标点只读审阅", exact: true }),
  ).toBeVisible();
});

test("逐标点轨迹解释越栈且不提供修复，片段交叉统计可定位并保持嵌套覆盖不重计", async ({
  page,
}) => {
  await start(page);
  await load(page, [["（甲。「乙！丙？」）丁。([戊。]己。)尾。", "🦊([)] ]"]]);
  await page.context().setOffline(true);
  await analyze(page);
  await page
    .getByRole("button", { name: "定位标点项目 f2", exact: true })
    .click();
  await page
    .getByRole("button", { name: "解释起点配对栈", exact: true })
    .click();
  const explanation = page.getByRole("region", {
    name: "逐标点配对栈解释",
    exact: true,
  });
  await expect(explanation.getByRole("status")).toContainText(
    "已重放 5/5 个端点",
  );
  await expect(explanation).toContainText("已到达所选边界");
  const events = explanation.getByRole("table", {
    name: "当前游程的逐标点轨迹窗口",
    exact: true,
  });
  await expect(events.locator("tbody tr")).toHaveCount(5);
  await expect(events.locator("tbody tr").nth(2)).toContainText(
    "越栈阻挡（不弹栈）",
  );
  await expect(events.locator("tbody tr").nth(2)).toContainText("2 → 2");
  await expect(events.locator("tbody tr").nth(3)).toContainText("正常出栈");
  await page
    .getByRole("button", { name: "定位轨迹端点 2", exact: true })
    .click();
  await expect(
    page.getByLabel("标点原文安全定位", { exact: true }),
  ).toBeFocused();
  await expect(
    page
      .getByLabel("标点安全文字投影", { exact: true })
      .locator("mark[data-related]"),
  ).toHaveCount(2);
  await page
    .getByRole("button", { name: "关闭标点定位并返回触发按钮", exact: true })
    .click();
  await expect(explanation).toHaveCount(0);
  await page
    .getByRole("button", { name: "定位交叉片段 s2", exact: true })
    .click();
  const crossing = page.getByLabel("当前片段配对交叉明细", { exact: true });
  await expect(crossing).toContainText("完整包围本片段 2 个");
  await expect(crossing).toContainText("原始代码点配对并集 3/3");
  await page
    .getByRole("button", { name: "解释终点配对栈", exact: true })
    .click();
  await expect(explanation.getByRole("status")).toContainText(
    "当前游程重放完整",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByLabel("可横向滚动的配对栈轨迹表", { exact: true }),
  ).toHaveAttribute("tabindex", "0");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page
    .getByRole("button", { name: "收起当前栈解释", exact: true })
    .click();
  await expect(explanation).toHaveCount(0);
  await page
    .getByRole("button", { name: "清除全部标点审阅内容", exact: true })
    .click();
  await expect(crossing).toHaveCount(0);
});
