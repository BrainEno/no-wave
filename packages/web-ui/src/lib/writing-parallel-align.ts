import type {
  ParallelAlignment,
  ParallelAlignmentType,
  ParallelBudgets,
  ParallelPolicy,
  ParallelUnit,
} from "./writing-parallel-model.ts";
import { ALIGNMENT_WEIGHTS, ParallelMeter } from "./writing-parallel-symbols.ts";

export type AlignmentResult = {
  alignments: ParallelAlignment[];
  score: number;
  similarityIndex: number;
};

export function computeCharacterDiceCoefficient(a: string, b: string): number {
  if (a === b) return 1.0;
  if (a.length < 2 || b.length < 2) return 0.0;
  const bigramsA = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const bg = a.slice(i, i + 2);
    bigramsA.set(bg, (bigramsA.get(bg) ?? 0) + 1);
  }
  let intersection = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bg = b.slice(i, i + 2);
    const count = bigramsA.get(bg) ?? 0;
    if (count > 0) {
      intersection++;
      bigramsA.set(bg, count - 1);
    }
  }
  const total = a.length - 1 + (b.length - 1);
  return total > 0 ? (2 * intersection) / total : 0.0;
}

export function verifyAlignmentMonotonicity(
  alignments: ParallelAlignment[],
  leftUnits: ParallelUnit[],
  rightUnits: ParallelUnit[],
): void {
  const leftPosMap = new Map(leftUnits.map((u, i) => [u.id, i]));
  const rightPosMap = new Map(rightUnits.map((u, i) => [u.id, i]));
  let lastLeft = -1;
  let lastRight = -1;
  for (const align of alignments) {
    if (align.leftId) {
      const pos = leftPosMap.get(align.leftId);
      if (pos === undefined || pos < lastLeft) {
        throw new Error("对齐单调性错误：左侧单元序列发生倒退。");
      }
      lastLeft = pos;
    }
    if (align.rightId) {
      const pos = rightPosMap.get(align.rightId);
      if (pos === undefined || pos < lastRight) {
        throw new Error("对齐单调性错误：右侧单元序列发生倒退。");
      }
      lastRight = pos;
    }
  }
}

export function scoreUnitPair(
  left: ParallelUnit,
  right: ParallelUnit,
  policy: ParallelPolicy,
): number {
  let score = 0;

  // Kind compatibility
  if (left.kind === right.kind) {
    score += ALIGNMENT_WEIGHTS.matchSameKind;
    if (left.kind === "heading") {
      if (left.headingLevel === right.headingLevel) {
        score += ALIGNMENT_WEIGHTS.headingLevelMatch;
      } else {
        score += ALIGNMENT_WEIGHTS.headingLevelDrift;
      }
    }
  } else {
    score += ALIGNMENT_WEIGHTS.mismatchKind;
  }

  // Anchor tokens (numbers, urls, etc.)
  const leftAnchors = new Set(left.anchors);
  let sharedAnchors = 0;
  for (const anchor of right.anchors) {
    if (leftAnchors.has(anchor)) sharedAnchors++;
  }
  score += sharedAnchors * ALIGNMENT_WEIGHTS.matchingAnchor;

  // Images
  if (left.kind === "image" && right.kind === "image") {
    const leftImg = left.images[0];
    const rightImg = right.images[0];
    if (leftImg && rightImg && leftImg === rightImg) {
      score += 30;
    }
  }

  // Length ratio compatibility
  if (left.characterCount > 0 && right.characterCount > 0) {
    const ratio =
      Math.max(left.characterCount, right.characterCount) /
      Math.min(left.characterCount, right.characterCount);
    // Headings have naturally wider character-ratio variance between CJK and Latin
    const threshold =
      left.kind === "heading" ? policy.ratioThreshold * 1.5 : policy.ratioThreshold;
    if (ratio <= threshold) {
      score += ALIGNMENT_WEIGHTS.lengthRatioGood;
    } else {
      score += ALIGNMENT_WEIGHTS.lengthRatioExtreme;
    }
  }

  return score;
}

export async function alignDocumentPair(
  pairId: string,
  leftUnits: ParallelUnit[],
  rightUnits: ParallelUnit[],
  policy: ParallelPolicy,
  budgets: ParallelBudgets,
  meter: ParallelMeter,
): Promise<AlignmentResult> {
  const n = leftUnits.length;
  const m = rightUnits.length;

  if (n === 0 && m === 0) {
    return { alignments: [], score: 0, similarityIndex: 1.0 };
  }

  if (n * m > budgets.matrixCells) {
    throw new Error(
      `对齐网格单元数量 (${n * m}) 超过上限 (${budgets.matrixCells})，已整轮拒绝。`,
    );
  }

  const gapPenalty = ALIGNMENT_WEIGHTS.gapPenalty;

  // DP table: (n + 1) x (m + 1)
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );

  for (let i = 1; i <= n; i++) dp[i]![0] = i * gapPenalty;
  for (let j = 1; j <= m; j++) dp[0]![j] = j * gapPenalty;

  for (let i = 1; i <= n; i++) {
    const leftUnit = leftUnits[i - 1]!;
    for (let j = 1; j <= m; j++) {
      await meter.step();
      const rightUnit = rightUnits[j - 1]!;
      const matchScore = scoreUnitPair(leftUnit, rightUnit, policy);

      const diag = dp[i - 1]![j - 1]! + matchScore;
      const up = dp[i - 1]![j]! + gapPenalty;
      const left = dp[i]![j - 1]! + gapPenalty;

      dp[i]![j] = Math.max(diag, up, left);
    }
  }

  // Traceback
  let i = n;
  let j = m;
  const rawAlignments: {
    leftIndex: number | null;
    rightIndex: number | null;
    score: number;
  }[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const leftUnit = leftUnits[i - 1]!;
      const rightUnit = rightUnits[j - 1]!;
      const matchScore = scoreUnitPair(leftUnit, rightUnit, policy);
      if (dp[i]![j] === dp[i - 1]![j - 1]! + matchScore) {
        rawAlignments.push({
          leftIndex: i - 1,
          rightIndex: j - 1,
          score: matchScore,
        });
        i--;
        j--;
        continue;
      }
    }
    if (i > 0 && dp[i]![j] === dp[i - 1]![j]! + gapPenalty) {
      rawAlignments.push({
        leftIndex: i - 1,
        rightIndex: null,
        score: gapPenalty,
      });
      i--;
      continue;
    }
    if (j > 0) {
      rawAlignments.push({
        leftIndex: null,
        rightIndex: j - 1,
        score: gapPenalty,
      });
      j--;
      continue;
    }
    break;
  }

  rawAlignments.reverse();

  const alignments: ParallelAlignment[] = rawAlignments.map((item, idx) => {
    const left = item.leftIndex !== null ? leftUnits[item.leftIndex] : null;
    const right = item.rightIndex !== null ? rightUnits[item.rightIndex] : null;

    let type: ParallelAlignmentType;
    let ratio: number | null = null;

    if (left && right) {
      if (left.characterCount > 0 && right.characterCount > 0) {
        ratio =
          Math.round(
            (left.characterCount / right.characterCount) * 100,
          ) / 100;
      }
      if (item.score >= 40) type = "exact-match";
      else if (item.score >= 15) type = "strong-align";
      else if (item.score > 0) type = "partial-align";
      else type = "mismatch";
    } else if (left) {
      type = "left-gap";
    } else {
      type = "right-gap";
    }

    const confidence =
      type === "exact-match"
        ? 1.0
        : type === "strong-align"
          ? 0.85
          : type === "partial-align"
            ? 0.65
            : type === "mismatch"
              ? 0.2
              : 0.0;

    return {
      id: `${pairId}:a${idx}`,
      pairId,
      leftId: left?.id ?? null,
      rightId: right?.id ?? null,
      type,
      score: item.score,
      confidence,
      ratio,
    };
  });

  // Conservation check
  const alignedCount = alignments.filter((a) => a.leftId && a.rightId).length;
  const leftGaps = alignments.filter((a) => a.leftId && !a.rightId).length;
  const rightGaps = alignments.filter((a) => !a.leftId && a.rightId).length;

  if (alignedCount + leftGaps !== n || alignedCount + rightGaps !== m) {
    throw new Error("对齐算法守恒性检验失败：匹配与间隙总数不等于输入单元总数。");
  }

  // Monotonicity check
  verifyAlignmentMonotonicity(alignments, leftUnits, rightUnits);

  // Compute maximum possible base score for the smaller document
  const maxPossibleScore = Math.max(1, Math.min(n, m) * 40);
  const similarityIndex = Math.max(
    0,
    Math.min(1, Math.round((dp[n]![m]! / maxPossibleScore) * 100) / 100),
  );

  return {
    alignments,
    score: dp[n]![m]!,
    similarityIndex,
  };
}
