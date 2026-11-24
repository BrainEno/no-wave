import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import {
  parallelHeading,
  parallelLinkParagraph,
  parallelSource,
} from "../packages/web-ui/src/lib/writing-parallel-test-support.ts";
import { test } from "./support/article-view-stack.ts";

async function start(page: Page) {
  // Verify clean redirect and query rejection
  await page.goto(
    "/write/parallel?file=https%3A%2F%2Fnever-parallel.example.test%2FPRIVATE&malicious=1",
  );
  await expect(page).toHaveURL(/\/write\/parallel$/);
  await expect(
    page.getByRole("heading", {
      name: "本机双语与平行文稿对照审阅",
      exact: true,
    }),
  ).toBeVisible();
}

async function createBilingualCollection() {
  return await parallelSource([
    {
      title: "SECRET_DOC_ZH_TITLE",
      locale: "zh-TW",
      blocks: [
        parallelHeading("SECRET_HEADING_ZH 第一章", "h2"),
        parallelLinkParagraph(
          "SECRET_ZH_BODY_PARAGRAPH_1 包含規範鏈接。",
          "https://never-parallel.example.test/spec",
        ),
        "SECRET_ZH_BODY_PARAGRAPH_2 額外中文說明（英文版缺失此段）。",
      ],
    },
    {
      title: "SECRET_DOC_EN_TITLE",
      locale: "en",
      blocks: [
        parallelHeading("SECRET_HEADING_EN Chapter 1", "h2"),
        parallelLinkParagraph(
          "SECRET_EN_BODY_PARAGRAPH_1 with link.",
          "https://never-parallel.example.test/spec",
        ),
      ],
    },
  ]);
}

async function loadFile(page: Page, text: string) {
  const input = page.getByLabel("选择双语对照备份或集合文件", { exact: true });
  await expect(input).toBeEnabled();
  await input.setInputFiles({
    name: "bilingual-collection.json",
    mimeType: "application/json",
    buffer: Buffer.from(text, "utf-8"),
  });
  await expect(page.getByRole("status").first()).toContainText("来源校验通过");
}

test("双语对照完整交互：离线安全、不对称审阅、得分拆解与无正文脱敏报告导出", async ({
  page,
}) => {
  const externalRequests: string[] = [];
  page.on("request", (req) => {
    if (new URL(req.url()).hostname === "never-parallel.example.test") {
      externalRequests.push(req.url());
    }
  });

  await start(page);

  const collection = await createBilingualCollection();
  await loadFile(page, collection.prepared.text);

  // Set offline to guarantee local-only operation
  await page.context().setOffline(true);

  // Verify Profile / Metrics region rendered
  const profileSection = page.getByRole("region", {
    name: "双语对照结构与对齐画像",
  });
  await expect(profileSection).toBeVisible();
  await expect(profileSection).toContainText("对照结构与不对称画像");
  await expect(profileSection).toContainText("文稿对齐汇总矩阵");

  // Verify Review Table region rendered
  const reviewSection = page.getByRole("region", {
    name: "双语平行对照审阅表格",
  });
  await expect(reviewSection).toBeVisible();
  await expect(reviewSection).toContainText("平行对齐逐项审阅");

  // Verify detection of missing block (left-gap / missing-block)
  await expect(reviewSection).toContainText("左侧单边空缺");

  // Filter by gap
  const typeFilter = page.getByLabel("对齐类型过滤");
  await typeFilter.selectOption("left-gap");
  await expect(reviewSection.getByRole("status")).toContainText(
    "符合条件共 1 行",
  );

  // Reset filter to all
  await typeFilter.selectOption("all");

  // Click examine button on the first row
  const firstMarkBtn = reviewSection
    .getByRole("button", { name: "核对与标记" })
    .first();
  await firstMarkBtn.click();

  // Selected row detail inspection panel
  const detailPanel = page.getByRole("region", { name: "单行对照核验详情" });
  await expect(detailPanel).toBeVisible();

  // Set human review mark
  const markIntentionalBtn = detailPanel.getByRole("button", {
    name: "设为有意空缺/保留",
  });
  await markIntentionalBtn.click();

  // Verify algorithm explanation breakdown
  const explainBtn = reviewSection
    .getByRole("button", { name: "算法解释" })
    .first();
  await explainBtn.click();

  const explanationPanel = page.getByRole("region", {
    name: "对齐与不对称得分解释",
  });
  await expect(explanationPanel).toBeVisible();
  await expect(explanationPanel).toContainText("得分权重拆解项目");
  await expect(explanationPanel).toContainText("块类型契合");

  // Close explanation
  await explanationPanel.getByRole("button", { name: "关闭解释" }).click();
  await expect(explanationPanel).not.toBeVisible();

  // Test Desensitized Report Download
  const reportSection = page.getByRole("region", { name: "脱敏报告导出" });
  await expect(reportSection).toBeVisible();

  const downloadBtn = reportSection.getByRole("button", {
    name: "下载脱敏对照报告 (JSON)",
  });
  // Disabled until confirmed
  await expect(downloadBtn).toBeDisabled();

  // Check confirmation checkbox
  const confirmCheckbox = reportSection.getByRole("checkbox", {
    name: "我已知晓报告仅包含脱敏统计与哈希元数据，并授权生成下载",
  });
  await confirmCheckbox.check();
  await expect(downloadBtn).toBeEnabled();

  // Capture download
  const downloadPromise = page.waitForEvent("download");
  await downloadBtn.click();
  const download = await downloadPromise;
  const downloadStream = await download.createReadStream();
  if (!downloadStream) throw new Error("No download stream");

  const chunks: Buffer[] = [];
  for await (const chunk of downloadStream) {
    chunks.push(Buffer.from(chunk));
  }
  const reportJson = Buffer.concat(chunks).toString("utf-8");

  // CRITICAL PRIVACY ASSERTIONS:
  // Must NOT contain ANY title, heading, or body secret strings
  expect(reportJson).not.toMatch(/SECRET_DOC_ZH_TITLE/);
  expect(reportJson).not.toMatch(/SECRET_DOC_EN_TITLE/);
  expect(reportJson).not.toMatch(/SECRET_HEADING_ZH/);
  expect(reportJson).not.toMatch(/SECRET_HEADING_EN/);
  expect(reportJson).not.toMatch(/SECRET_ZH_BODY_PARAGRAPH/);
  expect(reportJson).not.toMatch(/SECRET_EN_BODY_PARAGRAPH/);

  // Must contain valid audit metadata and checksum
  const parsedReport = JSON.parse(reportJson);
  expect(parsedReport.format).toBe("no-wave-writing-parallel-report-v1");
  expect(parsedReport.checksum).toBeTruthy();
  expect(parsedReport.pairs.length).toBe(1);
  expect(parsedReport.pairs[0].similarityIndex).toBeGreaterThanOrEqual(0.7);

  // Verify external security boundary: ZERO external requests attempted
  expect(externalRequests).toEqual([]);

  // Verify Clear All functionality
  const clearBtn = page.getByRole("button", { name: "清除全部对照内容" });
  await clearBtn.click();
  await expect(
    page.getByRole("region", { name: "双语对照结构与对齐画像" }),
  ).not.toBeVisible();
  await expect(
    page.getByRole("region", { name: "双语平行对照审阅表格" }),
  ).not.toBeVisible();

  // Accessibility audit
  const axeResults = await new AxeBuilder({ page }).analyze();
  const seriousViolations = axeResults.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(seriousViolations).toEqual([]);
});
