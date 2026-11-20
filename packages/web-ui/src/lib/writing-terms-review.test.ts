import test from "node:test";
import assert from "node:assert/strict";
import {
  overlapFixture as source,
  overlapStamp,
} from "../test-support/writing-overlap.ts";
import { analyzeWritingTerms } from "./writing-terms.ts";
import {
  DEFAULT_TERMS_POLICY,
  type TermsAnalysis,
  type TermsRecipe,
} from "./writing-terms-model.ts";
import {
  DEFAULT_TERMS_FILTER,
  summarizeTerms,
  termsClusters,
  termsRows,
  validateTermsMarks,
  type TermsMark,
} from "./writing-terms-review.ts";
import {
  termsHighlightPage,
  termsMatchContext,
} from "./writing-terms-context.ts";
import { prepareTermsReport } from "./writing-terms-report.ts";
const recipe: TermsRecipe = {
  format: "no-wave-writing-terms",
  version: 1,
  rules: [
    {
      preferred: "PRIVATE_TERM",
      alternatives: ["PRIVATE_ALIAS"],
      boundary: "substring",
    },
    { preferred: "TERM", alternatives: [], boundary: "substring" },
    { preferred: "UNSEEN_PRIVATE", alternatives: [], boundary: "substring" },
  ],
};
async function fixture() {
  return analyzeWritingTerms(
    await source([
      ["🦊 PRIVATE_TERM then PRIVATE_ALIAS and PRIVATE_TERM."],
      ["PRIVATE_ALIAS"],
      ["nothing listed"],
    ]),
    recipe,
    DEFAULT_TERMS_POLICY,
    new AbortController().signal,
    { pause: async () => {} },
  );
}

test("global and per-document term distributions distinguish spelling claims, distinct locations and transitive overlap clusters; zero cells remain visible", async () => {
  const analysis = await fixture(),
    before = JSON.stringify(analysis),
    clusters = termsClusters(analysis);
  assert.equal(clusters.length, 4);
  assert.equal(
    clusters.filter((cluster) => cluster.claims.length > 1).length,
    2,
  );
  const summary = summarizeTerms(analysis, []);
  assert.equal(summary.claims, 6);
  assert.equal(
    summary.locations,
    6,
    "nested TERM and PRIVATE_TERM have different exact spans",
  );
  assert.equal(summary.overlappingClaims, 4);
  assert.equal(summary.groups.length, 3);
  assert.equal(summary.groups[0]!.state, "mixed");
  assert.equal(summary.groups[2]!.state, "unseen");
  assert.equal(summary.cells.length, 9);
  assert.equal(
    summary.cells.find((cell) => cell.rule === "t1" && cell.document === "d2")!
      .alternatives,
    1,
  );
  assert.equal(summary.documents[2]!.claims, 0);
  assert.equal(summary.complete, true);
  assert.equal(JSON.stringify(analysis), before);
  assert.throws(() => summary.groups[0]!.variants.push("forged"), TypeError);
});

test("view filters never change global marks/report and invalid marks, unknown scope or mismatched term/variant filters reject atomically", async () => {
  const analysis = await fixture(),
    marks: TermsMark[] = [{ match: "m1", verdict: "intentional" }];
  assert.deepEqual(validateTermsMarks(analysis, marks), marks);
  const rows = termsRows(analysis, marks, {
    ...DEFAULT_TERMS_FILTER,
    document: "d2",
    kind: "alternative",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.unit.document, "d2");
  assert.equal(summarizeTerms(analysis, marks).unreviewed, 5);
  assert.equal(
    termsRows(analysis, marks, {
      ...DEFAULT_TERMS_FILTER,
      overlap: "overlapping",
    }).length,
    4,
  );
  for (const invalid of [
    [...marks, ...marks],
    [{ match: "missing", verdict: "intentional" }],
    [{ ...marks[0], body: "PRIVATE" }],
    [{ match: "m1", verdict: "delete" }],
  ])
    assert.throws(() => validateTermsMarks(analysis, invalid as TermsMark[]));
  for (const patch of [
    { document: "d20" },
    { rule: "t20" },
    { rule: "t2", variant: "t1:v1" },
    { overlap: "guess" },
  ])
    assert.throws(() =>
      termsRows(analysis, marks, {
        ...DEFAULT_TERMS_FILTER,
        ...patch,
      } as typeof DEFAULT_TERMS_FILTER),
    );
  assert.equal(marks.length, 1);
});

test("original Unicode coordinates, bounded contexts and overlap sweep pages reconstruct original text and retain every competing claim without surrogate splits", async () => {
  const analysis = await fixture(),
    unit = analysis.units[0]!;
  const hit = analysis.matches.find((hit) => hit.pattern === "t1:v1")!;
  const context = termsMatchContext(analysis, hit.id);
  assert.equal(context.match, "PRIVATE_TERM");
  assert.equal(context.pointStart, 2);
  assert.equal(context.start, 3);
  const pieces = termsHighlightPage(
    analysis,
    unit.id,
    0,
    unit.text.length,
    hit.id,
  );
  assert.equal(pieces.map((piece) => piece.text).join(""), unit.text);
  for (const piece of pieces) {
    const overlapping = analysis.matches.filter(
      (hit) =>
        hit.unit === unit.id && hit.start < piece.end && hit.end > piece.start,
    );
    assert.equal(piece.claims, overlapping.length);
    assert.equal(
      piece.selected,
      overlapping.some((item) => item.id === hit.id),
    );
    assert.equal(piece.preferred + piece.alternatives, piece.claims);
  }
  assert.ok(pieces.some((piece) => piece.claims === 2));
  assert.throws(
    () => termsHighlightPage(analysis, unit.id, 1, unit.text.length),
    /代理|分页/,
  );
  assert.throws(() => termsHighlightPage(analysis, "d20:0", 0, 1));
  assert.throws(() => termsMatchContext(analysis, "m999"));
});

test("export-only report contains all global counts, limits and numeric local witnesses but no manuscript or dictionary plaintext, and refuses tampered inventories", async () => {
  const analysis = await fixture(),
    marks: TermsMark[] = [{ match: "m1", verdict: "follow-up" }];
  const prepared = prepareTermsReport(analysis, marks, overlapStamp),
    report = JSON.parse(prepared.artifact.text);
  assert.equal(report.format, "no-wave-writing-terms-report");
  assert.equal(report.review.claims, 6);
  assert.equal(report.review.unreviewed, 5);
  assert.equal(report.matches.length, 6);
  assert.deepEqual(report.units[0].path, [0]);
  assert.doesNotMatch(
    prepared.artifact.text,
    /PRIVATE|UNSEEN|ALIAS|TERM|title|summary|filename|https:|children|needle|preferred|alternatives|before|after/,
  );
  assert.equal(prepared.artifact.name, "no-wave-terms-report-2026-11-12.json");
  assert.throws(() => prepareTermsReport(analysis, [], new Date("invalid")));
  const corrupted = structuredClone(analysis) as TermsAnalysis;
  corrupted.matches[0]!.end++;
  assert.throws(() => prepareTermsReport(corrupted, [], overlapStamp));
});

test("cached review inventories cannot accept mutable nested witnesses or unknown coverage/catalog fields that could later leak into reports", async () => {
  const analysis = await fixture();
  const patterns = analysis.patterns.map((pattern) => ({ ...pattern }));
  Object.freeze(patterns);
  const mutable = Object.freeze({ ...analysis, patterns });
  assert.throws(() => summarizeTerms(mutable), /变化|清单|完整/);
  const extraCoverage = Object.freeze({
    ...analysis,
    coverage: Object.freeze({ ...analysis.coverage, accountId: 42 }),
  });
  assert.throws(
    () => prepareTermsReport(extraCoverage, [], overlapStamp),
    /变化|清单|完整/,
  );
  const relation = Object.freeze({
    ...analysis.catalog.relations[0]!,
    left: "PRIVATE_UNOWNED",
  });
  const relations = [relation];
  Object.freeze(relations);
  const badCatalog = Object.freeze({
    ...analysis,
    catalog: Object.freeze({ ...analysis.catalog, relations }),
  });
  assert.throws(
    () => prepareTermsReport(badCatalog, [], overlapStamp),
    /变化|清单|完整/,
  );
});

test("a frozen ledger cannot invent, split or omit ambiguity components, or report impossible scan counter totals", async () => {
  const analysis = await fixture();
  for (const ids of [[], [["t1:v1"]], [["t1:v1", "t1:v2", "t2:v1"]]]) {
    for (const component of ids) Object.freeze(component);
    Object.freeze(ids);
    const forged = Object.freeze({
      ...analysis,
      catalog: Object.freeze({ ...analysis.catalog, components: ids }),
    });
    assert.throws(
      () => prepareTermsReport(forged, [], overlapStamp),
      /变化|清单|完整/,
    );
  }
  for (const patch of [
    { outputs: 0 },
    { steps: 0 },
    { wordRejected: analysis.coverage.outputs + 1 },
  ]) {
    const forged = Object.freeze({
      ...analysis,
      coverage: Object.freeze({ ...analysis.coverage, ...patch }),
    });
    assert.throws(
      () => prepareTermsReport(forged, [], overlapStamp),
      /变化|清单|完整/,
    );
  }
});
