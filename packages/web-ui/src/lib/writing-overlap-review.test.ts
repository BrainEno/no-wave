import test from "node:test";
import assert from "node:assert/strict";
import {
  overlapFixture,
  overlapPolicy,
  overlapStamp,
} from "../test-support/writing-overlap.ts";
import { analyzeWritingOverlap } from "./writing-overlap.ts";
import {
  overlapReviewPage,
  overlapReviewRows,
  overlapOccurrences,
  resolveOverlapPair,
  validateOverlapMarks,
  type OverlapMark,
} from "./writing-overlap-review.ts";
import { prepareOverlapReport } from "./writing-overlap-report.ts";
const paragraph =
  "PRIVATE_BODY a quiet river crosses the valley every morning.";
async function fixture(
  scope: "all" | "cross-document" | "within-document" = "cross-document",
) {
  return analyzeWritingOverlap(
    await overlapFixture([
      [paragraph, paragraph],
      [paragraph, paragraph.replace("morning", "evening")],
    ]),
    overlapPolicy({ scope, threshold: 50 }),
    new AbortController().signal,
    { pause: async () => {} },
  );
}

test("manual follow-up/intentional marks are closed, ordered, and validated atomically rather than partially adopted", async () => {
  const analysis = await fixture(),
    first = analysis.exact[0]!.id,
    second = analysis.near[0]!.id;
  assert.deepEqual(
    validateOverlapMarks(analysis, [
      { finding: second, verdict: "follow-up" },
      { finding: first, verdict: "intentional" },
    ]),
    [
      { finding: first, verdict: "intentional" },
      { finding: second, verdict: "follow-up" },
    ],
  );
  for (const bad of [
    [{ finding: first, verdict: "delete" }],
    [{ finding: first, verdict: "intentional", body: "never export" }],
    [{ finding: "missing", verdict: "intentional" }],
    [
      { finding: first, verdict: "intentional" },
      { finding: first, verdict: "follow-up" },
    ],
  ])
    assert.throws(() => validateOverlapMarks(analysis, bad as OverlapMark[]));
});

test("filters and pages cannot discard hidden marks or misrepresent global review completion", async () => {
  const analysis = await fixture(),
    marked: OverlapMark[] = [
      { finding: analysis.exact[0]!.id, verdict: "intentional" },
    ];
  const rows = overlapReviewRows(analysis, marked, {
    kind: "all",
    status: "unreviewed",
    document: "all",
  });
  assert.deepEqual(
    rows.map((item) => item.finding.id),
    [analysis.near[0]!.id],
  );
  assert.deepEqual(marked, [
    { finding: analysis.exact[0]!.id, verdict: "intentional" },
  ]);
  assert.equal(overlapReviewPage(rows, 200).page, 0);
  assert.throws(() => overlapReviewPage(rows, -1));
  assert.equal(
    overlapReviewRows(analysis, marked, {
      kind: "exact",
      status: "intentional",
      document: "d2",
    }).length,
    1,
  );
  assert.throws(() =>
    overlapReviewRows(analysis, marked, {
      kind: "all",
      status: "all",
      document: "missing",
    }),
  );
});

test("occurrence selection uses exact family membership and document scope, never ordinal guesses or arbitrary same-source paragraphs", async () => {
  const analysis = await fixture(),
    exact = analysis.exact[0]!.id,
    near = analysis.near[0]!.id;
  assert.deepEqual(
    overlapOccurrences(analysis, exact, "left").map((unit) => unit.id),
    ["d1:0", "d1:1", "d2:0"],
  );
  assert.deepEqual(
    overlapOccurrences(analysis, exact, "right", "d1:0").map((unit) => unit.id),
    ["d2:0"],
  );
  assert.throws(
    () => resolveOverlapPair(analysis, exact, "d1:0", "d1:1"),
    /范围|位置/,
  );
  assert.throws(
    () => resolveOverlapPair(analysis, exact, "d1:0", "d2:1"),
    /组|位置/,
  );
  const resolved = resolveOverlapPair(analysis, near, "d1:1", "d2:1");
  assert.equal(resolved.left.text, paragraph);
  assert.equal(resolved.difference.textEqual, false);
  assert.equal(resolved.rawEqual, false);
  assert.equal(resolved.structuralEqual, false);
  const within = await fixture("within-document");
  assert.deepEqual(
    overlapOccurrences(within, within.exact[0]!.id, "left").map(
      (unit) => unit.id,
    ),
    ["d1:0", "d1:1"],
  );
  assert.deepEqual(
    overlapOccurrences(within, within.exact[0]!.id, "right", "d1:1").map(
      (unit) => unit.id,
    ),
    ["d1:0"],
  );
});

test("a no-body report carries all global findings, limits, file-local locations and unreviewed status without titles, text, filenames, URLs or tree structure", async () => {
  const analysis = await fixture();
  const prepared = prepareOverlapReport(
    analysis,
    [{ finding: analysis.exact[0]!.id, verdict: "intentional" }],
    overlapStamp,
  );
  const report = JSON.parse(prepared.artifact.text);
  assert.equal(report.format, "no-wave-writing-overlap-report");
  assert.equal(report.review.unreviewed, 1);
  assert.equal(report.review.intentional, 1);
  assert.equal(
    report.findings.length,
    analysis.exact.length + analysis.near.length,
  );
  assert.equal(
    report.findings.find((item: { kind: string }) => item.kind === "near")
      .verdict,
    null,
  );
  assert.deepEqual(
    report.families[0].occurrences.map(
      (item: { document: string; path: number[] }) => [
        item.document,
        item.path,
      ],
    ),
    [
      ["d1", [0]],
      ["d1", [1]],
      ["d2", [0]],
    ],
  );
  assert.doesNotMatch(
    prepared.artifact.text,
    /PRIVATE|Private|river|evening|title|summary|filename|https:|children|normalized|structure|authorId|revision|token|password/,
  );
  assert.match(
    prepared.artifact.name,
    /^no-wave-overlap-report-2026-11-12\.json$/,
  );
  assert.equal(prepared.artifact.mime, "application/json;charset=utf-8");
  assert.throws(() => prepareOverlapReport(analysis, [], new Date("invalid")));
});
