import assert from "node:assert/strict";
import test from "node:test";
import { cadenceSource } from "./writing-cadence-test-support.ts";
import { analyzeWritingCadence } from "./writing-cadence.ts";
import {
  DEFAULT_CADENCE_POLICY,
  type CadenceAnalysis,
} from "./writing-cadence-model.ts";
import {
  cadenceInventory,
  sealCadenceAnalysis,
} from "./writing-cadence-index.ts";
import {
  cadenceContext,
  cadenceRows,
  validateCadenceMarks,
  DEFAULT_CADENCE_FILTERS,
  cadenceCodepoints,
} from "./writing-cadence-review.ts";
import {
  cadenceProfile,
  compareCadenceDocuments,
} from "./writing-cadence-profile.ts";
import { prepareCadenceReport } from "./writing-cadence-report.ts";
import { displayCadenceText } from "./writing-cadence-symbols.ts";

const analyze = async (texts: string[][]) =>
  analyzeWritingCadence(
    await cadenceSource(texts),
    DEFAULT_CADENCE_POLICY,
    undefined,
    { pause: async () => {} },
  );

test("witness拒绝克隆，独立清单拒绝漏配对/漏片段/重用端点/虚构坐标，清单本身不可篡改", async () => {
  const result = await analyze([["（「好」）\u200b。"]]);
  const inventory = cadenceInventory(result);
  assert.throws(() => (inventory.units as Map<string, unknown>).clear());
  assert.equal(cadenceInventory(result).units.size, 1);
  assert.throws(() =>
    cadenceRows(structuredClone(result), DEFAULT_CADENCE_FILTERS, []),
  );
  const mutations = [
    (copy: CadenceAnalysis) => {
      copy.pairs.pop();
    },
    (copy: CadenceAnalysis) => {
      copy.fragments.pop();
    },
    (copy: CadenceAnalysis) => {
      copy.pairs[0]!.open = { ...copy.pairs[1]!.open };
    },
    (copy: CadenceAnalysis) => {
      copy.findings[0]!.pointStart++;
    },
    (copy: CadenceAnalysis) => {
      copy.coverage.scannedCharacters++;
    },
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(result);
    mutate(copy);
    assert.throws(() => sealCadenceAnalysis(copy));
  }
  const forest = [...inventory.topology.values()];
  assert.deepEqual(
    forest.map((node) => [node.id, node.parent, node.depth]),
    [
      ["p2", null, 1],
      ["p1", "p2", 2],
    ],
  );
  assert.ok(Object.isFrozen(forest[0]!.children));
});

test("筛选不丢全局标记，整批含一个无效或重复ID时原子拒绝", async () => {
  const result = await analyze([["（甲。）\u200b"], ["乙！！"]]);
  const all = cadenceRows(
    result,
    { ...DEFAULT_CADENCE_FILTERS, type: "all" },
    [],
  );
  const selected = cadenceRows(
    result,
    { ...DEFAULT_CADENCE_FILTERS, document: "d2" },
    [],
  );
  const marks = validateCadenceMarks(
    result,
    selected.map((row) => ({ id: row.id, state: "intentional" })),
  );
  assert.equal(
    cadenceRows(
      result,
      { ...DEFAULT_CADENCE_FILTERS, document: "d1", state: "intentional" },
      marks,
    ).length,
    0,
  );
  assert.equal(
    cadenceRows(
      result,
      { ...DEFAULT_CADENCE_FILTERS, state: "intentional" },
      marks,
    ).length,
    selected.length,
  );
  assert.equal(new Set(all.map((row) => row.id)).size, all.length);
  assert.throws(() =>
    validateCadenceMarks(result, [
      ...marks,
      { id: "f99999", state: "follow-up" },
    ]),
  );
  assert.throws(() => validateCadenceMarks(result, [...marks, marks[0]!]));
  assert.throws(() =>
    cadenceRows(result, { ...DEFAULT_CADENCE_FILTERS, document: "d20" }, marks),
  );
});

test("原文安全投影保持原坐标：不执行标记，不渲染方向控制，不拆代理对；关联开符也能定位", async () => {
  const text =
    "🦊([)]\u202e\u200d\ufe0f PRIVATE <img src='https://never.test/pixel'>";
  const result = await analyze([[text]]);
  const blocked = result.findings.find((f) => f.kind === "blocked-close")!;
  const context = cadenceContext(result, blocked.id);
  assert.equal(context.unit, "d1:0");
  assert.equal(context.start, 0);
  assert.ok(
    context.pieces.some((piece) => piece.selected && piece.text === ")"),
  );
  assert.ok(
    context.pieces.some((piece) => piece.related && piece.text.includes("[")),
  );
  assert.ok(
    context.pieces
      .map((piece) => piece.text)
      .join("")
      .includes("⟦U+202E⟧"),
  );
  assert.ok(
    !context.pieces
      .map((piece) => piece.text)
      .join("")
      .includes("\u202e"),
  );
  assert.equal(
    displayCadenceText("🦊\u202e\u200d\ufe0f\t"),
    "🦊⟦U+202E⟧⟦U+200D⟧⟦U+FE0F⟧⟦TAB⟧",
  );
  const long = await analyze([["🦊".repeat(1400) + "（尾"]]);
  const tail = cadenceContext(long, long.findings[0]!.id, 1);
  assert.equal(tail.start % 2, 0);
  assert.ok(tail.end - tail.start <= 2048);
  assert.throws(() => cadenceContext(result, "f999"));
  assert.throws(() => cadenceContext(result, blocked.id, -1));
});

test("文稿画像保留零值与覆盖状态；完整段落前沿后不声称缺席", async () => {
  const source = await cadenceSource([
    ["先。", "（后"],
    ["没扫描。"],
    [
      {
        type: "code",
        version: 1,
        children: [{ type: "text", version: 1, text: "code" }],
      },
    ],
  ]);
  const result = await analyzeWritingCadence(
    source,
    DEFAULT_CADENCE_POLICY,
    undefined,
    { pause: async () => {}, budgets: { findings: 0 } },
  );
  const profile = cadenceProfile(result);
  assert.deepEqual(
    profile.documents.map((d) => [
      d.document,
      d.coverage,
      d.scannedUnits,
      d.units,
    ]),
    [
      ["d1", "partial", 1, 2],
      ["d2", "unscanned", 0, 1],
      ["d3", "outside-scope", 0, 0],
    ],
  );
  assert.equal(profile.documents[0]!.lengths.samples, 1);
  assert.equal(profile.documents[1]!.lengths.samples, 0);
  assert.equal(profile.documents[1]!.findings.invisible, 0);
  assert.equal(
    compareCadenceDocuments(result, "d1", "d2").distribution.cdfGap,
    null,
  );
  assert.equal(compareCadenceDocuments(result, "d1", "d2").complete, false);
  assert.throws(() => compareCadenceDocuments(result, "d1", "d1"));
  assert.throws(() => compareCadenceDocuments(result, "d1", "d20"));
});

test("最近秩四分位、连续短片段和精确CDF/运输距离对照独立频数oracle", async () => {
  const result = await analyze([
    ["甲。乙。丙。", "長".repeat(149) + "。"],
    ["丁。戊戊。己己己。"],
  ]);
  const profile = cadenceProfile(result),
    a = profile.documents[0]!,
    b = profile.documents[1]!;
  assert.equal(a.lengths.median, 2);
  assert.equal(a.lengths.p90, 150);
  assert.equal(a.rhythm.length, 1);
  assert.equal(a.rhythm[0]!.fragments.length, 3);
  assert.equal(b.lengths.median, 3);
  const compare = compareCadenceDocuments(result, "d1", "d2");
  const left = [2, 2, 2, 150],
    right = [2, 3, 4],
    denominator = left.length * right.length;
  let gap = 0,
    area = 0;
  for (let x = 0; x <= 150; x++) {
    const difference = Math.abs(
      left.filter((n) => n <= x).length * right.length -
        right.filter((n) => n <= x).length * left.length,
    );
    gap = Math.max(gap, difference);
    if (x < 150) area += difference;
  }
  assert.equal(compare.distribution.cdfGap!.numerator, gap);
  assert.equal(compare.distribution.cdfGap!.denominator, denominator);
  assert.equal(compare.distribution.transport!.numerator, area);
  assert.equal(compare.distribution.transport!.denominator, denominator);
  assert.equal(compare.complete, true);
  assert.equal(
    a.lengths.buckets.reduce((n, bucket) => n + bucket.count, 0),
    result.fragments.filter((f) => f.unit.startsWith("d1:")).length,
  );
});

test("精确代码点清单区分同一类别的不同隐形字符，报告仅元数据且不受视图缩小", async () => {
  const result = await analyze([
    ["PRIVATE_MANUSCRIPT\u200b\u200c\u200d。"],
    ["\u200b PRIVATE_OTHER。"],
  ]);
  const symbols = cadenceCodepoints(result);
  assert.deepEqual(
    symbols.map((item) => [item.codepoint, item.count]),
    [
      ["U+200B", 2],
      ["U+200C", 1],
      ["U+200D", 1],
    ],
  );
  assert.equal(cadenceCodepoints(result, "d2")[0]!.count, 1);
  const mark = { id: result.findings[0]!.id, state: "intentional" as const };
  const prepared = prepareCadenceReport(
    result,
    [mark],
    new Date("2026-11-12T00:00:00Z"),
  );
  const report = JSON.parse(prepared.text);
  assert.equal(report.findings.length, result.findings.length);
  assert.equal(report.review.marked, 1);
  assert.ok(prepared.bytes <= 2 * 1024 * 1024);
  assert.doesNotMatch(
    prepared.text,
    /PRIVATE|MANUSCRIPT|OTHER|text|children|https:|U\+200[BCD]|TITLE|SUMMARY/,
  );
  assert.equal(
    prepareCadenceReport(result, [mark], new Date("2026-11-12T00:00:00Z")).text,
    prepared.text,
  );
});
