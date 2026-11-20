import test from "node:test";
import assert from "node:assert/strict";
import {
  createWritingCollection,
  openWritingCollection,
} from "./writing-collection.ts";
import { parseWritingBackup, createWritingBackup } from "./writing-backup.ts";
import type { WritingNode } from "./writing-document.ts";
import { analyzeWritingOverlap } from "./writing-overlap.ts";
import {
  DEFAULT_OVERLAP_POLICY,
  normalizeOverlapText,
  overlapPairCount,
  overlapPreview,
  validateOverlapPolicy,
  type OverlapPolicy,
} from "./writing-overlap-model.ts";
const date = new Date("2026-11-12T00:00:00.000Z");
const paragraph = (text: string, format = 0): WritingNode => ({
  type: "paragraph",
  version: 1,
  children: [{ type: "text", version: 1, text, format }],
});
async function source(documents: (string | WritingNode)[][]) {
  const prepared = await createWritingCollection(
    documents.map((items, index) => ({
      group: `document-${index}`,
      backup: parseWritingBackup(
        createWritingBackup(
          {
            title: `Private title ${index}`,
            summary: "Private summary",
            workType: "essay",
            locale: "en",
            editorState: {
              root: {
                type: "root",
                version: 1,
                children: items.map((item) =>
                  typeof item === "string" ? paragraph(item) : item,
                ),
              },
            },
          },
          date,
        ),
      ),
    })),
    date,
  );
  return openWritingCollection(prepared.text);
}
const policy = (patch: Partial<OverlapPolicy> = {}): OverlapPolicy => ({
  ...DEFAULT_OVERLAP_POLICY,
  minimum: 8,
  ...patch,
});
const signal = () => new AbortController().signal;
const pause = async () => {};

test("literal families preserve every occurrence and separate equal text from equal serialized rich nodes", async () => {
  const text =
    "A private paragraph repeated verbatim across selected manuscripts.";
  const input = await source([[text, paragraph(text, 1)], [text]]);
  const before = JSON.stringify(input);
  const found = await analyzeWritingOverlap(input, policy(), signal(), {
    pause,
  });
  assert.equal(found.exact.length, 1);
  assert.equal(
    found.exact[0]!.pairs,
    2,
    "cross-document pairs exclude the two occurrences in the same document",
  );
  assert.equal(found.exact[0]!.rawVariants, 1);
  assert.equal(found.exact[0]!.structuralVariants, 2);
  assert.deepEqual(found.families[0]!.units, ["d1:0", "d1:1", "d2:0"]);
  assert.equal(
    found.near.length,
    0,
    "identical text families cannot generate quadratic near duplicates",
  );
  assert.equal(JSON.stringify(input), before);
});

test("width/case/whitespace normalization is explicit and never rewrites the source text or assumes authorship", async () => {
  const original = "Ｒｉｖｅｒ  WORDS in the café";
  const input = await source([[original], ["river words in the café"]]);
  assert.equal(
    (await analyzeWritingOverlap(input, policy(), signal(), { pause })).exact
      .length,
    0,
  );
  const folded = await analyzeWritingOverlap(
    input,
    policy({ mode: "folded" }),
    signal(),
    { pause },
  );
  assert.equal(folded.exact.length, 1);
  assert.equal(folded.exact[0]!.rawVariants, 2);
  assert.equal(folded.units[0]!.text, original);
  assert.notEqual(normalizeOverlapText("cafe\u0301", "literal"), "café");
});

test("scope counts are combinatorial, not materialized occurrence pairs, and remain file-local", async () => {
  const input = await source([
    ["This same paragraph occurs twice.", "This same paragraph occurs twice."],
    ["This same paragraph occurs twice."],
  ]);
  for (const [scope, pairs] of [
    ["all", 3],
    ["within-document", 1],
    ["cross-document", 2],
  ] as const) {
    const found = await analyzeWritingOverlap(
      input,
      policy({ scope }),
      signal(),
      { pause },
    );
    assert.equal(found.exact[0]!.pairs, pairs);
    assert.equal(overlapPairCount(found.families[0]!, null, scope), pairs);
  }
});

function grams(text: string): Set<string> {
  const points = Array.from(text),
    result = new Set<string>();
  for (let index = 0; index + 5 <= points.length; index++)
    result.add(points.slice(index, index + 5).join(""));
  return result;
}
test("near candidate scores agree with an independent brute-force 5-code-point set oracle", async () => {
  const texts = [
    "The river remembers every quiet morning in the valley.",
    "The river remembers every quiet evening in the valley.",
    "The river remembers every quiet morning near the valley.",
    "Unrelated stones and mountain clouds travel north.",
  ];
  const found = await analyzeWritingOverlap(
    await source(texts.map((text) => [text])),
    policy({ threshold: 50 }),
    signal(),
    { pause },
  );
  const expected: { left: string; right: string; score: number }[] = [];
  for (let left = 0; left < texts.length; left++)
    for (let right = left + 1; right < texts.length; right++) {
      const a = grams(texts[left]!),
        b = grams(texts[right]!);
      const intersection = [...a].filter((item) => b.has(item)).length,
        union = new Set([...a, ...b]).size;
      if (intersection * 100 >= union * 50)
        expected.push({
          left: `f${left + 1}`,
          right: `f${right + 1}`,
          score: Math.floor((intersection * 10000) / union),
        });
    }
  assert.ok(expected.length > 0);
  assert.deepEqual(
    found.near
      .map((item) => ({
        left: item.left,
        right: item.right,
        score: item.basisPoints,
      }))
      .sort(
        (a, b) =>
          a.left.localeCompare(b.left) || a.right.localeCompare(b.right),
      ),
    expected,
  );
  assert.deepEqual(found.limits, []);
});

test("short strings and code are not treated as prose and Unicode previews never split a surrogate pair", async () => {
  const code = {
    type: "code",
    version: 1,
    children: [
      { type: "text", version: 1, text: "private code repeated twice" },
    ],
  };
  const found = await analyzeWritingOverlap(
    await source([
      ["tiny", code],
      ["tiny", code],
    ]),
    policy(),
    signal(),
    { pause },
  );
  assert.equal(found.coverage.eligible, 0);
  assert.equal(found.coverage.excluded, 4);
  const text = "a".repeat(2047) + "🦊" + "z";
  const first = overlapPreview(text),
    next = overlapPreview(text, first.end);
  assert.equal(first.text + next.text, text);
  assert.equal(first.more, true);
});

test("long identical units remain exact findings while the near-only exclusion is explicit", async () => {
  const text = "Long private paragraph ".repeat(250);
  const found = await analyzeWritingOverlap(
    await source([[text], [text]]),
    policy(),
    signal(),
    { pause },
  );
  assert.equal(found.exact.length, 1);
  assert.equal(
    found.coverage.long,
    1,
    "index budgets count unique text families, not repeated occurrences",
  );
  assert.ok(found.limits.includes("long-unit"));
});

test("common shingles and reduced compute budgets never masquerade as exhaustive no-match evidence", async () => {
  const input = await source([
    ["common boilerplate shared first ending"],
    ["common boilerplate shared second ending"],
    ["common boilerplate shared third ending"],
  ]);
  const found = await analyzeWritingOverlap(
    input,
    policy({ threshold: 50 }),
    signal(),
    { pause, budgets: { posting: 1 } },
  );
  assert.ok(found.coverage.common > 0);
  assert.ok(found.limits.includes("common-grams"));
  const limited = await analyzeWritingOverlap(
    input,
    policy({ threshold: 50 }),
    signal(),
    { pause, budgets: { indexGrams: 1 } },
  );
  assert.ok(limited.limits.includes("index-budget"));
  await assert.rejects(
    analyzeWritingOverlap(input, policy(), signal(), {
      pause,
      budgets: { candidates: 12001 },
    }),
    /预算|上限/,
  );
});

test("cancellation after a cooperative yield or synchronous progress notification returns no usable analysis", async () => {
  const input = await source([
    ["Private paragraph for cancellation."],
    ["Private paragraph for cancellation."],
  ]);
  const abort = new AbortController();
  await assert.rejects(
    analyzeWritingOverlap(input, policy(), abort.signal, {
      pause: async () => {
        abort.abort();
      },
    }),
    { name: "AbortError" },
  );
  const after = new AbortController();
  await assert.rejects(
    analyzeWritingOverlap(input, policy(), after.signal, {
      pause,
      progress: () => after.abort(),
    }),
    { name: "AbortError" },
  );
});

test("a corrupted or over-budget source is rejected atomically, not silently reduced", async () => {
  const input = await source([
    ["A paragraph that is longer than eight characters."],
  ]);
  await assert.rejects(
    analyzeWritingOverlap(input, policy(), signal(), {
      pause,
      budgets: { characters: 8 },
    }),
    /预算|截短/,
  );
  const changed = structuredClone(input);
  changed.prepared.text = changed.prepared.text.replace(
    "A paragraph",
    "B paragraph",
  );
  await assert.rejects(
    analyzeWritingOverlap(changed, policy(), signal(), { pause }),
    /摘要|校验/,
  );
  assert.throws(() => validateOverlapPolicy(policy({ threshold: 49 })));
  assert.throws(() =>
    validateOverlapPolicy({ ...policy(), accidental: true } as OverlapPolicy),
  );
});
