import assert from "node:assert/strict";
import test from "node:test";
import { cadenceSource } from "./writing-cadence-test-support.ts";
import { analyzeWritingCadence } from "./writing-cadence.ts";
import { DEFAULT_CADENCE_POLICY } from "./writing-cadence-model.ts";
import { cadencePairRhythm } from "./writing-cadence-crossings.ts";
const fast = async () => {};

test("按配对追溯跨过的片段及内部停顿边界，独立相交oracle与差分扫描守恒且不展开位置对", async () => {
  for (let depth = 1; depth <= 12; depth++) {
    const text =
      "🦊" +
      "（".repeat(depth) +
      "甲。「乙！丙？」丁。" +
      "）".repeat(depth) +
      "外。";
    const analysis = await analyzeWritingCadence(
      await cadenceSource([[text, "(段。\n落。)"]]),
      DEFAULT_CADENCE_POLICY,
      undefined,
      { pause: fast },
    );
    const result = cadencePairRhythm(analysis);
    for (const row of result.pairs) {
      const pair = analysis.pairs.find((pair) => pair.id === row.pair)!;
      const touched = analysis.fragments.filter(
        (fragment) =>
          fragment.unit === pair.unit &&
          fragment.start < pair.close.end &&
          fragment.end > pair.open.start,
      );
      const contained = touched.filter(
        (fragment) =>
          fragment.start >= pair.open.start && fragment.end <= pair.close.end,
      );
      assert.equal(row.fragments, touched.length);
      assert.equal(row.boundaries, touched.length - 1);
      assert.equal(row.containedFragments, contained.length);
      assert.equal(row.first, touched[0]!.id);
      assert.equal(row.last, touched.at(-1)!.id);
      assert.deepEqual(
        row.examples,
        contained.slice(0, 3).map((fragment) => fragment.id),
      );
    }
    for (const seam of result.seams) {
      const before = analysis.fragments.find(
        (fragment) => fragment.id === seam.before,
      )!;
      const after = analysis.fragments.find(
        (fragment) => fragment.id === seam.after,
      )!;
      assert.equal(before.end, after.start);
      assert.equal(seam.at, before.end);
      assert.equal(seam.pointAt, after.pointStart);
      assert.equal(
        seam.depth,
        analysis.pairs.filter(
          (pair) =>
            pair.unit === seam.unit &&
            pair.open.start < seam.at &&
            pair.close.end > seam.at,
        ).length,
      );
    }
    assert.equal(
      result.pairs.reduce((sum, row) => sum + row.boundaries, 0),
      result.seams.reduce((sum, seam) => sum + seam.depth, 0),
    );
    assert.equal(result.documents[0]!.maximumDepth, depth + 1);
    assert.ok(Object.isFrozen(result.seams[0]));
    assert.doesNotMatch(
      JSON.stringify(result),
      /🦊|甲|editorState|text|replace/,
    );
  }
});

test("配对节奏无跨结构拼接；零配对及未扫描篇保留覆盖状态而不假称完整缺席", async () => {
  const source = await cadenceSource([
    ["（甲。）", "\u200b".repeat(4)],
    ["尾。"],
  ]);
  const analysis = await analyzeWritingCadence(
    source,
    DEFAULT_CADENCE_POLICY,
    undefined,
    { pause: fast, budgets: { findings: 1 } },
  );
  const result = cadencePairRhythm(analysis);
  assert.equal(result.pairs.length, 1);
  assert.equal(result.pairs[0]!.fragments, 1);
  assert.equal(result.pairs[0]!.containedFragments, 1);
  assert.equal(result.seams.length, 0);
  assert.equal(result.documents[0]!.coverage, "partial");
  assert.equal(result.documents[1]!.coverage, "unscanned");
  assert.equal(result.documents[1]!.pairs, 0);
  assert.equal(result.documents[1]!.maximumDepth, null);
  assert.throws(() => cadencePairRhythm(structuredClone(analysis)));
});
