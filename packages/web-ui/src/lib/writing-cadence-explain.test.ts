import assert from "node:assert/strict";
import test from "node:test";
import { cadenceSource } from "./writing-cadence-test-support.ts";
import { analyzeWritingCadence } from "./writing-cadence.ts";
import { DEFAULT_CADENCE_POLICY } from "./writing-cadence-model.ts";
import { explainCadenceStack } from "./writing-cadence-explain.ts";
import { cadenceEnclosures } from "./writing-cadence-enclosures.ts";
import { compareCadenceDocuments } from "./writing-cadence-profile.ts";

const fast = async () => {};
const analyze = async (texts: string[][]) =>
  analyzeWritingCadence(
    await cadenceSource(texts),
    DEFAULT_CADENCE_POLICY,
    undefined,
    { pause: fast },
  );

test("配对栈轨迹只解释witness：压栈、越栈阻挡、正常出栈和意外闭符不变成修复动作", async () => {
  const analysis = await analyze([["🦊([)] ]"]]);
  const explanation = await explainCadenceStack(
    analysis,
    "f2",
    "start",
    undefined,
    { pause: fast, window: 5 },
  );
  assert.equal(explanation.coverage.complete, true);
  assert.equal(explanation.coverage.selectedReached, true);
  assert.deepEqual(
    explanation.events.map((event) => [
      event.action,
      event.start,
      event.depthBefore,
      event.depthAfter,
    ]),
    [
      ["push", 2, 0, 1],
      ["push", 3, 1, 2],
      ["blocked", 4, 2, 2],
      ["pair", 5, 2, 1],
      ["unexpected", 7, 1, 1],
    ],
  );
  assert.deepEqual(
    explanation.stackAtFocus!.map((frame) => frame.start),
    [2, 3],
  );
  assert.deepEqual(
    explanation.endingOpens!.map((frame) => frame.start),
    [2],
  );
  assert.ok(Object.isFrozen(explanation.events[0]));
  assert.doesNotMatch(
    JSON.stringify(explanation),
    /🦊|replace|replacement|text|PRIVATE/,
  );
});

test("轨迹窗口有界且前沿真实；前沿后的选中位置不冒称已到达，超预算不完成尾栈判断", async () => {
  const analysis = await analyze([["🦊([)] ]"]]);
  const limited = await explainCadenceStack(
    analysis,
    "f3",
    "start",
    undefined,
    { pause: fast, tokens: 2, window: 1 },
  );
  assert.deepEqual(limited.frontier, { stage: "replay", token: 2, start: 4 });
  assert.equal(limited.coverage.complete, false);
  assert.equal(limited.coverage.selectedReached, false);
  assert.equal(limited.stackAtFocus, null);
  assert.equal(limited.endingOpens, null);
  const smallWindow = await explainCadenceStack(
    analysis,
    "f2",
    "start",
    undefined,
    { pause: fast, window: 1 },
  );
  assert.equal(smallWindow.events.length, 3);
  const admission = await explainCadenceStack(
    analysis,
    "f2",
    "start",
    undefined,
    { pause: fast, steps: 0 },
  );
  assert.equal(admission.frontier!.stage, "inventory");
  assert.equal(admission.events.length, 0);
  const stop = new AbortController();
  await assert.rejects(
    explainCadenceStack(analysis, "f2", "start", stop.signal, {
      pause: async () => {
        stop.abort();
      },
    }),
    { name: "AbortError" },
  );
  await assert.rejects(
    explainCadenceStack(analysis, "f2", "start", undefined, { window: 41 }),
    /预算|上限|窗口/,
  );
});

test("配对跨不了结构断点，空白观察可明确说明没有单个配对游程；未扫描单元无可选编号", async () => {
  const analysis = await analyze([["(\n)\t"]]);
  const whitespace = analysis.findings.find(
    (finding) => finding.kind === "whitespace-run",
  )!;
  const explanation = await explainCadenceStack(
    analysis,
    whitespace.id,
    "start",
    undefined,
    { pause: fast },
  );
  assert.equal(explanation.status, "structural-boundary");
  assert.equal(explanation.events.length, 0);
  await assert.rejects(
    explainCadenceStack(structuredClone(analysis), whitespace.id),
  );
  await assert.rejects(explainCadenceStack(analysis, "f999"));
});

test("配对-片段交叉的Fenwick包含计数、原始代码点并集与深度逐片段对照朴素oracle", async () => {
  const analysis = await analyze([
    ["（甲。「乙！丙？」）丁。([戊。]己。)尾。", "🦊（末。次。）"],
    ["未包围。"],
  ]);
  const result = cadenceEnclosures(analysis);
  for (const entry of result.entries) {
    const fragment = analysis.fragments.find(
      (item) => item.id === entry.fragment,
    )!;
    const pairs = analysis.pairs.filter((pair) => pair.unit === fragment.unit);
    const touched = pairs.filter(
      (pair) =>
        pair.open.start < fragment.end && pair.close.end > fragment.start,
    );
    const contains = touched.filter(
      (pair) =>
        pair.open.start <= fragment.start && pair.close.end >= fragment.end,
    );
    const start = pairs.filter(
      (pair) =>
        pair.open.start <= fragment.start && pair.close.end > fragment.start,
    ).length;
    const end = pairs.filter(
      (pair) =>
        pair.open.start < fragment.end && pair.close.end >= fragment.end,
    ).length;
    const covered = new Set<number>();
    for (const pair of touched)
      for (
        let point = Math.max(fragment.pointStart, pair.open.pointStart);
        point < Math.min(fragment.pointEnd, pair.close.pointEnd);
        point++
      )
        covered.add(point);
    assert.equal(entry.touchedPairs, touched.length);
    assert.equal(entry.fullyContained, contains.length);
    assert.equal(entry.depthAtStart, start);
    assert.equal(entry.depthAtEnd, end);
    assert.equal(entry.pairedPoints, covered.size);
    for (const [kind, count] of Object.entries(entry.findings))
      assert.equal(
        count,
        analysis.findings.filter(
          (finding) =>
            finding.unit === fragment.unit &&
            finding.kind === kind &&
            finding.start < fragment.end &&
            finding.end > fragment.start,
        ).length,
      );
  }
  assert.equal(result.entries.length, analysis.fragments.length);
  assert.equal(
    result.groups.reduce((sum, group) => sum + group.fragments, 0),
    analysis.fragments.length,
  );
  assert.equal(cadenceEnclosures(analysis, "d2").entries.length, 1);
  assert.throws(() => cadenceEnclosures(analysis, "d20"));
});

test("生成嵌套/相邻配对验证覆盖不重计，长度直方图相同仍保留不同类别转移", async () => {
  for (let size = 1; size < 20; size++) {
    const text = "(".repeat(size) + "甲。乙。丙。" + ")".repeat(size) + "丁。";
    const analysis = await analyze([[text]]);
    const inventory = cadenceEnclosures(analysis);
    assert.equal(inventory.entries[1]!.fullyContained, size);
    assert.ok(
      inventory.entries.every((entry) => entry.pairedPoints <= entry.points),
    );
    assert.equal(
      inventory.entries.reduce((sum, entry) => sum + entry.pairedPoints, 0),
      size * 2 + 6,
    );
  }
  const short = "短。",
    long = "長".repeat(130) + "。";
  const sequence = await analyze([
    [short + long + short + long],
    [short + short + long + long],
  ]);
  const compared = compareCadenceDocuments(sequence, "d1", "d2");
  assert.equal(compared.distribution.cdfGap!.numerator, 0);
  const transition = compared.transitions.find(
    (cell) => cell.from === "short" && cell.to === "long",
  )!;
  assert.equal(transition.left, 2);
  assert.equal(transition.right, 1);
});
