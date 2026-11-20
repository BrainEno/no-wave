import type {
  CadenceFragment,
  CadencePolicy,
  CadenceTape,
} from "./writing-cadence-model.ts";
import {
  cadenceAttaches,
  cadenceCheckpoint,
  CadenceMeter,
  cadenceRange,
  cadenceTerminal,
} from "./writing-cadence-symbols.ts";

/** These are punctuation-delimited fragments, NOT linguistic sentences or a readability grade. */
export async function fragmentCadenceTape(
  tape: CadenceTape,
  run: number,
  policy: CadencePolicy,
  meter: CadenceMeter,
  signal: AbortSignal,
  pause: () => Promise<void>,
  accept: (fragment: Omit<CadenceFragment, "id" | "unit">) => void,
): Promise<void> {
  let from = 0,
    nonspace = 0,
    pending = false;
  const emit = (to: number, ending: CadenceFragment["ending"]) => {
    if (to <= from) return;
    accept({
      ...cadenceRange(tape, from, to),
      run,
      points: to - from,
      nonspace,
      ending,
    });
    from = to;
    nonspace = 0;
  };
  for (let index = 0; index < tape.chars.length; index++) {
    meter.take();
    if (index % 1024 === 0) await cadenceCheckpoint(signal, pause);
    const point = tape.chars[index]!,
      terminal = cadenceTerminal(tape.chars, index, policy);
    if (pending && !terminal && !cadenceAttaches(point, policy)) {
      emit(index, "terminal");
      pending = false;
    }
    if (!/\s/u.test(point)) nonspace++;
    if (terminal) pending = true;
  }
  emit(tape.chars.length, pending ? "terminal" : "boundary");
}

export type CadenceLengthSummary = {
  samples: number;
  empty: number;
  points: number;
  nonspace: number;
  minimum: number | null;
  maximum: number | null;
  median: number | null;
  q1: number | null;
  q3: number | null;
  p90: number | null;
  mean: { numerator: number; denominator: number } | null;
  short: number;
  long: number;
  terminal: number;
  boundary: number;
  buckets: { from: number; to: number | null; count: number }[];
};
const BUCKETS = [
  [0, 0],
  [1, 12],
  [13, 30],
  [31, 60],
  [61, 120],
  [121, 240],
  [241, null],
] as const;

/** Nearest-rank quantiles over nonempty samples; zeros are accounted separately, never silently dropped. */
export function summarizeCadenceLengths(
  fragments: readonly CadenceFragment[],
  policy: CadencePolicy,
): CadenceLengthSummary {
  const lengths: number[] = [],
    buckets = BUCKETS.map(([from, to]) => ({ from, to, count: 0 }));
  let points = 0,
    nonspace = 0,
    empty = 0,
    short = 0,
    long = 0,
    terminal = 0,
    boundary = 0;
  for (const fragment of fragments) {
    if (
      !Number.isSafeInteger(fragment.nonspace) ||
      fragment.nonspace < 0 ||
      fragment.nonspace > fragment.points
    )
      throw new Error("片段长度无效，未计算节奏分布。");
    points += fragment.points;
    nonspace += fragment.nonspace;
    if (fragment.nonspace === 0) empty++;
    else {
      lengths.push(fragment.nonspace);
      if (fragment.nonspace <= policy.short) short++;
      if (fragment.nonspace >= policy.long) long++;
    }
    if (fragment.ending === "terminal") terminal++;
    else boundary++;
    const bucket = buckets.find(
      (item) =>
        fragment.nonspace >= item.from &&
        (item.to === null || fragment.nonspace <= item.to),
    );
    if (!bucket) throw new Error("片段未归入固定分布区间。");
    bucket.count++;
  }
  lengths.sort((a, b) => a - b);
  const rank = (numerator: number, denominator: number): number | null =>
    lengths.length
      ? lengths[
          Math.max(0, Math.ceil((lengths.length * numerator) / denominator) - 1)
        ]!
      : null;
  return {
    samples: lengths.length,
    empty,
    points,
    nonspace,
    minimum: lengths[0] ?? null,
    maximum: lengths.at(-1) ?? null,
    median: rank(1, 2),
    q1: rank(1, 4),
    q3: rank(3, 4),
    p90: rank(9, 10),
    mean: lengths.length
      ? { numerator: nonspace, denominator: lengths.length }
      : null,
    short,
    long,
    terminal,
    boundary,
    buckets,
  };
}

export type CadenceRhythmRun = {
  unit: string;
  run: number;
  kind: "short" | "long";
  fragments: string[];
  start: number;
  end: number;
  nonspace: number;
};
/** Runs never bridge manuscripts, structural barriers, a whitespace-only fragment or an unclassified interval. */
export function groupCadenceRhythm(
  fragments: readonly CadenceFragment[],
  policy: CadencePolicy,
): CadenceRhythmRun[] {
  const result: CadenceRhythmRun[] = [];
  let current: CadenceRhythmRun | null = null;
  const finish = () => {
    if (current && current.fragments.length >= 3) result.push(current);
    current = null;
  };
  for (const fragment of fragments) {
    const kind =
      fragment.nonspace > 0 && fragment.nonspace <= policy.short
        ? "short"
        : fragment.nonspace >= policy.long
          ? "long"
          : null;
    if (!kind) {
      finish();
      continue;
    }
    if (
      !current ||
      current.unit !== fragment.unit ||
      current.run !== fragment.run ||
      current.kind !== kind ||
      current.end !== fragment.start
    ) {
      finish();
      current = {
        unit: fragment.unit,
        run: fragment.run,
        kind,
        fragments: [],
        start: fragment.start,
        end: fragment.start,
        nonspace: 0,
      };
    }
    current.fragments.push(fragment.id);
    current.end = fragment.end;
    current.nonspace += fragment.nonspace;
  }
  finish();
  return result;
}

export type CadenceDistributionComparison = {
  samples: { left: number; right: number };
  medianDifference: number | null;
  meanDifference: { numerator: number; denominator: number } | null;
  cdfGap: { numerator: number; denominator: number; at: number } | null;
  transport: { numerator: number; denominator: number } | null;
  buckets: {
    from: number;
    to: number | null;
    left: number;
    right: number;
    difference: { numerator: number; denominator: number } | null;
  }[];
};
/** Exact integer CDF/one-dimensional transport over observed nonempty lengths; never a manuscript-similarity score. */
export function compareCadenceDistributions(
  left: readonly CadenceFragment[],
  right: readonly CadenceFragment[],
  policy: CadencePolicy,
): CadenceDistributionComparison {
  const a = summarizeCadenceLengths(left, policy),
    b = summarizeCadenceLengths(right, policy),
    denominator = a.samples * b.samples;
  const frequency = new Map<number, { left: number; right: number }>();
  for (const [side, fragments] of [
    ["left", left],
    ["right", right],
  ] as const) {
    for (const fragment of fragments) {
      if (fragment.nonspace === 0) continue;
      const counts = frequency.get(fragment.nonspace) ?? { left: 0, right: 0 };
      counts[side]++;
      frequency.set(fragment.nonspace, counts);
    }
  }
  const positions = [...frequency.keys()].sort((x, y) => x - y);
  let seenLeft = 0,
    seenRight = 0,
    largest = 0,
    at = positions[0] ?? 0,
    area = 0,
    previous = at,
    previousGap = 0;
  for (const position of positions) {
    area += (position - previous) * previousGap;
    const counts = frequency.get(position)!;
    seenLeft += counts.left;
    seenRight += counts.right;
    const gap = Math.abs(seenLeft * b.samples - seenRight * a.samples);
    if (gap > largest) {
      largest = gap;
      at = position;
    }
    previousGap = gap;
    previous = position;
  }
  if (
    seenLeft !== a.samples ||
    seenRight !== b.samples ||
    !Number.isSafeInteger(area)
  )
    throw new Error("片段分布计数或精度不守恒，未显示比较分数。");
  return {
    samples: { left: a.samples, right: b.samples },
    medianDifference:
      a.median === null || b.median === null ? null : a.median - b.median,
    meanDifference: denominator
      ? {
          numerator: a.nonspace * b.samples - b.nonspace * a.samples,
          denominator,
        }
      : null,
    cdfGap: denominator ? { numerator: largest, denominator, at } : null,
    transport: denominator ? { numerator: area, denominator } : null,
    buckets: a.buckets.map((bucket, index) => {
      const other = b.buckets[index]!;
      // The zero bucket remains observable, but is not assigned a probability in the nonempty distribution.
      const comparable = denominator > 0 && bucket.from > 0;
      return {
        from: bucket.from,
        to: bucket.to,
        left: bucket.count,
        right: other.count,
        difference: comparable
          ? {
              numerator: bucket.count * b.samples - other.count * a.samples,
              denominator,
            }
          : null,
      };
    }),
  };
}
