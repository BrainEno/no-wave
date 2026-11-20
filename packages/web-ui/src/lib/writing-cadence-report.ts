import type { CollectionArtifact } from "./writing-collection-index.ts";
import type { CadenceAnalysis } from "./writing-cadence-model.ts";
import { cadenceInventory } from "./writing-cadence-index.ts";
import {
  cadenceMarksKey,
  validateCadenceMarks,
  type CadenceMark,
} from "./writing-cadence-review.ts";
import { cadenceProfile } from "./writing-cadence-profile.ts";
import { cadenceEnclosures } from "./writing-cadence-enclosures.ts";

export type PreparedCadenceReport = CollectionArtifact & {
  bytes: number;
  sourceKey: string;
  marksKey: string;
  items: number;
  unreviewed: number;
};

/** Content-free whitelist only; exact invisible code points, imported strings, contexts and nodes stay out. */
export function prepareCadenceReport(
  analysis: CadenceAnalysis,
  input: readonly CadenceMark[],
  now = new Date(),
): PreparedCadenceReport {
  const inventory = cadenceInventory(analysis),
    marks = validateCadenceMarks(analysis, input),
    profile = cadenceProfile(analysis);
  if (
    !Number.isFinite(now.getTime()) ||
    !/^\d{4}-\d{2}-\d{2}T/u.test(now.toISOString())
  )
    throw new Error("报告时间无效。");
  const states = new Map(marks.map((mark) => [mark.id, mark.state]));
  const items =
    analysis.findings.length +
    analysis.pairs.length +
    analysis.fragments.length;
  const report = {
    format: "no-wave-writing-cadence-report",
    version: 1,
    createdAt: now.toISOString(),
    algorithm: analysis.algorithm,
    sourceDigest: analysis.sourceKey,
    source: analysis.source,
    policy: { ...analysis.policy },
    coverage: { ...analysis.coverage },
    limit: analysis.limit,
    frontier: analysis.frontier
      ? { ...analysis.frontier, path: [...analysis.frontier.path] }
      : null,
    review: {
      items,
      marked: marks.length,
      intentional: marks.filter((mark) => mark.state === "intentional").length,
      followUp: marks.filter((mark) => mark.state === "follow-up").length,
      unreviewed: items - marks.length,
    },
    profile,
    enclosures: cadenceEnclosures(analysis).groups,
    units: analysis.units.map((unit) => ({
      id: unit.id,
      document: unit.document,
      kind: unit.kind,
      path: [...unit.path],
      runs: unit.runs.map((run) => ({ ...run })),
      barriers: unit.barriers.map((barrier) => ({ ...barrier })),
    })),
    findings: analysis.findings.map((finding) => ({
      id: finding.id,
      unit: finding.unit,
      kind: finding.kind,
      code: finding.code,
      family: finding.family,
      start: finding.start,
      end: finding.end,
      pointStart: finding.pointStart,
      pointEnd: finding.pointEnd,
      related: finding.related.map((range) => ({ ...range })),
      state: states.get(finding.id) ?? "unreviewed",
    })),
    pairs: analysis.pairs.map((pair) => ({
      id: pair.id,
      unit: pair.unit,
      family: pair.family,
      open: { ...pair.open },
      close: { ...pair.close },
      parent: inventory.topology.get(pair.id)!.parent,
      depth: inventory.topology.get(pair.id)!.depth,
      state: states.get(pair.id) ?? "unreviewed",
    })),
    fragments: analysis.fragments.map((fragment) => ({
      id: fragment.id,
      unit: fragment.unit,
      run: fragment.run,
      start: fragment.start,
      end: fragment.end,
      pointStart: fragment.pointStart,
      pointEnd: fragment.pointEnd,
      points: fragment.points,
      nonspace: fragment.nonspace,
      ending: fragment.ending,
      state: states.get(fragment.id) ?? "unreviewed",
    })),
  };
  const text = JSON.stringify(report) + "\n",
    bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > 2 * 1024 * 1024)
    throw new Error("无正文报告超过2 MiB，整份未准备；未截短全局清单。");
  return Object.freeze({
    name: `no-wave-cadence-report-${now.toISOString().slice(0, 10)}.json`,
    mime: "application/json;charset=utf-8",
    text,
    bytes,
    sourceKey: analysis.sourceKey,
    marksKey: cadenceMarksKey(analysis, marks),
    items,
    unreviewed: items - marks.length,
  });
}
