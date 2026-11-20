import type { CollectionArtifact } from "./writing-collection-index.ts";
import {
  overlapFamily,
  overlapFindings,
  overlapUnit,
  type OverlapAnalysis,
} from "./writing-overlap-model.ts";
import {
  overlapMarksKey,
  validateOverlapMarks,
  type OverlapMark,
} from "./writing-overlap-review.ts";

export type PreparedOverlapReport = {
  sourceKey: string;
  marksKey: string;
  findings: number;
  unreviewed: number;
  artifact: CollectionArtifact;
};

/** This format is export-only. No parser/apply/replay path is defined for it. */
export function prepareOverlapReport(
  analysis: OverlapAnalysis,
  raw: readonly OverlapMark[],
  now = new Date(),
): PreparedOverlapReport {
  if (
    !Number.isFinite(now.getTime()) ||
    !/^\d{4}-\d{2}-\d{2}T/.test(now.toISOString())
  )
    throw new Error("报告时间无效。");
  const marks = validateOverlapMarks(analysis, raw),
    selected = new Map(marks.map((mark) => [mark.finding, mark.verdict]));
  const findings = overlapFindings(analysis),
    familyIds = new Set<string>();
  const rows = findings.map((finding) => {
    if (finding.kind === "exact") {
      familyIds.add(finding.family);
      return {
        id: finding.id,
        kind: finding.kind,
        family: finding.family,
        pairs: finding.pairs,
        rawVariants: finding.rawVariants,
        richVariants: finding.structuralVariants,
        verdict: selected.get(finding.id) ?? null,
      };
    }
    familyIds.add(finding.left);
    familyIds.add(finding.right);
    return {
      id: finding.id,
      kind: finding.kind,
      left: finding.left,
      right: finding.right,
      pairs: finding.pairs,
      intersection: finding.intersection,
      union: finding.union,
      basisPoints: finding.basisPoints,
      verdict: selected.get(finding.id) ?? null,
    };
  });
  // Share occurrence inventories once: high-frequency families must not multiply report size.
  const families = [...familyIds].map((id) => ({
    id,
    occurrences: overlapFamily(analysis, id).units.map((key) => {
      const unit = overlapUnit(analysis, key);
      return {
        document: unit.document,
        group: unit.group,
        path: [...unit.path],
        kind: unit.kind,
      };
    }),
  }));
  const unreviewed = findings.length - marks.length;
  const report = {
    format: "no-wave-writing-overlap-report",
    version: 1,
    createdAt: now.toISOString(),
    algorithm: analysis.algorithm,
    sourceDigest: analysis.sourceKey,
    policy: { ...analysis.policy },
    coverage: { ...analysis.coverage },
    limits: [...analysis.limits],
    review: {
      findings: findings.length,
      unreviewed,
      intentional: marks.filter((mark) => mark.verdict === "intentional")
        .length,
      followUp: marks.filter((mark) => mark.verdict === "follow-up").length,
    },
    families,
    findings: rows,
  };
  const text = JSON.stringify(report, null, 2) + "\n";
  if (new TextEncoder().encode(text).byteLength > 2 * 1024 * 1024)
    throw new Error("无正文报告超过 2 MiB，未截断输出。");
  const artifact = {
    text,
    name: `no-wave-overlap-report-${report.createdAt.slice(0, 10)}.json`,
    mime: "application/json;charset=utf-8",
  };
  Object.freeze(artifact);
  return Object.freeze({
    sourceKey: analysis.sourceKey,
    marksKey: overlapMarksKey(analysis, marks),
    findings: findings.length,
    unreviewed,
    artifact,
  });
}
