import assert from "node:assert/strict";
import test from "node:test";
import { cadenceSource } from "./writing-cadence-test-support.ts";
import { analyzeWritingCadence } from "./writing-cadence.ts";
import { DEFAULT_CADENCE_POLICY } from "./writing-cadence-model.ts";
import { validateCadencePolicy } from "./writing-cadence-symbols.ts";

const signal = () => new AbortController().signal;
const fast = { pause: async () => {} };

test("配对保留原文代码点和UTF-16坐标，嵌套不变成跨越，越栈闭符不猜修复", async () => {
  const result = await analyzeWritingCadence(
    await cadenceSource([["🦊（「好」） ([)] ]"]]),
    DEFAULT_CADENCE_POLICY,
    signal(),
    fast,
  );
  assert.deepEqual(
    result.pairs.map((pair) => [
      pair.family,
      pair.open.start,
      pair.open.pointStart,
      pair.close.start,
    ]),
    [
      ["corner", 3, 2, 5],
      ["round-wide", 2, 1, 6],
      ["square", 9, 8, 11],
    ],
  );
  assert.deepEqual(
    result.findings
      .filter((f) => f.kind.includes("close") || f.kind === "unclosed-open")
      .map((f) => [f.kind, f.start]),
    [
      ["unclosed-open", 8],
      ["blocked-close", 10],
      ["unexpected-close", 13],
    ],
  );
  assert.equal(result.frontier, null);
  assert.equal(result.coverage.scannedUnits, 1);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.pairs[0]!.open));
});

test("ASCII引号需显式启用，词内撇号和奇数反斜线转义不当成引号", async () => {
  const source = await cadenceSource([
    [String.raw`don't “isn’t” "yes" \"literal\" \\"paired\\"`],
  ]);
  const none = await analyzeWritingCadence(
    source,
    DEFAULT_CADENCE_POLICY,
    signal(),
    fast,
  );
  assert.deepEqual(
    none.pairs.map((pair) => pair.family),
    ["curly-double"],
  );
  const all = await analyzeWritingCadence(
    source,
    { ...DEFAULT_CADENCE_POLICY, quotes: "all" },
    signal(),
    fast,
  );
  assert.equal(
    all.pairs.filter((pair) => pair.family === "ascii-double").length,
    2,
  );
  assert.equal(
    all.findings.filter(
      (f) => f.family === "ascii-single" || f.family === "curly-single",
    ).length,
    0,
  );
});

test("代码块、内联代码和显式断点不拼接配对；换行/制表本身仍能被观察", async () => {
  const source = await cadenceSource([
    [
      {
        type: "code",
        version: 1,
        children: [{ type: "text", version: 1, text: "((((" }],
      },
      {
        type: "paragraph",
        version: 1,
        children: [
          { type: "text", version: 1, text: "（" },
          { type: "text", version: 1, text: "ignore", format: 16 },
          { type: "text", version: 1, text: "）" },
        ],
      },
      {
        type: "paragraph",
        version: 1,
        children: [
          { type: "text", version: 1, text: "[" },
          { type: "linebreak", version: 1 },
          { type: "text", version: 1, text: "]" },
          { type: "tab", version: 1, text: "\t" },
        ],
      },
    ],
  ]);
  const result = await analyzeWritingCadence(
    source,
    DEFAULT_CADENCE_POLICY,
    signal(),
    fast,
  );
  assert.equal(result.units.length, 2);
  assert.equal(result.pairs.length, 0);
  assert.equal(result.coverage.excludedUnits, 1);
  assert.equal(
    result.coverage.protectedCharacters,
    "ignore".length + "\n\t".length,
  );
  assert.equal(
    result.findings.filter((f) => f.kind === "unclosed-open").length,
    2,
  );
  assert.equal(
    result.findings.filter((f) => f.kind === "unexpected-close").length,
    2,
  );
  assert.equal(
    result.findings.filter((f) => f.kind === "whitespace-run").length,
    2,
  );
});

test("隐形字符、方向控制、选择符与空白只观察，不正规化或删字", async () => {
  const text = "  A\u00a0B\u200b\u202e\u2069\u200d\ufe0f\u00ad\ufeff\t ";
  const result = await analyzeWritingCadence(
    await cadenceSource([[text]]),
    DEFAULT_CADENCE_POLICY,
    signal(),
    fast,
  );
  assert.equal(result.units[0]!.text, text);
  assert.deepEqual(
    result.findings
      .filter((f) => f.kind === "invisible")
      .map((f) => [f.code, f.start]),
    [
      ["nonbreaking-space", 3],
      ["zero-width-space", 5],
      ["direction-control", 6],
      ["direction-control", 7],
      ["join-control", 8],
      ["variation-selector", 9],
      ["soft-hyphen", 10],
      ["byte-order-mark", 11],
    ],
  );
  assert.equal(
    result.findings.filter((f) => f.kind === "whitespace-run").length,
    2,
  );
  assert.equal(result.units[0]!.text.length, text.length);
});

test("停顿片段的闭符附着、空白守恒与数字小数保护是明示字面规则", async () => {
  const text = "“甲！？” 乙……丙。 tail 3.14. End";
  const source = await cadenceSource([[text]]);
  const result = await analyzeWritingCadence(
    source,
    DEFAULT_CADENCE_POLICY,
    signal(),
    fast,
  );
  assert.deepEqual(
    result.fragments.map((f) => text.slice(f.start, f.end)),
    ["“甲！？”", " 乙……", "丙。", " tail 3.14. End"],
  );
  assert.equal(
    result.fragments.map((f) => text.slice(f.start, f.end)).join(""),
    text,
  );
  const dots = await analyzeWritingCadence(
    source,
    { ...DEFAULT_CADENCE_POLICY, dot: true },
    signal(),
    fast,
  );
  assert.deepEqual(
    dots.fragments.map((f) => text.slice(f.start, f.end)),
    ["“甲！？”", " 乙……", "丙。", " tail 3.14.", " End"],
  );
  assert.equal(
    dots.fragments.reduce((n, f) => n + f.points, 0),
    [...text].length,
  );
});

test("计算上限整单元提交；未完成单元不输出假未闭符或部分节奏，前沿精确可见", async () => {
  const source = await cadenceSource([
    ["好。", "（未完", "尾。"],
    ["下一篇。"],
  ]);
  const result = await analyzeWritingCadence(
    source,
    DEFAULT_CADENCE_POLICY,
    signal(),
    { ...fast, budgets: { findings: 0 } },
  );
  assert.deepEqual(result.frontier, {
    unit: 1,
    document: "d1",
    path: [1],
    start: 0,
    pointStart: 0,
  });
  assert.equal(result.limit, "findings");
  assert.equal(result.coverage.scannedUnits, 1);
  assert.equal(result.findings.length, 0);
  assert.equal(result.fragments.length, 1);
  assert.equal(result.fragments[0]!.unit, "d1:0");
  const depth = await analyzeWritingCadence(
    await cadenceSource([["先。", "((((x))))"]]),
    DEFAULT_CADENCE_POLICY,
    signal(),
    { ...fast, budgets: { depth: 2 } },
  );
  assert.equal(depth.limit, "depth");
  assert.equal(depth.pairs.length, 0);
  assert.equal(depth.findings.length, 0);
  assert.equal(depth.coverage.scannedUnits, 1);
  for (const key of ["steps", "pairs", "fragments"] as const) {
    const limited = await analyzeWritingCadence(
      await cadenceSource([["（甲。）", "尾。"]]),
      DEFAULT_CADENCE_POLICY,
      signal(),
      { ...fast, budgets: { [key]: 0 } },
    );
    assert.equal(limited.limit, key);
    assert.equal(limited.coverage.scannedUnits, 0);
    assert.equal(limited.fragments.length, 0);
    assert.equal(limited.pairs.length, 0);
  }
});

test("来源快照、超限、闭集条件与迟到进度均不能制造部分成功", async () => {
  const opened = await cadenceSource([["原文。"]]);
  opened.prepared.collection.entries[0]!.backup.draft.title = "CALLER_MUTATION";
  const result = await analyzeWritingCadence(
    opened,
    DEFAULT_CADENCE_POLICY,
    signal(),
    fast,
  );
  assert.equal(result.units[0]!.text, "原文。");
  await assert.rejects(
    analyzeWritingCadence(opened, DEFAULT_CADENCE_POLICY, signal(), {
      ...fast,
      budgets: { characters: 1 },
    }),
    /超|上限|预算/,
  );
  await assert.rejects(
    analyzeWritingCadence(opened, DEFAULT_CADENCE_POLICY, signal(), {
      ...fast,
      budgets: { units: 0 },
    }),
    /超|上限|预算/,
  );
  for (const raw of [
    { ...DEFAULT_CADENCE_POLICY, extra: true },
    { ...DEFAULT_CADENCE_POLICY, short: NaN },
    { ...DEFAULT_CADENCE_POLICY, long: 1 },
    { ...DEFAULT_CADENCE_POLICY, quotes: "guess" },
  ])
    assert.throws(() => validateCadencePolicy(raw));
  const stop = new AbortController();
  await assert.rejects(
    analyzeWritingCadence(opened, DEFAULT_CADENCE_POLICY, stop.signal, {
      pause: async () => {
        stop.abort();
      },
    }),
    { name: "AbortError" },
  );
  await assert.rejects(
    analyzeWritingCadence(opened, DEFAULT_CADENCE_POLICY, signal(), {
      ...fast,
      budgets: { steps: 8_000_001 },
    }),
    /预算|上限/,
  );
});

test("确定性Unicode语料逐代码点核对单层配对与所有前缀整单元预算", async () => {
  let seed = 12345;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const alphabet = ["🦊", "a", "中", "(", ")", "。", " ", "\u200b"];
  for (let sample = 0; sample < 50; sample++) {
    const text = Array.from(
      { length: 60 },
      () => alphabet[random() % alphabet.length],
    ).join("");
    const stack: number[] = [],
      pairs: [number, number][] = [],
      failed: [string, number][] = [];
    const points = [...text];
    let offset = 0;
    for (const point of points) {
      if (point === "(") stack.push(offset);
      else if (point === ")") {
        const open = stack.pop();
        if (open === undefined) failed.push(["unexpected-close", offset]);
        else pairs.push([open, offset]);
      }
      offset += point.length;
    }
    failed.push(
      ...stack.map((start) => ["unclosed-open", start] as [string, number]),
    );
    failed.sort((a, b) => a[1] - b[1]);
    const source = await cadenceSource([[text]]);
    const result = await analyzeWritingCadence(
      source,
      DEFAULT_CADENCE_POLICY,
      signal(),
      fast,
    );
    assert.deepEqual(
      result.pairs.map((p) => [p.open.start, p.close.start]),
      pairs,
    );
    assert.deepEqual(
      result.findings
        .filter((f) => ["unexpected-close", "unclosed-open"].includes(f.kind))
        .map((f) => [f.kind, f.start]),
      failed,
    );
    for (const f of result.findings)
      assert.equal([...text.slice(0, f.start)].length, f.pointStart);
    for (const cap of [0, 1, 5, 15]) {
      const limited = await analyzeWritingCadence(
        source,
        DEFAULT_CADENCE_POLICY,
        signal(),
        { ...fast, budgets: { findings: cap } },
      );
      assert.equal(
        limited.findings.length,
        result.findings.length <= cap ? result.findings.length : 0,
      );
      assert.equal(
        limited.coverage.scannedUnits,
        result.findings.length <= cap ? 1 : 0,
      );
    }
  }
});
