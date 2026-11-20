import {
  overlapActive,
  overlapPairCount,
  OVERLAP_SHINGLE_WIDTH,
  type OverlapBudgets,
  type OverlapCoverage,
  type OverlapFamily,
  type OverlapLimit,
  type OverlapNear,
  type OverlapPolicy,
  type OverlapProgress,
} from "./writing-overlap-model.ts";

type IndexedFamily = { family: OverlapFamily; grams: Set<string> };
type Index = { families: IndexedFamily[]; postings: Map<string, number[]> };
type Context = {
  budgets: OverlapBudgets;
  coverage: OverlapCoverage;
  limits: Set<OverlapLimit>;
  policy: OverlapPolicy;
  signal: AbortSignal;
  pause: () => Promise<void>;
  progress: (value: OverlapProgress) => void;
};

async function checkpoint(
  context: Context,
  stage: OverlapProgress["stage"],
  done: number,
  total: number,
) {
  overlapActive(context.signal);
  context.progress({ stage, done, total });
  overlapActive(context.signal);
  await context.pause();
  overlapActive(context.signal);
}

/** Full string shingles are Map keys, not truncated hashes that could collide. */
export async function indexOverlapFamilies(
  families: readonly OverlapFamily[],
  context: Context,
): Promise<Index> {
  const indexed: IndexedFamily[] = [];
  const postings = new Map<string, number[]>(),
    common = new Set<string>();
  for (let ordinal = 0; ordinal < families.length; ordinal++) {
    if (ordinal % 16 === 0)
      await checkpoint(context, "index", ordinal, families.length);
    const family = families[ordinal]!,
      points: string[] = [];
    for (const point of family.normalized) {
      points.push(point);
      if (points.length > context.budgets.nearCharacters) break;
    }
    if (points.length > context.budgets.nearCharacters) {
      context.coverage.long++;
      context.limits.add("long-unit");
      continue;
    }
    const grams = new Set<string>();
    for (let start = 0; start + OVERLAP_SHINGLE_WIDTH <= points.length; start++)
      grams.add(points.slice(start, start + OVERLAP_SHINGLE_WIDTH).join(""));
    if (context.coverage.grams + grams.size > context.budgets.indexGrams) {
      context.limits.add("index-budget");
      continue; // Do not admit a partially indexed family or use partial sets for a score.
    }
    const position = indexed.length;
    indexed.push({ family, grams });
    context.coverage.indexed++;
    context.coverage.grams += grams.size;
    for (const gram of grams) {
      if (common.has(gram)) continue;
      const list = postings.get(gram) ?? [];
      if (list.length === context.budgets.posting) {
        // Remove the ENTIRE posting: the first documents must not get privileged matches.
        postings.delete(gram);
        common.add(gram);
        context.coverage.common++;
        context.limits.add("common-grams");
      } else {
        list.push(position);
        postings.set(gram, list);
      }
    }
  }
  await checkpoint(context, "index", families.length, families.length);
  return { families: indexed, postings };
}

/** A bounded inverted index avoids occurrence-pair expansion and exhaustive all-pairs prose scans. */
export async function overlapCandidates(
  index: Index,
  context: Context,
): Promise<[number, number][]> {
  const seen = new Set<number>(),
    width = index.families.length;
  const result: [number, number][] = [];
  let visited = 0;
  outer: for (const posting of index.postings.values()) {
    for (let first = 0; first < posting.length; first++) {
      for (let second = first + 1; second < posting.length; second++) {
        if (context.coverage.probes === context.budgets.postingSteps) {
          context.limits.add("posting-budget");
          break outer;
        }
        context.coverage.probes++;
        if (context.coverage.probes % 1024 === 0)
          await checkpoint(context, "candidates", visited, index.postings.size);
        const left = posting[first]!,
          right = posting[second]!,
          key = left * width + right;
        if (seen.has(key)) continue;
        const a = index.families[left]!,
          b = index.families[right]!;
        // The maximum possible Jaccard is min(size)/max(size); this rejection has no false negatives.
        if (
          Math.min(a.grams.size, b.grams.size) * 100 <
            Math.max(a.grams.size, b.grams.size) * context.policy.threshold ||
          !overlapPairCount(a.family, b.family, context.policy.scope)
        )
          continue;
        if (result.length === context.budgets.candidates) {
          context.limits.add("candidate-budget");
          break outer;
        }
        seen.add(key);
        result.push([left, right]);
      }
    }
    visited++;
  }
  context.coverage.candidates = result.length;
  await checkpoint(context, "candidates", visited, index.postings.size);
  return result.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function nearOrder(a: OverlapNear, b: OverlapNear): number {
  return (
    b.basisPoints - a.basisPoints ||
    Number(a.left.slice(1)) - Number(b.left.slice(1)) ||
    Number(a.right.slice(1)) - Number(b.right.slice(1))
  );
}

/** Scores always use full sets, including common grams omitted only from candidate discovery. */
export async function compareOverlapCandidates(
  index: Index,
  candidates: readonly [number, number][],
  capacity: number,
  context: Context,
): Promise<OverlapNear[]> {
  const findings: OverlapNear[] = [];
  let comparisons = 0;
  for (let position = 0; position < candidates.length; position++) {
    if (position % 16 === 0)
      await checkpoint(context, "compare", position, candidates.length);
    const [left, right] = candidates[position]!,
      a = index.families[left]!,
      b = index.families[right]!;
    const [small, large] =
      a.grams.size <= b.grams.size ? [a.grams, b.grams] : [b.grams, a.grams];
    if (comparisons + small.size > context.budgets.comparisonSteps) {
      context.limits.add("comparison-budget");
      break;
    }
    let intersection = 0;
    for (const gram of small) if (large.has(gram)) intersection++;
    comparisons += small.size;
    context.coverage.compared++;
    const union = a.grams.size + b.grams.size - intersection;
    if (!union || intersection * 100 < union * context.policy.threshold)
      continue;
    context.coverage.qualified++;
    if (!capacity) {
      context.limits.add("result-budget");
      continue;
    }
    const finding: OverlapNear = {
      id: `n:${a.family.id}:${b.family.id}`,
      kind: "near",
      left: a.family.id,
      right: b.family.id,
      pairs: overlapPairCount(a.family, b.family, context.policy.scope),
      intersection,
      union,
      basisPoints: Math.floor((intersection * 10000) / union),
    };
    // Preserve the strongest completely scored candidates, even if they were discovered last.
    findings.push(finding);
    findings.sort(nearOrder);
    if (findings.length > capacity) {
      findings.pop();
      context.limits.add("result-budget");
    }
  }
  await checkpoint(
    context,
    "compare",
    context.coverage.compared,
    candidates.length,
  );
  return findings;
}
