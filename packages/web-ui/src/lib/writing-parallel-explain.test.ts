import assert from "node:assert/strict";
import test from "node:test";
import { analyzeWritingParallel } from "./writing-parallel.ts";
import { explainParallelAlignment } from "./writing-parallel-explain.ts";
import {
  parallelHeading,
  parallelLinkParagraph,
  parallelSource,
} from "./writing-parallel-test-support.ts";

test("解释对齐条目：输出类型契合度、数字与外链锚点加分及长度比例拆解", async () => {
  const collection = await parallelSource([
    {
      locale: "zh-CN",
      blocks: [
        parallelHeading("2026年 架构规划", "h2"),
        parallelLinkParagraph(
          "请查阅规范文档：版本 2.0，发布于 2026 年。",
          "https://example.com/spec",
        ),
      ],
    },
    {
      locale: "en",
      blocks: [
        parallelHeading("2026 Architecture Plan", "h2"),
        parallelLinkParagraph(
          "Refer to specification document: Version 2.0, released in 2026.",
          "https://example.com/spec",
        ),
      ],
    },
  ]);

  const analysis = await analyzeWritingParallel(collection);
  const pair = analysis.pairs[0]!;
  const headingAlign = pair.alignments[0]!;
  const headingExplanation = explainParallelAlignment(analysis, headingAlign.id);

  assert.equal(headingExplanation.alignmentId, headingAlign.id);
  assert.ok(headingExplanation.scoreComponents.typeScore > 0);
  assert.ok(headingExplanation.scoreComponents.anchorScore > 0);
  assert.match(headingExplanation.summary, /h2/i);

  const paragraphAlign = pair.alignments[1]!;
  const paragraphExplanation = explainParallelAlignment(
    analysis,
    paragraphAlign.id,
  );
  assert.ok(paragraphExplanation.anchors.includes("https://example.com/spec"));
  assert.ok(paragraphExplanation.anchors.includes("2026"));
});
