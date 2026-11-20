import assert from "node:assert/strict";
import test from "node:test";
import { analyzeWritingParallel } from "./writing-parallel.ts";
import {
  parallelHeading,
  parallelParagraph,
  parallelSource,
} from "./writing-parallel-test-support.ts";
import {
  parallelReviewRows,
  parallelTextSlice,
  prepareParallelReport,
  validateParallelMarks,
  type ParallelReviewMark,
} from "./writing-parallel-review.ts";

test("审阅列表正确构建对齐行、空缺行与异常标记，支持分页与筛选", async () => {
  const collection = await parallelSource([
    {
      locale: "zh-TW",
      blocks: [
        parallelHeading("標題甲", "h2"),
        "繁體段落一。",
        "繁體段落二（英文版無此段）。",
      ],
    },
    {
      locale: "en",
      blocks: [
        parallelHeading("Title A", "h2"),
        "English paragraph 1.",
      ],
    },
  ]);

  const analysis = await analyzeWritingParallel(collection);
  const rows = parallelReviewRows(analysis, "all");
  assert.equal(rows.length, 3);

  // Filter by gap
  const gapRows = parallelReviewRows(analysis, "all", {
    kind: "gap",
    status: "all",
  });
  assert.equal(gapRows.length, 1);
  assert.equal(gapRows[0]!.type, "left-gap");

  // Filter by aligned
  const alignedRows = parallelReviewRows(analysis, "all", {
    kind: "aligned",
    status: "all",
  });
  assert.equal(alignedRows.length, 2);
});

test("原文有界惰性分页：每页上限 2048 UTF-16 单元，不拆分代理对", () => {
  const emoji = "𩸽".repeat(1500); // 1500 surrogate pairs = 3000 UTF-16 code units
  const slice = parallelTextSlice(emoji, 0, 2048);
  assert.ok(slice.text.length <= 2048);
  // Last char must not be an orphaned high surrogate
  const lastCode = slice.text.charCodeAt(slice.text.length - 1);
  assert.ok(lastCode < 0xd800 || lastCode > 0xdbff);
});

test("人工审阅标记验证：有效状态接受，无效状态或篡改 ID 原子拒绝", async () => {
  const collection = await parallelSource([
    { locale: "zh-TW", blocks: ["段落一。"] },
    { locale: "en", blocks: ["Paragraph 1."] },
  ]);
  const analysis = await analyzeWritingParallel(collection);
  const pair = analysis.pairs[0]!;
  const alignId = pair.alignments[0]!.id;

  const validMarks: Record<string, ParallelReviewMark> = {
    [alignId]: "intentional",
  };
  assert.doesNotThrow(() => validateParallelMarks(analysis, validMarks));

  const invalidMarks: Record<string, unknown> = {
    "non-existent-id": "intentional",
  };
  assert.throws(() => validateParallelMarks(analysis, invalidMarks as any));
});

test("报告脱敏生成：严格不含原文正文、标题与节点结构，仅导出统计与元数据", async () => {
  const collection = await parallelSource([
    {
      title: "SECRET_TITLE_ZH",
      locale: "zh-TW",
      blocks: [parallelHeading("SECRET_HEADING", "h2"), "SECRET_BODY_TEXT_ZH"],
    },
    {
      title: "SECRET_TITLE_EN",
      locale: "en",
      blocks: [parallelHeading("SECRET_HEADING", "h2"), "SECRET_BODY_TEXT_EN"],
    },
  ]);

  const analysis = await analyzeWritingParallel(collection);
  const report = prepareParallelReport(analysis, {});
  const reportJson = JSON.stringify(report);

  assert.doesNotMatch(reportJson, /SECRET_TITLE/);
  assert.doesNotMatch(reportJson, /SECRET_HEADING/);
  assert.doesNotMatch(reportJson, /SECRET_BODY_TEXT/);
  assert.ok(report.pairs.length === 1);
  assert.ok(report.pairs[0]!.similarityIndex >= 0);
  assert.ok(report.checksum.length > 0);
});
