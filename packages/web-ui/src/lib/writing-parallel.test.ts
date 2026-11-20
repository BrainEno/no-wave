import assert from "node:assert/strict";
import test from "node:test";
import { analyzeWritingParallel } from "./writing-parallel.ts";
import {
  DEFAULT_PARALLEL_POLICY,
  PARALLEL_LIMITS,
} from "./writing-parallel-model.ts";
import {
  parallelHeading,
  parallelImage,
  parallelLinkParagraph,
  parallelParagraph,
  parallelQuote,
  parallelSource,
} from "./writing-parallel-test-support.ts";

test("对齐同构双语文档：段落与标题 100% 结构匹配，守恒且无不对称 finding", async () => {
  const collection = await parallelSource([
    {
      locale: "zh-TW",
      blocks: [
        parallelHeading("第一章 引言", "h2"),
        "這是一個繁體中文的段落，描述了系統的核心設計理念。",
        "第二個段落補充說明了架構的不可變性與私密性保證。",
      ],
    },
    {
      locale: "en",
      blocks: [
        parallelHeading("Chapter 1: Introduction", "h2"),
        "This is an English paragraph describing the core design philosophy.",
        "The second paragraph further clarifies the immutability and privacy guarantees.",
      ],
    },
  ]);

  const analysis = await analyzeWritingParallel(collection);
  assert.equal(analysis.pairs.length, 1);
  const pair = analysis.pairs[0]!;
  assert.equal(pair.leftUnits.length, 3);
  assert.equal(pair.rightUnits.length, 3);
  assert.equal(pair.alignments.length, 3);

  // All 3 aligned
  for (const align of pair.alignments) {
    assert.ok(align.leftId !== null);
    assert.ok(align.rightId !== null);
    assert.ok(align.type === "exact-match" || align.type === "strong-align");
  }

  // Conservation check: left = aligned + leftGaps; right = aligned + rightGaps
  const alignedCount = pair.alignments.filter(
    (a) => a.leftId && a.rightId,
  ).length;
  const leftGaps = pair.alignments.filter(
    (a) => a.leftId && !a.rightId,
  ).length;
  const rightGaps = pair.alignments.filter(
    (a) => !a.leftId && a.rightId,
  ).length;
  assert.equal(pair.leftUnits.length, alignedCount + leftGaps);
  assert.equal(pair.rightUnits.length, alignedCount + rightGaps);

  // Structural similarity index should be high (>= 0.95)
  assert.ok(pair.metrics.structuralSimilarityIndex >= 0.95);
  // Zero asymmetry findings
  assert.equal(pair.asymmetries.length, 0);
});

test("检测标题层级漂移（H2 vs H3）并产生 heading-level-drift 异常 finding", async () => {
  const collection = await parallelSource([
    {
      locale: "zh-TW",
      blocks: [
        parallelHeading("主要章節", "h2"),
        "正文段落一。",
      ],
    },
    {
      locale: "en",
      blocks: [
        parallelHeading("Main Section", "h3"), // Drifted to h3!
        "Body paragraph one.",
      ],
    },
  ]);

  const analysis = await analyzeWritingParallel(collection);
  const pair = analysis.pairs[0]!;
  assert.equal(pair.alignments.length, 2);

  const headingAlign = pair.alignments[0]!;
  assert.ok(
    headingAlign.type === "strong-align" || headingAlign.type === "partial-align",
  );

  const drifts = pair.asymmetries.filter(
    (a) => a.kind === "heading-level-drift",
  );
  assert.equal(drifts.length, 1);
  assert.match(drifts[0]!.message, /h2.*h3/i);
});

test("检测单边缺失段落（missing-block）并准确记录 left-gap / right-gap", async () => {
  const collection = await parallelSource([
    {
      locale: "zh-TW",
      blocks: [
        parallelHeading("第一節", "h2"),
        "中文段落甲。",
        "中文段落乙（英文版缺失了這段）。",
        "中文段落丙。",
      ],
    },
    {
      locale: "en",
      blocks: [
        parallelHeading("Section 1", "h2"),
        "English paragraph A.",
        "English paragraph C.",
      ],
    },
  ]);

  const analysis = await analyzeWritingParallel(collection);
  const pair = analysis.pairs[0]!;
  assert.equal(pair.leftUnits.length, 4);
  assert.equal(pair.rightUnits.length, 3);

  // Conservation check
  const alignedCount = pair.alignments.filter(
    (a) => a.leftId && a.rightId,
  ).length;
  const leftGaps = pair.alignments.filter(
    (a) => a.leftId && !a.rightId,
  ).length;
  const rightGaps = pair.alignments.filter(
    (a) => !a.leftId && a.rightId,
  ).length;
  assert.equal(pair.leftUnits.length, alignedCount + leftGaps);
  assert.equal(pair.rightUnits.length, alignedCount + rightGaps);
  assert.equal(leftGaps, 1);
  assert.equal(rightGaps, 0);

  const missingFindings = pair.asymmetries.filter(
    (a) => a.kind === "missing-block",
  );
  assert.equal(missingFindings.length, 1);
});

test("检测外链与图片不对称（link-parity-mismatch / image-parity-mismatch）", async () => {
  const collection = await parallelSource([
    {
      locale: "zh-CN",
      blocks: [
        parallelLinkParagraph("请参阅规范文档", "https://example.com/spec-v1"),
        parallelImage("https://example.com/diagram.png", "架构图"),
      ],
    },
    {
      locale: "en",
      blocks: [
        parallelLinkParagraph("See specification", "https://example.com/spec-v2"), // URL mismatch!
        parallelParagraph("Here was supposed to be an image but omitted."), // Missing image!
      ],
    },
  ]);

  const analysis = await analyzeWritingParallel(collection);
  const pair = analysis.pairs[0]!;

  const linkMismatches = pair.asymmetries.filter(
    (a) => a.kind === "link-mismatch",
  );
  assert.ok(linkMismatches.length >= 1);

  const imageMismatches = pair.asymmetries.filter(
    (a) => a.kind === "image-mismatch",
  );
  assert.ok(imageMismatches.length >= 1);
});

test("段落长度比例中位数与极端长短比例异常（extreme-ratio）", async () => {
  const collection = await parallelSource([
    {
      locale: "zh-TW",
      blocks: [
        "這是一個正常長度的中文段落，約有三十個字左右的長度，用於建立基準長度比例。",
        "短。", // 1 character vs 200 characters in English
        "另一個正常長度的段落，結構對稱完整，兩側長度保持在合理的比例區間之內。",
      ],
    },
    {
      locale: "en",
      blocks: [
        "This is an English paragraph of typical length, with around twenty to thirty words to establish baseline ratio.",
        "This is an excessively long and disproportionate elaboration that expands vastly beyond the single character in the source manuscript, triggering the extreme ratio outlier threshold.",
        "Another normal length paragraph, structurally symmetric and complete, with length remaining within reasonable bounds.",
      ],
    },
  ]);

  const analysis = await analyzeWritingParallel(collection, {
    ...DEFAULT_PARALLEL_POLICY,
    ratioThreshold: 4.0,
  });
  const pair = analysis.pairs[0]!;
  assert.ok(pair.metrics.medianRatio > 0);

  const extremeFindings = pair.asymmetries.filter(
    (a) => a.kind === "extreme-ratio",
  );
  assert.ok(extremeFindings.length >= 1);
});

test("超限正文整轮拒绝，不静默截断", async () => {
  const collection = await parallelSource([
    { locale: "zh-TW", blocks: ["一段很长的中文正文，用于触发较小的字符预算上限。"] },
    { locale: "en", blocks: ["A long English body text to exceed small budget."] },
  ]);

  await assert.rejects(
    async () =>
      analyzeWritingParallel(collection, DEFAULT_PARALLEL_POLICY, undefined, {
        budgets: { characters: 20 },
      }),
    /超出|超限|limit/i,
  );
});

test("空集合或只有单篇文稿时返回明确空对齐，不崩溃", async () => {
  const collection = await parallelSource([
    { locale: "zh-TW", blocks: ["只有一篇文稿，無法構建平行雙語對照。"] },
  ]);

  const analysis = await analyzeWritingParallel(collection);
  assert.equal(analysis.pairs.length, 0);
  assert.equal(analysis.findings.length, 0);
  assert.ok(analysis.witness.length > 0);
});

test("多篇文稿集合：支持生成文稿对组合并分别对齐", async () => {
  const collection = await parallelSource([
    { locale: "zh-TW", blocks: [parallelHeading("中文標題", "h2"), "段落一。"] },
    { locale: "en", blocks: [parallelHeading("English Title", "h2"), "Paragraph 1."] },
    { locale: "zh-CN", blocks: [parallelHeading("中文标题", "h2"), "段落一。"] },
  ]);

  const analysis = await analyzeWritingParallel(collection);
  // 3 pairs: d1:d2, d1:d3, d2:d3
  assert.equal(analysis.pairs.length, 3);
  assert.equal(analysis.summaries.length, 3);
  for (const pair of analysis.pairs) {
    assert.equal(pair.alignments.length, 2);
    assert.ok(pair.metrics.structuralSimilarityIndex >= 0.8);
  }
});

test("策略范围过滤：仅段落范围忽略标题与引用块", async () => {
  const collection = await parallelSource([
    {
      locale: "zh-TW",
      blocks: [
        parallelHeading("標題", "h2"),
        "純段落一。",
        parallelQuote("引用塊。"),
      ],
    },
    {
      locale: "en",
      blocks: [
        parallelHeading("Heading", "h2"),
        "Pure paragraph 1.",
        parallelQuote("Quote block."),
      ],
    },
  ]);

  const analysis = await analyzeWritingParallel(collection, {
    ...DEFAULT_PARALLEL_POLICY,
    scope: "paragraphs",
  });
  const pair = analysis.pairs[0]!;
  assert.equal(pair.leftUnits.length, 1);
  assert.equal(pair.rightUnits.length, 1);
  assert.equal(pair.leftUnits[0]!.kind, "paragraph");
});

test("支持通过 AbortSignal 中途取消分析", async () => {
  const controller = new AbortController();
  controller.abort();

  const collection = await parallelSource([
    { locale: "zh-TW", blocks: ["段落。"] },
    { locale: "en", blocks: ["Paragraph."] },
  ]);

  await assert.rejects(
    async () => analyzeWritingParallel(collection, DEFAULT_PARALLEL_POLICY, controller.signal),
    /aborted/i,
  );
});
