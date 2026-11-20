import test from "node:test";
import assert from "node:assert/strict";
import {
  overlapFixture,
  overlapPolicy,
} from "../test-support/writing-overlap.ts";
import { analyzeWritingOverlap } from "./writing-overlap.ts";
import { explainWritingOverlap } from "./writing-overlap-evidence.ts";
const pause = async () => {};
async function fixture(left: string, right: string, folded = false) {
  const analysis = await analyzeWritingOverlap(
    await overlapFixture([[left], [right]]),
    overlapPolicy({ mode: folded ? "folded" : "literal", threshold: 50 }),
    new AbortController().signal,
    { pause },
  );
  const finding = analysis.near[0]?.id ?? analysis.exact[0]?.id;
  assert.ok(finding);
  return { analysis, finding };
}
function oracle(text: string) {
  const points = [...text],
    found = new Map<string, number[]>();
  for (let index = 0; index < points.length - 4; index++) {
    const gram = points.slice(index, index + 5).join("");
    const list = found.get(gram) ?? [];
    list.push(index);
    found.set(gram, list);
  }
  return found;
}

test("explanations account for every five-code-point occurrence, complete intersection/union and per-point shared coverage", async () => {
  const left = "PRIVATE 海边🦊的清晨海边🦊的清晨海边🦊的清晨，与安静潮水相伴。";
  const right = left.replace("与安静", "在安静");
  const { analysis, finding } = await fixture(left, right);
  const before = JSON.stringify(analysis);
  const evidence = await explainWritingOverlap(
    analysis,
    finding,
    "d1:0",
    "d2:0",
    new AbortController().signal,
    pause,
  );
  const a = oracle(left),
    b = oracle(right),
    shared = [...a.keys()].filter((gram) => b.has(gram));
  assert.equal(evidence.intersection, shared.length);
  assert.equal(evidence.union, new Set([...a.keys(), ...b.keys()]).size);
  assert.equal(evidence.basisPoints, analysis.near[0]!.basisPoints);
  for (const term of evidence.terms) {
    assert.deepEqual(term.left, a.get(term.text) ?? []);
    assert.deepEqual(term.right, b.get(term.text) ?? []);
  }
  for (const [side, points] of [
    ["left", [...left]],
    ["right", [...right]],
  ] as const) {
    const source = evidence[side];
    assert.equal(source.offsets.length, points.length + 1);
    assert.equal(source.offsets.at(-1), source.text.length);
    assert.equal(source.spans[0]!.start, 0);
    assert.equal(source.spans.at(-1)!.end, points.length);
    const expected = new Array<boolean>(points.length).fill(false);
    for (let index = 0; index < points.length - 4; index++)
      if (shared.includes(points.slice(index, index + 5).join("")))
        expected.fill(true, index, index + 5);
    const actual = source.spans.flatMap((span) =>
      new Array<boolean>(span.end - span.start).fill(span.shared),
    );
    assert.deepEqual(actual, expected);
    assert.equal(source.covered, expected.filter(Boolean).length);
  }
  assert.equal(JSON.stringify(analysis), before);
  assert.throws(() => evidence.terms[0]!.left.push(999), TypeError);
});

test("set Jaccard 100 does not hide repetition-frequency differences or get promoted to source identity", async () => {
  const { analysis, finding } = await fixture(
    "abcdeabcdeabcde",
    "abcdeabcdeabcdeabcdeabcde",
  );
  const evidence = await explainWritingOverlap(
    analysis,
    finding,
    "d1:0",
    "d2:0",
    new AbortController().signal,
    pause,
  );
  assert.equal(evidence.basisPoints, 10000);
  assert.ok(evidence.countBasisPoints < 10000);
  // N code points yield N - 5 + 1 windows; multiplicity remains visible.
  assert.equal(evidence.countIntersection, 15 - 5 + 1);
  assert.equal(evidence.countUnion, 25 - 5 + 1);
  assert.equal(
    evidence.anchors.length,
    0,
    "repeated shingles cannot become unique-position anchors",
  );
});

test("folded explanation positions belong explicitly to normalized strings, never silently to original UTF-16 positions", async () => {
  const left = "Ｒｉｖｅｒ   ＷＯＲＤＳ  beneath the willow trees";
  const { analysis, finding } = await fixture(
    left,
    "river words beneath the willow trees",
    true,
  );
  const evidence = await explainWritingOverlap(
    analysis,
    finding,
    "d1:0",
    "d2:0",
    new AbortController().signal,
    pause,
  );
  assert.equal(evidence.mode, "folded");
  assert.equal(evidence.left.text, "river words beneath the willow trees");
  assert.notEqual(evidence.left.text, analysis.units[0]!.text);
  assert.equal(evidence.basisPoints, 10000);
});

test("unique-position anchor chains are strictly increasing on both sides and ambiguous repeated fragments are never anchors", async () => {
  const common =
    "One private original passage about the river and its many willow trees. ";
  const left = common + "An amber landscape with distant mountains. " + common;
  const right = "An amber landscape with distant mountains. " + common + common;
  const { analysis, finding } = await fixture(left, right);
  const evidence = await explainWritingOverlap(
    analysis,
    finding,
    "d1:0",
    "d2:0",
    new AbortController().signal,
    pause,
  );
  const chain = evidence.anchors.filter((anchor) => anchor.inChain);
  assert.equal(chain.length, evidence.chainLength);
  // Independent quadratic oracle; the implementation uses binary-search tails, not this recurrence.
  const lengths = evidence.anchors.map(() => 1);
  for (let current = 0; current < evidence.anchors.length; current++)
    for (let previous = 0; previous < current; previous++)
      if (
        evidence.anchors[previous]!.left < evidence.anchors[current]!.left &&
        evidence.anchors[previous]!.right < evidence.anchors[current]!.right
      )
        lengths[current] = Math.max(lengths[current]!, lengths[previous]! + 1);
  assert.equal(evidence.chainLength, Math.max(0, ...lengths));
  for (let index = 1; index < chain.length; index++) {
    assert.ok(chain[index]!.left > chain[index - 1]!.left);
    assert.ok(chain[index]!.right > chain[index - 1]!.right);
  }
  for (const anchor of evidence.anchors) {
    const term = evidence.terms.find((term) => term.id === anchor.term)!;
    assert.equal(term.left.length, 1);
    assert.equal(term.right.length, 1);
  }
});

test("long or out-of-scope locations reject without truncating an explanation and cancellation cannot return partial fragment evidence", async () => {
  const text = "This private long passage is repeated. ".repeat(150);
  const { analysis, finding } = await fixture(text, text);
  await assert.rejects(
    explainWritingOverlap(
      analysis,
      finding,
      "d1:0",
      "d2:0",
      new AbortController().signal,
      pause,
    ),
    /4096|上限/,
  );
  const short = await fixture(
    "A private river remembers the quiet morning.",
    "A private river remembers the quiet evening.",
  );
  await assert.rejects(
    explainWritingOverlap(
      short.analysis,
      short.finding,
      "d1:0",
      "d1:0",
      new AbortController().signal,
      pause,
    ),
    /范围|位置/,
  );
  const inconsistent = structuredClone(short.analysis);
  inconsistent.near[0]!.intersection++;
  await assert.rejects(
    explainWritingOverlap(
      inconsistent,
      short.finding,
      "d1:0",
      "d2:0",
      new AbortController().signal,
      pause,
    ),
    /评分不符/,
  );
  const abort = new AbortController();
  await assert.rejects(
    explainWritingOverlap(
      short.analysis,
      short.finding,
      "d1:0",
      "d2:0",
      abort.signal,
      async () => {
        abort.abort();
      },
    ),
    { name: "AbortError" },
  );
});
