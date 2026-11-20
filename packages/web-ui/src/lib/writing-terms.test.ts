import test from "node:test";
import assert from "node:assert/strict";
import {
  overlapFixture as source,
  overlapParagraph,
} from "../test-support/writing-overlap.ts";
import { analyzeWritingTerms } from "./writing-terms.ts";
import {
  parseTermsRecipe,
  validateTermsRecipe,
} from "./writing-terms-recipe.ts";
import {
  DEFAULT_TERMS_POLICY,
  type TermsPolicy,
  type TermsRecipe,
  type TermsRule,
} from "./writing-terms-model.ts";

const pause = async () => {};
const recipe = (rules: TermsRule[]): TermsRecipe => ({
  format: "no-wave-writing-terms",
  version: 1,
  rules,
});
const rule = (
  preferred: string,
  alternatives: string[] = [],
  boundary: TermsRule["boundary"] = "substring",
): TermsRule => ({ preferred, alternatives, boundary });
const signal = () => new AbortController().signal;
async function scan(
  texts: string[][],
  rules: TermsRule[],
  patch: Partial<TermsPolicy> = {},
) {
  return analyzeWritingTerms(
    await source(texts),
    recipe(rules),
    { ...DEFAULT_TERMS_POLICY, ...patch },
    signal(),
    { pause },
  );
}
function simpleFold(text: string, folded: boolean) {
  return folded ? text.replace(/[A-Z]/g, (point) => point.toLowerCase()) : text;
}
function oracle(text: string, rules: TermsRule[], folded = false) {
  const points = [...text],
    found: string[] = [];
  let offset = 0;
  for (let end = 1; end <= points.length; end++) {
    offset += points[end - 1]!.length;
    for (let group = 0; group < rules.length; group++) {
      const current = rules[group]!;
      for (const [index, variant] of [
        current.preferred,
        ...current.alternatives,
      ].entries()) {
        const length = [...variant].length,
          startPoint = end - length;
        if (
          startPoint < 0 ||
          simpleFold(points.slice(startPoint, end).join(""), folded) !==
            simpleFold(variant, folded)
        )
          continue;
        if (
          current.boundary === "word" &&
          (/[\p{L}\p{N}\p{M}_]/u.test(points[startPoint - 1] ?? "") ||
            /[\p{L}\p{N}\p{M}_]/u.test(points[end] ?? ""))
        )
          continue;
        found.push(
          `${offset - variant.length}:${offset}:t${group + 1}:v${index + 1}`,
        );
      }
    }
  }
  return found.sort();
}

test("term recipes are closed, bounded and owned; JSON duplicate names are not last-value-wins", () => {
  const original = recipe([
    rule("偏好用语", ["另一用语"]),
    rule("C++", [], "word"),
  ]);
  const parsed = parseTermsRecipe(JSON.stringify(original));
  assert.deepEqual(parsed, original);
  original.rules[0]!.alternatives[0] = "changed";
  assert.equal(parsed.rules[0]!.alternatives[0], "另一用语");
  assert.throws(() => parsed.rules[0]!.alternatives.push("mutate"), TypeError);
  for (const raw of [
    recipe([]),
    recipe([rule("")]),
    recipe([rule("a", ["a"])]),
    recipe([rule(" x")]),
    recipe([rule("x\u0000")]),
    recipe([rule("x".repeat(81))]),
    { ...original, unknown: true },
    recipe([rule("a", Array<string>(8).fill("b"))]),
  ])
    assert.throws(() => validateTermsRecipe(raw));
  assert.throws(
    () =>
      parseTermsRecipe(
        '{"format":"no-wave-writing-terms","version":2,"\\u0076ersion":1,"rules":[]}',
      ),
    /重复|歧义/,
  );
  assert.throws(
    () => parseTermsRecipe(" ".repeat(128 * 1024 + 1)),
    /128|字节|词表/,
  );
});

test("all overlapping and suffix matches agree with an independent brute-force Unicode oracle, including shared spellings and ASCII-only folding", async () => {
  const rules = [
    rule("he", ["she", "hers", "his"]),
    rule("a", ["aa", "aaa"]),
    rule("🦊海", ["海🦊"]),
    rule("US", ["us"], "word"),
    rule("he"),
  ];
  const text = "ushers his she aaaa 🦊海🦊海 US us ＵＳ K K e\u0301";
  for (const folded of [false, true]) {
    const result = await scan([[text]], rules, {
      mode: folded ? "ascii-fold" : "literal",
    });
    const actual = result.matches
      .map((hit) => `${hit.start}:${hit.end}:${hit.pattern}`)
      .sort();
    assert.deepEqual(actual, oracle(text, rules, folded));
    assert.equal(result.limit, null);
    assert.equal(result.frontier, null);
    assert.equal(result.coverage.scannedPoints, [...text].length);
    assert.equal(result.coverage.scannedCharacters, text.length);
    assert.ok(
      result.matches.filter((hit) => hit.start === text.indexOf("he")).length >=
        2,
      "same spelling retains both term-group claims",
    );
    assert.throws(() => result.matches.push(result.matches[0]!), TypeError);
  }
});

test("word boundaries use neighboring original Unicode letters/numbers/marks/underscore and never treat full-width or Kelvin signs as ASCII folds", async () => {
  const text =
    "cat cats _cat cat_ 猫cat cat猫 e\u0301cat cat\u0301 cat! ＣＡＴ CAT K K";
  const rules = [rule("cat", [], "word"), rule("K", [], "word")];
  const result = await scan([[text]], rules, { mode: "ascii-fold" });
  assert.deepEqual(
    result.matches
      .map((hit) => `${hit.start}:${hit.end}:${hit.pattern}`)
      .sort(),
    oracle(text, rules, true),
  );
  assert.equal(
    result.matches.filter((hit) => hit.pattern === "t1:v1").length,
    3,
  );
  assert.equal(
    result.matches.filter((hit) => hit.pattern === "t2:v1").length,
    1,
  );
  assert.ok(result.coverage.wordRejected > 0);
});

test("catalog self-review exposes every literal containment/equality relationship and connected ambiguity component without deciding a preferred winner", async () => {
  const rules = [rule("aa", ["a", "AA"]), rule("aaa"), rule("aa"), rule("z")];
  const result = await scan([["aaaa"]], rules, { mode: "ascii-fold" });
  const expected: string[] = [];
  for (const left of result.patterns)
    for (const right of result.patterns) {
      if (left.id === right.id) continue;
      if (
        left.needle === right.needle &&
        result.patterns.indexOf(left) > result.patterns.indexOf(right)
      )
        continue;
      if (left.needle.includes(right.needle))
        expected.push(
          `${left.id}/${right.id}/${left.needle === right.needle ? "equal" : "contains"}`,
        );
    }
  assert.deepEqual(
    result.catalog.relations
      .map((pair) => `${pair.left}/${pair.right}/${pair.kind}`)
      .sort(),
    expected.sort(),
  );
  assert.equal(result.catalog.complete, true);
  assert.equal(result.catalog.components.length, 1);
  assert.equal(result.catalog.components[0]!.length, 5);
  // Three length-two claims occur three times, length-one four times, length-three twice: 9 + 4 + 2.
  assert.equal(
    result.matches.length,
    oracle("aaaa", rules, true).length,
    "all overlapping claims survive catalog warnings",
  );
  assert.equal(result.matches.length, 15);
});

test("source snapshots preserve original paths and inline formatting without searching code, metadata or structural-break spans", async () => {
  const opened = await source([
    [
      {
        type: "paragraph",
        version: 1,
        children: [
          { type: "text", version: 1, text: "海", format: 1 },
          { type: "text", version: 1, text: "浪", format: 2 },
        ],
      },
      {
        type: "code",
        version: 1,
        children: [{ type: "text", version: 1, text: "海浪" }],
      },
      {
        type: "paragraph",
        version: 1,
        children: [
          { type: "text", version: 1, text: "海" },
          { type: "linebreak", version: 1 },
          { type: "text", version: 1, text: "浪" },
        ],
      },
      overlapParagraph("Private title 0"),
    ],
  ]);
  const before = JSON.stringify(opened);
  const result = await analyzeWritingTerms(
    opened,
    recipe([rule("海浪"), rule("title")]),
    DEFAULT_TERMS_POLICY,
    signal(),
    { pause },
  );
  assert.equal(result.matches.length, 2);
  assert.equal(
    result.units.find((unit) => unit.id === result.matches[0]!.unit)!.text,
    "海浪",
  );
  assert.deepEqual(result.units[0]!.path, [0]);
  assert.equal(result.coverage.excludedUnits, 1);
  assert.equal(JSON.stringify(opened), before);
  opened.prepared.collection.entries[0]!.backup.draft.title = "Caller mutation";
  assert.equal(result.units[0]!.text, "海浪");
  const headings = await scan([["海浪"]], [rule("海浪")], {
    scope: "headings",
  });
  assert.equal(headings.matches.length, 0);
  assert.equal(headings.coverage.eligibleUnits, 0);
});

test("match/output/transition budgets commit whole end positions, expose an exact uncovered frontier and never drop one ambiguous claim silently", async () => {
  const opened = await source([["aaaa"], ["aaaa"]]);
  const rules = recipe([rule("a"), rule("aa"), rule("a")]);
  const result = await analyzeWritingTerms(
    opened,
    rules,
    DEFAULT_TERMS_POLICY,
    signal(),
    { pause, budgets: { matches: 4 } },
  );
  assert.equal(result.limit, "matches");
  assert.equal(
    result.matches.length,
    2,
    "the second end position needs three claims; none of them fit atomically",
  );
  assert.deepEqual(result.frontier, { unit: "d1:0", point: 1, utf16: 1 });
  assert.equal(result.coverage.scannedPoints, 1);
  for (const field of ["outputs", "steps"] as const) {
    const limited = await analyzeWritingTerms(
      opened,
      rules,
      DEFAULT_TERMS_POLICY,
      signal(),
      { pause, budgets: { [field]: 1 } },
    );
    assert.equal(limited.limit, field);
    assert.ok(limited.frontier);
    assert.ok(limited.coverage.scannedPoints < limited.coverage.points);
  }
  const catalogLimited = await analyzeWritingTerms(
    opened,
    rules,
    DEFAULT_TERMS_POLICY,
    signal(),
    { pause, budgets: { relations: 1 } },
  );
  assert.equal(catalogLimited.catalog.complete, false);
  assert.equal(catalogLimited.catalog.relations.length, 1);
});

test("source/recipe overflows reject the whole round, stale serialized digests are not guessed, and abort after any cooperative yield publishes nothing", async () => {
  const opened = await source([["a".repeat(200)]]),
    rules = recipe([rule("a")]);
  for (const budgets of [
    { characters: 20 },
    { patterns: 1, states: 1 },
    { patternPoints: 1, states: 1 },
  ])
    await assert.rejects(
      analyzeWritingTerms(opened, rules, DEFAULT_TERMS_POLICY, signal(), {
        pause,
        budgets,
      }),
      /上限|预算|状态/,
    );
  const broken = structuredClone(opened);
  broken.prepared.collection.digest = "0".repeat(64);
  await assert.rejects(
    analyzeWritingTerms(broken, rules, DEFAULT_TERMS_POLICY, signal(), {
      pause,
    }),
    /摘要|快照/,
  );
  const abort = new AbortController();
  await assert.rejects(
    analyzeWritingTerms(opened, rules, DEFAULT_TERMS_POLICY, abort.signal, {
      pause: async () => abort.abort(),
    }),
    { name: "AbortError" },
  );
});

test("deterministic generated Unicode corpus and every reduced scan budget agree with the independent all-positions oracle at the exact prefix frontier", async () => {
  let random = 43217;
  const next = (bound: number) => {
    random = (random * 1664525 + 1013904223) >>> 0;
    return random % bound;
  };
  const alphabet = ["a", "A", "b", "海", "🦊", "é", "_", " ", "\u0301"];
  const rules = [
    rule("a", ["A", "aa", "aba"]),
    rule("b", ["ba"], "word"),
    rule("海🦊", ["🦊海", "海"]),
    rule("é", ["e\u0301"]),
    rule("a"),
  ];
  const texts = Array.from({ length: 80 }, () =>
    Array.from({ length: 50 }, () => alphabet[next(alphabet.length)]!).join(""),
  );
  for (const mode of ["literal", "ascii-fold"] as const) {
    const analysis = await scan([texts], rules, { mode });
    for (const unit of analysis.units)
      assert.deepEqual(
        analysis.matches
          .filter((match) => match.unit === unit.id)
          .map((match) => `${match.start}:${match.end}:${match.pattern}`)
          .sort(),
        oracle(unit.text, rules, mode === "ascii-fold"),
      );
  }
  const opened = await source([["🦊aa海🦊aba"], ["aabaa"]]);
  const { termsInventory } = await import("./writing-terms-index.ts");
  const { profileTermsUsage } = await import("./writing-terms-usage.ts");
  for (const field of ["matches", "outputs", "steps"] as const)
    for (let budget = 1; budget <= 20; budget++) {
      const analysis = await analyzeWritingTerms(
        opened,
        recipe(rules),
        DEFAULT_TERMS_POLICY,
        signal(),
        { pause, budgets: { [field]: budget } },
      );
      assert.doesNotThrow(() => termsInventory(analysis));
      assert.doesNotThrow(() => profileTermsUsage(analysis));
      const frontier = analysis.frontier
        ? analysis.units.findIndex(
            (unit) => unit.id === analysis.frontier!.unit,
          )
        : analysis.units.length;
      for (const [ordinal, unit] of analysis.units.entries()) {
        const end =
          ordinal < frontier
            ? unit.text.length
            : ordinal === frontier
              ? analysis.frontier!.utf16
              : 0;
        // Compare complete-end-position hits using original neighbors, not a substring with an invented word boundary.
        const expected = oracle(unit.text, rules).filter(
          (row) => Number(row.split(":")[1]) <= end,
        );
        assert.deepEqual(
          analysis.matches
            .filter((match) => match.unit === unit.id)
            .map((match) => `${match.start}:${match.end}:${match.pattern}`)
            .sort(),
          expected,
        );
      }
    }
});
