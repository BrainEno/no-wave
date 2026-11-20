import test from "node:test";
import assert from "node:assert/strict";
import {
  overlapFixture,
  overlapPolicy,
} from "../test-support/writing-overlap.ts";
import { analyzeWritingOverlap } from "./writing-overlap.ts";
import { explainWritingOverlap } from "./writing-overlap-evidence.ts";
import {
  DEFAULT_OVERLAP_EVIDENCE_FILTER,
  overlapEvidenceTerms,
  overlapEvidenceContext,
  overlapEvidenceSegments,
  overlapEvidenceAnchors,
} from "./writing-overlap-evidence-view.ts";
import { overlapPreview } from "./writing-overlap-model.ts";
const pause = async () => {};
async function fixture() {
  const text =
    "A private river 🦊 flows beneath willow trees [a.*] and a quiet sky. ".repeat(
      40,
    );
  const source = await overlapFixture([
    [text],
    [text.replaceAll("quiet", "amber")],
  ]);
  const analysis = await analyzeWritingOverlap(
    source,
    overlapPolicy({ threshold: 50 }),
    new AbortController().signal,
    { pause },
  );
  return explainWritingOverlap(
    analysis,
    analysis.near[0]!.id,
    "d1:0",
    "d2:0",
    new AbortController().signal,
    pause,
  );
}

test("diagnostic term filters remain bounded/literal and frequency sorting never mutates the owned explanation", async () => {
  const evidence = await fixture(),
    before = JSON.stringify(evidence);
  const literal = overlapEvidenceTerms(evidence, {
    ...DEFAULT_OVERLAP_EVIDENCE_FILTER,
    query: "[a.*]",
  });
  assert.equal(literal.length, 1);
  assert.equal(literal[0]!.text, "[a.*]");
  const sorted = overlapEvidenceTerms(evidence, {
    ...DEFAULT_OVERLAP_EVIDENCE_FILTER,
    order: "imbalance",
  });
  const differences = sorted.map((term) =>
    Math.abs(term.left.length - term.right.length),
  );
  assert.deepEqual(
    differences,
    [...differences].sort((a, b) => b - a),
  );
  assert.ok(
    overlapEvidenceTerms(evidence, {
      ...DEFAULT_OVERLAP_EVIDENCE_FILTER,
      kind: "right-only",
    }).every((term) => term.right.length > 0 && !term.left.length),
  );
  for (const query of ["a".repeat(121), "\u0000", "\ud800"])
    assert.throws(() =>
      overlapEvidenceTerms(evidence, {
        ...DEFAULT_OVERLAP_EVIDENCE_FILTER,
        query,
      }),
    );
  assert.equal(JSON.stringify(evidence), before);
});

test("every occurrence, including late repeated text and emoji offsets, is reachable through bounded exact contexts without neighboring-position fallback", async () => {
  const evidence = await fixture(),
    term = evidence.terms.find((term) => term.text.includes("🦊"))!;
  const last = overlapEvidenceContext(
    evidence,
    "left",
    term.id,
    term.left.length - 1,
  );
  assert.equal(last.match, term.text);
  assert.ok(last.pointStart > 2000);
  assert.equal(
    evidence.left.text.slice(last.utf16Start, last.utf16End),
    term.text,
  );
  assert.ok([...last.before].length <= 40);
  assert.ok([...last.after].length <= 40);
  assert.throws(() =>
    overlapEvidenceContext(evidence, "left", term.id, term.left.length),
  );
  assert.throws(() => overlapEvidenceContext(evidence, "right", "missing", 0));
  const only = evidence.terms.find((term) => term.kind === "left-only")!;
  assert.throws(() => overlapEvidenceContext(evidence, "right", only.id, 0));
});

test("coverage markup reconstructs every UTF-16 page exactly, never splits a surrogate pair, and exposes rather than hides broken coverage", async () => {
  const evidence = await fixture();
  for (const side of ["left", "right"] as const) {
    let offset = 0,
      result = "";
    while (offset < evidence[side].text.length) {
      const page = overlapPreview(evidence[side].text, offset),
        segments = overlapEvidenceSegments(
          evidence,
          side,
          page.start,
          page.end,
        );
      assert.equal(segments.map((segment) => segment.text).join(""), page.text);
      result += page.text;
      offset = page.end;
    }
    assert.equal(result, evidence[side].text);
  }
  const low = evidence.left.text.indexOf("🦊") + 1;
  assert.throws(() => overlapEvidenceSegments(evidence, "left", low, low + 5));
  assert.throws(() => overlapEvidenceSegments(evidence, "left", 0, 2049));
  const broken = structuredClone(evidence);
  broken.left.spans = [];
  assert.throws(() => overlapEvidenceSegments(broken, "left", 0, 10), /不完整/);
  assert.equal(
    overlapEvidenceAnchors(evidence, "chain").length,
    evidence.chainLength,
  );
  assert.equal(
    overlapEvidenceAnchors(evidence, "all").length,
    overlapEvidenceAnchors(evidence, "chain").length +
      overlapEvidenceAnchors(evidence, "outside").length,
  );
});
