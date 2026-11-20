import type {
  CadenceAnalysis,
  CadenceFragment,
  CadencePair,
} from "./writing-cadence-model.ts";
import { cadenceInventory } from "./writing-cadence-index.ts";
import {
  cadenceProfile,
  type CadenceCoverageState,
} from "./writing-cadence-profile.ts";

export type CadencePairSpan = {
  pair: string;
  unit: string;
  document: string;
  first: string;
  last: string;
  fragments: number;
  containedFragments: number;
  boundaries: number;
  examples: string[];
};
export type CadenceSeam = {
  unit: string;
  document: string;
  before: string;
  after: string;
  at: number;
  pointAt: number;
  depth: number;
};
export type CadencePairRhythm = {
  pairs: CadencePairSpan[];
  seams: CadenceSeam[];
  documents: {
    document: string;
    coverage: CadenceCoverageState;
    pairs: number;
    withinOne: number;
    spanning: number;
    seams: number;
    insideSeams: number;
    maximumDepth: number | null;
    pairBoundaryIncidences: number;
    examples: string[];
  }[];
};
const cache = new WeakMap<CadenceAnalysis, CadencePairRhythm>();
function freezeResult(result: CadencePairRhythm): CadencePairRhythm {
  for (const pair of result.pairs) {
    Object.freeze(pair.examples);
    Object.freeze(pair);
  }
  for (const seam of result.seams) Object.freeze(seam);
  for (const document of result.documents) {
    Object.freeze(document.examples);
    Object.freeze(document);
  }
  Object.freeze(result.pairs);
  Object.freeze(result.seams);
  Object.freeze(result.documents);
  return Object.freeze(result);
}
function containing(fragments: readonly CadenceFragment[], at: number): number {
  let low = 0,
    high = fragments.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (fragments[middle]!.end <= at) low = middle + 1;
    else high = middle;
  }
  const fragment = fragments[low];
  if (!fragment || fragment.start > at)
    throw new Error("配对端点不在已提交片段内，未借用相邻游程。");
  return low;
}

/** Reverse interval join plus a difference sweep: O(pairs log fragments + fragments), no pair×fragment materialization. */
export function cadencePairRhythm(
  analysis: CadenceAnalysis,
): CadencePairRhythm {
  const inventory = cadenceInventory(analysis),
    previous = cache.get(analysis);
  if (previous) return previous;
  const sources = new Map(
    analysis.units.map((unit) => [
      unit.id,
      { fragments: [] as CadenceFragment[], pairs: [] as CadencePair[] },
    ]),
  );
  for (const fragment of analysis.fragments)
    sources.get(fragment.unit)!.fragments.push(fragment);
  for (const pair of analysis.pairs) sources.get(pair.unit)!.pairs.push(pair);
  const pairs: CadencePairSpan[] = [],
    seams: CadenceSeam[] = [];
  const summaries = new Map(
    cadenceProfile(analysis).documents.map((document) => [
      document.document,
      {
        document: document.document,
        coverage: document.coverage,
        pairs: 0,
        withinOne: 0,
        spanning: 0,
        seams: 0,
        insideSeams: 0,
        maximumDepth: null as number | null,
        pairBoundaryIncidences: 0,
        examples: [] as string[],
      },
    ]),
  );
  for (const [unitId, source] of sources) {
    const document = inventory.units.get(unitId)!.document,
      summary = summaries.get(document)!,
      fragments = source.fragments;
    const delta = Array<number>(fragments.length + 1).fill(0);
    let expectedIncidences = 0;
    for (const pair of source.pairs) {
      const from = containing(fragments, pair.open.start),
        to = containing(fragments, pair.close.start);
      const first = fragments[from]!,
        last = fragments[to]!;
      if (
        from > to ||
        first.run !== last.run ||
        first.pointStart > pair.open.pointStart ||
        last.pointEnd < pair.close.pointEnd
      )
        throw new Error("配对与片段的原文顺序或游程不一致，未拼接跨度。");
      const fullyFrom = from + (first.start < pair.open.start ? 1 : 0),
        fullyTo = to - (last.end > pair.close.end ? 1 : 0);
      const containedFragments = Math.max(0, fullyTo - fullyFrom + 1),
        boundaries = to - from;
      if (containedFragments > boundaries + 1)
        throw new Error("完整片段数超过相交片段数。");
      const examples: string[] = [];
      for (
        let index = fullyFrom;
        index <= fullyTo && examples.length < 3;
        index++
      )
        examples.push(fragments[index]!.id);
      pairs.push({
        pair: pair.id,
        unit: unitId,
        document,
        first: first.id,
        last: last.id,
        fragments: boundaries + 1,
        containedFragments,
        boundaries,
        examples,
      });
      delta[from] = delta[from]! + 1;
      delta[to] = delta[to]! - 1;
      expectedIncidences += boundaries;
      summary.pairs++;
      if (boundaries === 0) summary.withinOne++;
      else {
        summary.spanning++;
        if (summary.examples.length < 3) summary.examples.push(pair.id);
      }
    }
    let depth = 0,
      observedIncidences = 0;
    for (const [index, fragment] of fragments.entries()) {
      depth += delta[index]!;
      if (depth < 0 || depth > source.pairs.length)
        throw new Error("停顿边界配对深度不守恒。");
      const next = fragments[index + 1];
      if (!next || fragment.run !== next.run) {
        if (depth !== 0)
          throw new Error("配对跨越了片段游程末端，未给结构断点计分。");
        continue;
      }
      if (
        fragment.end !== next.start ||
        fragment.pointEnd !== next.pointStart ||
        fragment.ending !== "terminal"
      )
        throw new Error("停顿边界不是同游程的连续原文位置。");
      seams.push({
        unit: unitId,
        document,
        before: fragment.id,
        after: next.id,
        at: fragment.end,
        pointAt: fragment.pointEnd,
        depth,
      });
      observedIncidences += depth;
      summary.seams++;
      if (depth > 0) summary.insideSeams++;
      summary.maximumDepth = Math.max(summary.maximumDepth ?? 0, depth);
    }
    if (depth !== 0 || expectedIncidences !== observedIncidences)
      throw new Error("配对跨边界次数与逐边界深度之和不符，未发布部分画像。");
    summary.pairBoundaryIncidences += observedIncidences;
  }
  for (const summary of summaries.values()) {
    if (
      summary.withinOne + summary.spanning !== summary.pairs ||
      summary.insideSeams > summary.seams ||
      (summary.maximumDepth !== null && summary.maximumDepth > summary.pairs)
    )
      throw new Error("文稿配对节奏汇总不守恒。");
  }
  if (
    pairs.length !== analysis.pairs.length ||
    [...summaries.values()].reduce((sum, summary) => sum + summary.pairs, 0) !==
      pairs.length
  )
    throw new Error("配对节奏画像遗漏或重复了已提交配对。");
  const result = freezeResult({
    pairs,
    seams,
    documents: [...summaries.values()],
  });
  cache.set(analysis, result);
  return result;
}
