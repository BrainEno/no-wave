import type { OpenedCollection } from "./writing-collection.ts";
import { overlapSource } from "./writing-overlap-source.ts";
import {
  compareOverlapCandidates,
  indexOverlapFamilies,
  overlapCandidates,
} from "./writing-overlap-index.ts";
import {
  overlapActive,
  overlapBudgets,
  overlapPairCount,
  validateOverlapPolicy,
  type OverlapAnalysis,
  type OverlapExact,
  type OverlapFamily,
  type OverlapLimit,
  type OverlapOptions,
  type OverlapPolicy,
} from "./writing-overlap-model.ts";

/** Analysis owns its data; a view cannot turn changed private text into a stale report witness. */
function sealAnalysis(analysis: OverlapAnalysis): OverlapAnalysis {
  for (const unit of analysis.units) {
    Object.freeze(unit.path);
    Object.freeze(unit);
  }
  for (const family of analysis.families) {
    for (const count of family.documents) Object.freeze(count);
    Object.freeze(family.documents);
    Object.freeze(family.units);
    Object.freeze(family);
  }
  for (const finding of [...analysis.exact, ...analysis.near])
    Object.freeze(finding);
  Object.freeze(analysis.units);
  Object.freeze(analysis.families);
  Object.freeze(analysis.exact);
  Object.freeze(analysis.near);
  Object.freeze(analysis.limits);
  Object.freeze(analysis.coverage);
  Object.freeze(analysis.policy);
  Object.freeze(analysis);
  return analysis;
}

export async function analyzeWritingOverlap(
  opened: OpenedCollection,
  raw: OverlapPolicy,
  signal: AbortSignal,
  options: OverlapOptions = {},
): Promise<OverlapAnalysis> {
  const policy = validateOverlapPolicy(raw),
    budgets = overlapBudgets(options.budgets);
  const pause =
    options.pause ??
    (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const progress = options.progress ?? (() => {});
  const source = await overlapSource(
    opened,
    policy,
    budgets,
    signal,
    pause,
    progress,
  );
  const families: OverlapFamily[] = [],
    groups = new Map<string, OverlapFamily>();
  const counts = new Map<OverlapFamily, Map<string, number>>();
  const units = new Map(source.units.map((unit) => [unit.id, unit]));
  for (const unit of source.units) {
    let family = groups.get(unit.normalized);
    if (!family) {
      family = {
        id: `f${families.length + 1}`,
        units: [],
        normalized: unit.normalized,
        documents: [],
      };
      groups.set(unit.normalized, family);
      counts.set(family, new Map());
      families.push(family);
    }
    family.units.push(unit.id);
    const documents = counts.get(family)!;
    documents.set(unit.document, (documents.get(unit.document) ?? 0) + 1);
  }
  source.coverage.families = families.length;
  const exact: OverlapExact[] = [],
    limits = new Set<OverlapLimit>();
  for (const family of families) {
    family.documents = [...counts.get(family)!];
    const pairs = overlapPairCount(family, null, policy.scope);
    if (!pairs) continue;
    source.coverage.qualified++;
    if (exact.length === budgets.results) {
      limits.add("result-budget");
      continue;
    }
    const members = family.units.map((id) => units.get(id)!);
    exact.push({
      id: `e:${family.id}`,
      kind: "exact",
      family: family.id,
      pairs,
      rawVariants: new Set(members.map((unit) => unit.text)).size,
      structuralVariants: new Set(members.map((unit) => unit.structure)).size,
    });
  }
  const context = {
    budgets,
    coverage: source.coverage,
    limits,
    policy,
    signal,
    pause,
    progress,
  };
  const index = await indexOverlapFamilies(families, context);
  const candidates = await overlapCandidates(index, context);
  const near = await compareOverlapCandidates(
    index,
    candidates,
    budgets.results - exact.length,
    context,
  );
  overlapActive(signal);
  return sealAnalysis({
    algorithm: "no-wave-writing-overlap-v1",
    ...source,
    policy,
    families,
    exact,
    near,
    limits: [...limits],
  });
}
