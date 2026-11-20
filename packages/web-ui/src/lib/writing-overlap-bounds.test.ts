import test from "node:test";
import assert from "node:assert/strict";
import {
  overlapFixture,
  overlapPolicy,
} from "../test-support/writing-overlap.ts";
import { analyzeWritingOverlap } from "./writing-overlap.ts";
import type { OverlapOptions } from "./writing-overlap-model.ts";
const pause = async () => {};
async function run(texts: string[], options: OverlapOptions = {}) {
  return analyzeWritingOverlap(
    await overlapFixture(texts.map((text) => [text])),
    overlapPolicy({ threshold: 50 }),
    new AbortController().signal,
    { pause, ...options },
  );
}
const variants = [
  "A shared private river paragraph has an amber ending.",
  "A shared private river paragraph has an azure ending.",
  "A shared private river paragraph has a green ending.",
];

test("each algorithm budget is independently observable without exporting partially scored pairs", async () => {
  const candidates = await run(variants, { budgets: { candidates: 1 } });
  assert.ok(candidates.limits.includes("candidate-budget"));
  assert.equal(candidates.coverage.candidates, 1);
  const postings = await run(variants, { budgets: { postingSteps: 1 } });
  assert.ok(postings.limits.includes("posting-budget"));
  assert.equal(postings.coverage.probes, 1);
  const comparison = await run(variants, { budgets: { comparisonSteps: 1 } });
  assert.ok(comparison.limits.includes("comparison-budget"));
  assert.equal(comparison.coverage.compared, 0);
  assert.equal(comparison.near.length, 0);
  const result = await run(variants, { budgets: { results: 1 } });
  assert.ok(result.limits.includes("result-budget"));
  assert.equal(result.near.length, 1);
  const all = await run(variants);
  assert.equal(
    result.near[0]!.basisPoints,
    all.near[0]!.basisPoints,
    "keep the strongest complete score, not merely the earliest hit",
  );
});

test("normalization expansion is inside the global text budget, not just the input UTF-16 count", async () => {
  const opened = await overlapFixture([["\ufdfa".repeat(20)]]);
  await assert.rejects(
    analyzeWritingOverlap(
      opened,
      overlapPolicy({ mode: "folded" }),
      new AbortController().signal,
      { pause, budgets: { characters: 100 } },
    ),
    /规范化|预算/,
  );
});

test("aborting in each final stage publication cannot hand back a seemingly complete analysis", async () => {
  const source = await overlapFixture(variants.map((text) => [text]));
  for (const stage of ["index", "candidates", "compare"] as const) {
    const abort = new AbortController();
    await assert.rejects(
      analyzeWritingOverlap(
        source,
        overlapPolicy({ threshold: 50 }),
        abort.signal,
        {
          pause,
          progress: (value) => {
            if (value.stage === stage) abort.abort();
          },
        },
      ),
      { name: "AbortError" },
    );
  }
});

test("reordering/repeated shingle counts can score 100 without literal identity and are never promoted into exact findings", async () => {
  const found = await run(["abcdeabcdeabcde", "abcdeabcdeabcdeabcdeabcde"]);
  assert.equal(found.exact.length, 0);
  assert.equal(found.near.length, 1);
  assert.equal(found.near[0]!.basisPoints, 10000);
});

test("the analysis ignores mutation of a caller's parsed tree and cannot subsequently be mutated through an exposed result", async () => {
  const source = await overlapFixture([[variants[0]!], [variants[0]!]]);
  source.prepared.collection.entries[0]!.backup.draft.editorState!.root.children[0]!.children =
    [];
  const found = await analyzeWritingOverlap(
    source,
    overlapPolicy(),
    new AbortController().signal,
    { pause },
  );
  assert.equal(
    found.exact.length,
    1,
    "only the serialized, reopened and checksummed snapshot is authoritative",
  );
  assert.throws(() => found.units[0]!.path.push(99), TypeError);
  assert.throws(() => {
    found.units[0]!.text = "mutated";
  }, TypeError);
  assert.throws(() => found.families[0]!.units.pop(), TypeError);
  assert.throws(() => {
    found.policy.mode = "folded";
  }, TypeError);
});

test("an independent deterministic Unicode corpus oracle agrees on every in-scope near pair when no limits were hit", async () => {
  const seed =
    "海边的风携带着遥远山谷的回声🦊，每个清晨我们一起记录潮水的变化。";
  const texts = Array.from({ length: 12 }, (_, index) => {
    const points = Array.from(seed);
    points[index * 2] = String(index);
    return points.join("");
  });
  const found = await run(texts);
  assert.deepEqual(found.limits, []);
  function grams(value: string) {
    const points = [...value],
      grams = new Set<string>();
    for (let index = 0; index <= points.length - 5; index++)
      grams.add(points.slice(index, index + 5).join(""));
    return grams;
  }
  const expected = new Map<string, number>();
  for (let i = 0; i < texts.length; i++)
    for (let j = i + 1; j < texts.length; j++) {
      const left = grams(texts[i]!),
        right = grams(texts[j]!),
        union = new Set([...left, ...right]).size;
      const intersection = [...left].filter((gram) => right.has(gram)).length;
      if (intersection * 2 >= union)
        expected.set(
          `f${i + 1}:f${j + 1}`,
          Math.floor((intersection * 10000) / union),
        );
    }
  assert.ok(expected.size > 10);
  assert.deepEqual(
    new Map(
      found.near.map((item) => [
        `${item.left}:${item.right}`,
        item.basisPoints,
      ]),
    ),
    expected,
  );
});
