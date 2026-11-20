import {
  overlapActive,
  OVERLAP_LIMITS,
  OVERLAP_SHINGLE_WIDTH,
  type OverlapAnalysis,
} from "./writing-overlap-model.ts";
import { resolveOverlapPair } from "./writing-overlap-review.ts";

export type OverlapEvidenceTerm = {
  id: string;
  text: string;
  kind: "shared" | "left-only" | "right-only";
  left: number[];
  right: number[];
};
export type OverlapEvidenceSide = {
  text: string;
  points: number;
  offsets: number[];
  covered: number;
  spans: { start: number; end: number; shared: boolean }[];
};
export type OverlapEvidence = {
  sourceKey: string;
  finding: string;
  leftId: string;
  rightId: string;
  mode: OverlapAnalysis["policy"]["mode"];
  left: OverlapEvidenceSide;
  right: OverlapEvidenceSide;
  terms: OverlapEvidenceTerm[];
  intersection: number;
  union: number;
  basisPoints: number;
  countIntersection: number;
  countUnion: number;
  countBasisPoints: number;
  anchors: { term: string; left: number; right: number; inChain: boolean }[];
  chainLength: number;
};
type ScannedSide = {
  text: string;
  points: string[];
  offsets: number[];
  positions: Map<string, number[]>;
};
type Yield = () => Promise<void>;

/** All occurrence positions are retained: at most 4092 per side, regardless of repeated-template frequency. */
async function scanEvidenceText(
  text: string,
  signal: AbortSignal,
  pause: Yield,
): Promise<ScannedSide> {
  if (text.length > OVERLAP_LIMITS.nearCharacters * 2)
    throw new Error(
      "片段解释每侧最多 4096 个代码点；原文核对仍可分页，不截断生成解释。",
    );
  const points: string[] = [],
    offsets = [0];
  for (const point of text) {
    points.push(point);
    offsets.push(offsets.at(-1)! + point.length);
    if (points.length > OVERLAP_LIMITS.nearCharacters)
      throw new Error(
        "片段解释每侧最多 4096 个代码点；原文核对仍可分页，不截断生成解释。",
      );
  }
  const positions = new Map<string, number[]>();
  for (let start = 0; start + OVERLAP_SHINGLE_WIDTH <= points.length; start++) {
    if (start % 128 === 0) {
      overlapActive(signal);
      await pause();
      overlapActive(signal);
    }
    const text = points.slice(start, start + OVERLAP_SHINGLE_WIDTH).join("");
    const occurrences = positions.get(text) ?? [];
    occurrences.push(start);
    positions.set(text, occurrences);
  }
  return { text, points, offsets, positions };
}

/** Mark every point covered by any shared shingle, not just the first occurrence shown in a preview. */
function sharedCoverage(
  side: ScannedSide,
  other: ScannedSide,
): OverlapEvidenceSide {
  const covered = new Uint8Array(side.points.length);
  for (const [text, positions] of side.positions) {
    if (!other.positions.has(text)) continue;
    for (const start of positions)
      covered.fill(1, start, start + OVERLAP_SHINGLE_WIDTH);
  }
  const spans: OverlapEvidenceSide["spans"] = [];
  let start = 0,
    count = 0;
  for (let point = 0; point <= covered.length; point++) {
    if (point < covered.length) count += covered[point]!;
    if (point === covered.length || covered[point] !== covered[start]) {
      if (point > start)
        spans.push({ start, end: point, shared: covered[start] === 1 });
      start = point;
    }
  }
  return {
    text: side.text,
    points: side.points.length,
    offsets: side.offsets,
    covered: count,
    spans,
  };
}

/** One deterministic longest increasing chain; it is not an alignment, edit plan or proof that other fragments moved. */
async function uniqueAnchorChain(
  terms: readonly OverlapEvidenceTerm[],
  signal: AbortSignal,
  pause: Yield,
) {
  const anchors = terms
    .filter((term) => term.left.length === 1 && term.right.length === 1)
    .map((term) => ({
      term: term.id,
      left: term.left[0]!,
      right: term.right[0]!,
      inChain: false,
    }))
    .sort((a, b) => a.left - b.left || a.right - b.right);
  const tails: number[] = [],
    previous = new Int32Array(anchors.length).fill(-1);
  for (let index = 0; index < anchors.length; index++) {
    if (index % 128 === 0) {
      overlapActive(signal);
      await pause();
      overlapActive(signal);
    }
    const position = anchors[index]!.right;
    let low = 0,
      high = tails.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (anchors[tails[middle]!]!.right < position) low = middle + 1;
      else high = middle;
    }
    previous[index] = low ? tails[low - 1]! : -1;
    tails[low] = index;
  }
  let cursor = tails.at(-1) ?? -1,
    visited = 0;
  while (cursor !== -1) {
    if (++visited > anchors.length)
      throw new Error("唯一片段顺序链不完整，未展示猜测的锚点。");
    anchors[cursor]!.inChain = true;
    cursor = previous[cursor]!;
  }
  if (visited !== tails.length)
    throw new Error("唯一片段链数量不符，未展示部分结果。");
  return { anchors, chainLength: tails.length };
}

function sealEvidence(evidence: OverlapEvidence): OverlapEvidence {
  for (const side of [evidence.left, evidence.right]) {
    for (const span of side.spans) Object.freeze(span);
    Object.freeze(side.offsets);
    Object.freeze(side.spans);
    Object.freeze(side);
  }
  for (const term of evidence.terms) {
    Object.freeze(term.left);
    Object.freeze(term.right);
    Object.freeze(term);
  }
  for (const anchor of evidence.anchors) Object.freeze(anchor);
  Object.freeze(evidence.terms);
  Object.freeze(evidence.anchors);
  return Object.freeze(evidence);
}

/** This optional diagnostic recomputes a selected pair only. It never discovers more candidates or changes their status. */
export async function explainWritingOverlap(
  analysis: OverlapAnalysis,
  finding: string,
  left: string,
  right: string,
  signal: AbortSignal,
  pause: Yield = () => new Promise((resolve) => setTimeout(resolve, 0)),
): Promise<OverlapEvidence> {
  overlapActive(signal);
  const pair = resolveOverlapPair(analysis, finding, left, right);
  const a = await scanEvidenceText(pair.left.normalized, signal, pause);
  const b = await scanEvidenceText(pair.right.normalized, signal, pause);
  const texts = new Set([...a.positions.keys(), ...b.positions.keys()]);
  const terms: OverlapEvidenceTerm[] = [];
  let intersection = 0,
    countIntersection = 0,
    countUnion = 0;
  for (const text of texts) {
    if (terms.length % 128 === 0) {
      overlapActive(signal);
      await pause();
      overlapActive(signal);
    }
    const from = a.positions.get(text) ?? [],
      to = b.positions.get(text) ?? [];
    if (from.length && to.length) intersection++;
    countIntersection += Math.min(from.length, to.length);
    countUnion += Math.max(from.length, to.length);
    terms.push({
      id: `g${terms.length + 1}`,
      text,
      left: from,
      right: to,
      kind:
        from.length && to.length
          ? "shared"
          : from.length
            ? "left-only"
            : "right-only",
    });
  }
  const union = terms.length;
  if (!union || !countUnion)
    throw new Error("所选文字不足以解释五字符片段，没有输出空集合假分数。");
  const basisPoints = Math.floor((intersection * 10000) / union);
  const scored = analysis.near.find((item) => item.id === finding);
  if (
    scored &&
    (scored.intersection !== intersection ||
      scored.union !== union ||
      scored.basisPoints !== basisPoints)
  ) {
    throw new Error(
      "片段解释与原候选的完整评分不符，请重新分析；未以新分数覆盖旧结果。",
    );
  }
  const chain = await uniqueAnchorChain(terms, signal, pause);
  overlapActive(signal);
  return sealEvidence({
    sourceKey: analysis.sourceKey,
    finding,
    leftId: left,
    rightId: right,
    mode: analysis.policy.mode,
    left: sharedCoverage(a, b),
    right: sharedCoverage(b, a),
    terms,
    intersection,
    union,
    basisPoints,
    countIntersection,
    countUnion,
    countBasisPoints: Math.floor((countIntersection * 10000) / countUnion),
    ...chain,
  });
}
