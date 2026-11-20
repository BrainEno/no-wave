import type { CollectionArtifact } from "./writing-collection-index.ts";
import type { TermsAnalysis } from "./writing-terms-model.ts";
import { termsInventory } from "./writing-terms-index.ts";
import { profileTermsUsage } from "./writing-terms-usage.ts";
import {
  summarizeTerms,
  termsMarksKey,
  validateTermsMarks,
  type TermsMark,
} from "./writing-terms-review.ts";
export type PreparedTermsReport = {
  sourceKey: string;
  recipeKey: string;
  marksKey: string;
  claims: number;
  unreviewed: number;
  artifact: CollectionArtifact;
};

/** Export-only metadata, never a recipe, manuscript, source locator or importable edit plan. */
export function prepareTermsReport(
  analysis: TermsAnalysis,
  raw: readonly TermsMark[],
  now = new Date(),
): PreparedTermsReport {
  if (
    !Number.isFinite(now.getTime()) ||
    !/^\d{4}-\d{2}-\d{2}T/u.test(now.toISOString())
  )
    throw new Error("术语报告时间无效。");
  const index = termsInventory(analysis),
    marks = validateTermsMarks(analysis, raw),
    chosen = new Map(marks.map((mark) => [mark.match, mark.verdict]));
  const summary = summarizeTerms(analysis, marks),
    usedUnits = new Set(analysis.matches.map((match) => match.unit));
  const report = {
    format: "no-wave-writing-terms-report",
    version: 1,
    createdAt: now.toISOString(),
    algorithm: analysis.algorithm,
    sourceDigest: analysis.sourceKey,
    recipeDigest: analysis.recipeKey,
    policy: { ...analysis.policy },
    coverage: { ...analysis.coverage },
    limit: analysis.limit,
    frontier: analysis.frontier ? { ...analysis.frontier } : null,
    catalog: {
      complete: analysis.catalog.complete,
      relations: analysis.catalog.relations.map((relation) => ({
        left: relation.left,
        right: relation.right,
        kind: relation.kind,
        offsets: [...relation.offsets],
      })),
      components: analysis.catalog.components.map((component) => [
        ...component,
      ]),
    },
    review: {
      claims: summary.claims,
      locations: summary.locations,
      overlappingClaims: summary.overlappingClaims,
      unreviewed: summary.unreviewed,
      intentional: marks.filter((mark) => mark.verdict === "intentional")
        .length,
      followUp: marks.filter((mark) => mark.verdict === "follow-up").length,
    },
    groups: summary.groups.map((group) => ({
      id: group.rule,
      claims: group.claims,
      locations: group.locations,
      primary: group.preferred,
      other: group.alternatives,
      variants: [...group.variants],
      documents: [...group.documents],
      unreviewed: group.unreviewed,
    })),
    documents: summary.documents.map((document) => ({ ...document })),
    usage: profileTermsUsage(analysis),
    units: analysis.units
      .filter((unit) => usedUnits.has(unit.id))
      .map((unit) => ({
        id: unit.id,
        document: unit.document,
        path: [...unit.path],
        kind: unit.kind,
      })),
    matches: analysis.matches.map((match) => ({
      id: match.id,
      unit: index.units.get(match.unit)!.id,
      pattern: index.patterns.get(match.pattern)!.id,
      start: match.start,
      end: match.end,
      pointStart: match.pointStart,
      pointEnd: match.pointEnd,
      verdict: chosen.get(match.id) ?? null,
    })),
  };
  const text = JSON.stringify(report, null, 2) + "\n";
  if (new TextEncoder().encode(text).byteLength > 2 * 1024 * 1024)
    throw new Error("术语无正文报告超过 2 MiB，未截断导出。");
  const artifact = Object.freeze({
    text,
    name: `no-wave-terms-report-${report.createdAt.slice(0, 10)}.json`,
    mime: "application/json;charset=utf-8",
  });
  return Object.freeze({
    sourceKey: analysis.sourceKey,
    recipeKey: analysis.recipeKey,
    marksKey: termsMarksKey(analysis, marks),
    claims: summary.claims,
    unreviewed: summary.unreviewed,
    artifact,
  });
}
