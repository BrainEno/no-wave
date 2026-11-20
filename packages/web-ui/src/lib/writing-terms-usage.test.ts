import test from "node:test";
import assert from "node:assert/strict";
import { analyzeWritingTerms } from "./writing-terms.ts";
import {
  DEFAULT_TERMS_POLICY,
  type TermsRecipe,
} from "./writing-terms-model.ts";
import { profileTermsUsage, compareTermsUsage } from "./writing-terms-usage.ts";
import { overlapFixture as source } from "../test-support/writing-overlap.ts";
const recipe: TermsRecipe = {
  format: "no-wave-writing-terms",
  version: 1,
  rules: [
    { preferred: "US", alternatives: ["us", "USA"], boundary: "word" },
    { preferred: "US", alternatives: [], boundary: "word" },
  ],
};
async function fixture(partial = false) {
  return analyzeWritingTerms(
    await source([["US us USA"], ["us"], ["nothing"], ["US USA"]]),
    recipe,
    { ...DEFAULT_TERMS_POLICY, mode: "ascii-fold" },
    new AbortController().signal,
    { pause: async () => {}, budgets: partial ? { matches: 2 } : {} },
  );
}

test("spelling profiles collapse only within-rule folded equivalence, keep every claim and coordinate, and distinguish within-document mixing from cross-document signatures", async () => {
  const analysis = await fixture(),
    profile = profileTermsUsage(analysis),
    group = profile.groups[0]!;
  assert.equal(group.classes.length, 2);
  assert.deepEqual(group.classes[0]!.patterns, ["t1:v1", "t1:v2"]);
  assert.equal(group.cells[0]!.claims, 5);
  assert.equal(group.cells[0]!.locations, 3);
  assert.deepEqual(
    group.cells[0]!.classes.map((cell) => [cell.claims, cell.locations]),
    [
      [4, 2],
      [1, 1],
    ],
  );
  assert.deepEqual(group.mixedDocuments, ["d1", "d4"]);
  assert.deepEqual(
    group.signatures.map((signature) => [
      signature.classes,
      signature.documents,
    ]),
    [
      [
        ["t1:s1", "t1:s2"],
        ["d1", "d4"],
      ],
      [["t1:s1"], ["d2"]],
      [[], ["d3"]],
    ],
  );
  assert.deepEqual(group.coUses[0], {
    left: "t1:s1",
    right: "t1:s2",
    both: ["d1", "d4"],
    leftObservedOnly: ["d2"],
    rightObservedOnly: [],
    neitherObserved: ["d3"],
  });
  assert.doesNotMatch(
    JSON.stringify(profile),
    /USA|"US"|"us"|nothing|title|needle/,
  );
  assert.throws(() => group.classes[0]!.patterns.push("forged"), TypeError);
  assert.equal(profileTermsUsage(analysis), profile);
});

test("each cell and pair state agrees with an independent raw-match/span-set oracle; pair comparison refuses stale or unowned profiles", async () => {
  const analysis = await fixture(),
    profile = profileTermsUsage(analysis);
  for (const group of profile.groups)
    for (const cell of group.cells) {
      const source = analysis.matches.filter(
        (match) =>
          analysis.units.find((unit) => unit.id === match.unit)!.document ===
            cell.document &&
          analysis.patterns.find((pattern) => pattern.id === match.pattern)!
            .rule === group.rule,
      );
      assert.equal(cell.claims, source.length);
      assert.equal(
        cell.locations,
        new Set(
          source.map((match) => `${match.unit}/${match.start}/${match.end}`),
        ).size,
      );
      for (const spelling of group.classes) {
        const claims = source.filter((match) =>
            spelling.patterns.includes(match.pattern),
          ),
          found = cell.classes.find((item) => item.id === spelling.id)!;
        assert.equal(found.claims, claims.length);
        assert.equal(
          found.locations,
          new Set(
            claims.map((match) => `${match.unit}/${match.start}/${match.end}`),
          ).size,
        );
      }
    }
  for (const left of analysis.documents)
    for (const right of analysis.documents) {
      if (left === right) continue;
      const comparison = compareTermsUsage(analysis, profile, left, right);
      for (const row of comparison.groups) {
        const group = profile.groups.find((group) => group.rule === row.rule)!,
          a = group.cells.find((cell) => cell.document === left)!,
          b = group.cells.find((cell) => cell.document === right)!;
        assert.deepEqual(
          row.shared,
          a.observed.filter((id) => b.observed.includes(id)),
        );
        assert.deepEqual(
          row.leftOnly,
          a.observed.filter((id) => !b.observed.includes(id)),
        );
        assert.equal(
          row.difference,
          row.leftOnly.length + row.rightOnly.length,
        );
        assert.equal(
          row.state,
          a.observed.length === 0 && b.observed.length === 0
            ? "both-unseen"
            : row.difference
              ? "different-observed-set"
              : "same-observed-set",
        );
      }
    }
  assert.throws(() =>
    compareTermsUsage(analysis, structuredClone(profile), "d1", "d2"),
  );
  assert.throws(() => compareTermsUsage(analysis, profile, "d1", "d1"));
  assert.throws(() => compareTermsUsage(analysis, profile, "d0", "d2"));
  const newer = await fixture();
  assert.throws(() => compareTermsUsage(newer, profile, "d1", "d2"));
});

test("uncovered, partially covered and out-of-scope documents are not mislabelled as complete absence; positive observations remain lower bounds", async () => {
  const partial = await fixture(true),
    usage = profileTermsUsage(partial);
  assert.deepEqual(
    usage.documents.map((document) => document.state),
    ["partial", "unscanned", "unscanned", "unscanned"],
  );
  assert.equal(compareTermsUsage(partial, usage, "d1", "d2").comparable, false);
  const excluded = await analyzeWritingTerms(
    await source([["US"], ["US"]]),
    recipe,
    { ...DEFAULT_TERMS_POLICY, scope: "headings" },
    new AbortController().signal,
    { pause: async () => {} },
  );
  assert.deepEqual(
    profileTermsUsage(excluded).documents.map((document) => document.state),
    ["outside-scope", "outside-scope"],
  );
  assert.equal(
    compareTermsUsage(excluded, profileTermsUsage(excluded), "d1", "d2")
      .comparable,
    false,
  );
});
