import type {
  CadenceAnalysis,
  CadenceFindingKind,
  CadenceFragment,
} from "./writing-cadence-model.ts";
import { cadenceInventory } from "./writing-cadence-index.ts";
import { summarizeCadenceLengths } from "./writing-cadence-rhythm.ts";
import {
  cadenceProfile,
  type CadenceCoverageState,
} from "./writing-cadence-profile.ts";

type Interval = { start: number; end: number };
export type CadenceEnclosureEntry = {
  fragment: string;
  unit: string;
  document: string;
  points: number;
  pairedPoints: number;
  touchedPairs: number;
  fullyContained: number;
  depthAtStart: number;
  depthAtEnd: number;
  relation: "contained" | "intersecting" | "outside";
  findings: Record<CadenceFindingKind, number>;
};
export type CadenceEnclosureGroup = {
  document: string;
  relation: CadenceEnclosureEntry["relation"];
  coverage: CadenceCoverageState;
  fragments: number;
  points: number;
  pairedPoints: number;
  observations: number;
  lengths: ReturnType<typeof summarizeCadenceLengths>;
  examples: string[];
};
export type CadenceEnclosures = {
  entries: CadenceEnclosureEntry[];
  groups: CadenceEnclosureGroup[];
};
const cache = new WeakMap<CadenceAnalysis, CadenceEnclosures>();
const findingKinds: CadenceFindingKind[] = [
  "unclosed-open",
  "unexpected-close",
  "blocked-close",
  "invisible",
  "whitespace-run",
  "punctuation-run",
];

/** Count < target, or <= target. Half-open interval endpoints must never change with a view filter. */
function bound(
  values: readonly number[],
  target: number,
  inclusive: boolean,
): number {
  let low = 0,
    high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2),
      value = values[middle]!;
    if (value < target || (inclusive && value === target)) low = middle + 1;
    else high = middle;
  }
  return low;
}
class EndCounts {
  private readonly counts: number[];
  constructor(size: number) {
    this.counts = Array(size + 1).fill(0);
  }
  add(position: number): void {
    for (
      let index = position + 1;
      index < this.counts.length;
      index += index & -index
    )
      this.counts[index] = this.counts[index]! + 1;
  }
  before(size: number): number {
    let total = 0;
    for (let index = size; index > 0; index -= index & -index)
      total += this.counts[index]!;
    return total;
  }
}
function freezeEnclosures(result: CadenceEnclosures): CadenceEnclosures {
  for (const entry of result.entries) {
    Object.freeze(entry.findings);
    Object.freeze(entry);
  }
  for (const group of result.groups) {
    for (const bucket of group.lengths.buckets) Object.freeze(bucket);
    Object.freeze(group.lengths.buckets);
    if (group.lengths.mean) Object.freeze(group.lengths.mean);
    Object.freeze(group.lengths);
    Object.freeze(group.examples);
    Object.freeze(group);
  }
  Object.freeze(result.entries);
  Object.freeze(result.groups);
  return Object.freeze(result);
}

/** Interval join is O((pairs + fragments + observations) log n), never materializes every fragment × pair. */
export function cadenceEnclosures(
  analysis: CadenceAnalysis,
  document = "all",
): CadenceEnclosures {
  const inventory = cadenceInventory(analysis);
  if (document !== "all" && !analysis.documents.includes(document))
    throw new Error("配对交叉画像文稿无效，未回退到其他篇。");
  const previous = cache.get(analysis);
  if (previous)
    return document === "all"
      ? previous
      : freezeEnclosures({
          entries: previous.entries.filter(
            (entry) => entry.document === document,
          ),
          groups: previous.groups.filter(
            (group) => group.document === document,
          ),
        });
  const data = new Map(
    analysis.units.map((unit) => [
      unit.id,
      {
        pairs: [] as Interval[],
        roots: [] as Interval[],
        fragments: [] as CadenceFragment[],
        findings: new Map(
          findingKinds.map((kind) => [
            kind,
            { starts: [] as number[], ends: [] as number[] },
          ]),
        ),
      },
    ]),
  );
  for (const pair of analysis.pairs) {
    const source = data.get(pair.unit)!,
      span = { start: pair.open.pointStart, end: pair.close.pointEnd };
    source.pairs.push(span);
    if (inventory.topology.get(pair.id)!.parent === null)
      source.roots.push(span);
  }
  for (const fragment of analysis.fragments)
    data.get(fragment.unit)!.fragments.push(fragment);
  for (const finding of analysis.findings) {
    const ranges = data.get(finding.unit)!.findings.get(finding.kind)!;
    ranges.starts.push(finding.start);
    ranges.ends.push(finding.end);
  }
  const entries: CadenceEnclosureEntry[] = [];
  for (const unit of analysis.units) {
    const source = data.get(unit.id)!;
    if (!source.fragments.length) continue;
    source.pairs.sort((a, b) => a.start - b.start);
    source.roots.sort((a, b) => a.start - b.start);
    const starts = source.pairs.map((pair) => pair.start),
      ends = source.pairs.map((pair) => pair.end).sort((a, b) => a - b);
    const rootStarts = source.roots.map((root) => root.start),
      prefix = [0],
      endCounts = new EndCounts(ends.length);
    let lastEnd = -1;
    for (const root of source.roots) {
      if (root.start < lastEnd)
        throw new Error("配对森林根跨度相交，未重复累计覆盖。");
      prefix.push(prefix.at(-1)! + root.end - root.start);
      lastEnd = root.end;
    }
    const coveredUntil = (point: number): number => {
      const count = bound(rootStarts, point, false);
      if (!count) return 0;
      const root = source.roots[count - 1]!;
      return (
        prefix[count - 1]! + Math.max(0, Math.min(point, root.end) - root.start)
      );
    };
    for (const ranges of source.findings.values()) {
      ranges.starts.sort((a, b) => a - b);
      ranges.ends.sort((a, b) => a - b);
    }
    let added = 0;
    for (const fragment of source.fragments) {
      while (
        added < source.pairs.length &&
        source.pairs[added]!.start <= fragment.pointStart
      ) {
        endCounts.add(bound(ends, source.pairs[added]!.end, false));
        added++;
      }
      const fullyContained =
        added - endCounts.before(bound(ends, fragment.pointEnd, false));
      const depthAtStart = added - bound(ends, fragment.pointStart, true);
      const depthAtEnd =
        bound(starts, fragment.pointEnd, false) -
        bound(ends, fragment.pointEnd, false);
      const touchedPairs =
        bound(starts, fragment.pointEnd, false) -
        bound(ends, fragment.pointStart, true);
      const pairedPoints =
        coveredUntil(fragment.pointEnd) - coveredUntil(fragment.pointStart);
      if (
        fullyContained < 0 ||
        depthAtStart < 0 ||
        depthAtEnd < 0 ||
        touchedPairs < fullyContained ||
        fullyContained > depthAtStart ||
        fullyContained > depthAtEnd ||
        pairedPoints < 0 ||
        pairedPoints > fragment.points
      )
        throw new Error("配对与片段交叉计数不守恒，未显示部分画像。");
      const findings = {} as Record<CadenceFindingKind, number>;
      for (const kind of findingKinds) {
        const ranges = source.findings.get(kind)!;
        findings[kind] =
          bound(ranges.starts, fragment.end, false) -
          bound(ranges.ends, fragment.start, true);
        if (findings[kind] < 0)
          throw new Error("相交观察出现负数，未显示画像。");
      }
      entries.push({
        fragment: fragment.id,
        unit: unit.id,
        document: unit.document,
        points: fragment.points,
        pairedPoints,
        touchedPairs,
        fullyContained,
        depthAtStart,
        depthAtEnd,
        relation:
          fullyContained > 0
            ? "contained"
            : touchedPairs > 0
              ? "intersecting"
              : "outside",
        findings,
      });
    }
  }
  const byFragment = new Map(
    analysis.fragments.map((fragment) => [fragment.id, fragment]),
  );
  const groups: CadenceEnclosureGroup[] = [],
    profile = cadenceProfile(analysis);
  const buckets = new Map<
    string,
    { entries: CadenceEnclosureEntry[]; fragments: CadenceFragment[] }
  >();
  for (const entry of entries) {
    const key = `${entry.document}/${entry.relation}`,
      bucket = buckets.get(key) ?? { entries: [], fragments: [] };
    bucket.entries.push(entry);
    bucket.fragments.push(byFragment.get(entry.fragment)!);
    buckets.set(key, bucket);
  }
  for (const document of profile.documents) {
    for (const relation of ["contained", "intersecting", "outside"] as const) {
      const bucket = buckets.get(`${document.document}/${relation}`) ?? {
        entries: [],
        fragments: [],
      };
      groups.push({
        document: document.document,
        relation,
        coverage: document.coverage,
        fragments: bucket.fragments.length,
        points: bucket.entries.reduce((sum, entry) => sum + entry.points, 0),
        pairedPoints: bucket.entries.reduce(
          (sum, entry) => sum + entry.pairedPoints,
          0,
        ),
        observations: bucket.entries.reduce(
          (sum, entry) =>
            sum + Object.values(entry.findings).reduce((a, b) => a + b, 0),
          0,
        ),
        lengths: summarizeCadenceLengths(bucket.fragments, analysis.policy),
        examples: bucket.fragments.slice(0, 3).map((fragment) => fragment.id),
      });
    }
  }
  if (
    entries.length !== analysis.fragments.length ||
    groups.reduce((sum, group) => sum + group.fragments, 0) !== entries.length
  )
    throw new Error("片段交叉画像遗漏或重复成员，未显示分布。");
  const result = freezeEnclosures({ entries, groups });
  cache.set(analysis, result);
  return document === "all"
    ? result
    : freezeEnclosures({
        entries: result.entries.filter((entry) => entry.document === document),
        groups: result.groups.filter((group) => group.document === document),
      });
}
