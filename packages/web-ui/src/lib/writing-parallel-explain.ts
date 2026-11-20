import { parallelInventory } from "./writing-parallel-index.ts";
import type { ParallelAnalysis } from "./writing-parallel-model.ts";
import { ALIGNMENT_WEIGHTS } from "./writing-parallel-symbols.ts";

export type ParallelAlignmentExplanation = {
  alignmentId: string;
  pairId: string;
  type: string;
  score: number;
  confidence: number;
  anchors: string[];
  scoreComponents: {
    typeScore: number;
    anchorScore: number;
    ratioScore: number;
    gapPenalty: number;
  };
  summary: string;
  // UI rendering breakdown fields
  alignmentType: string;
  totalScore: number;
  leftKind: string | null;
  rightKind: string | null;
  leftHeadingLevel: number | null;
  rightHeadingLevel: number | null;
  leftCharCount: number;
  rightCharCount: number;
  lengthRatio: number;
  sameKind: boolean;
  breakdown: {
    kindScore: number;
    headingDrift: boolean;
    headingScore: number;
    ratioScore: number;
    numberScore: number;
    anchorScore: number;
  };
};

export function explainParallelAlignment(
  analysis: ParallelAnalysis,
  alignmentId: string,
): ParallelAlignmentExplanation {
  const inventory = parallelInventory(analysis);
  const alignment = inventory.alignments.get(alignmentId);
  if (!alignment) {
    throw new Error(`未找到对齐条目: ${alignmentId}`);
  }

  const left = alignment.leftId ? inventory.units.get(alignment.leftId) : null;
  const right = alignment.rightId
    ? inventory.units.get(alignment.rightId)
    : null;

  if (!left || !right) {
    const isLeftGap = Boolean(left && !right);
    return {
      alignmentId,
      pairId: alignment.pairId,
      type: alignment.type,
      score: alignment.score,
      confidence: 0,
      anchors: [],
      scoreComponents: {
        typeScore: 0,
        anchorScore: 0,
        ratioScore: 0,
        gapPenalty: ALIGNMENT_WEIGHTS.gapPenalty,
      },
      summary: isLeftGap
        ? `左侧单元（${left?.kind}）在右侧无匹配，计为左侧空缺。`
        : `右侧单元（${right?.kind}）在左侧无匹配，计为右侧空缺。`,
      alignmentType: alignment.type,
      totalScore: alignment.score,
      leftKind: left?.kind ?? null,
      rightKind: right?.kind ?? null,
      leftHeadingLevel: left?.headingLevel ?? null,
      rightHeadingLevel: right?.headingLevel ?? null,
      leftCharCount: left?.characterCount ?? 0,
      rightCharCount: right?.characterCount ?? 0,
      lengthRatio: 1,
      sameKind: false,
      breakdown: {
        kindScore: 0,
        headingDrift: false,
        headingScore: 0,
        ratioScore: 0,
        numberScore: 0,
        anchorScore: 0,
      },
    };
  }

  let typeScore = 0;
  if (left.kind === right.kind) {
    typeScore += ALIGNMENT_WEIGHTS.matchSameKind;
    if (left.kind === "heading") {
      if (left.headingLevel === right.headingLevel) {
        typeScore += ALIGNMENT_WEIGHTS.headingLevelMatch;
      } else {
        typeScore += ALIGNMENT_WEIGHTS.headingLevelDrift;
      }
    }
  } else {
    typeScore += ALIGNMENT_WEIGHTS.mismatchKind;
  }

  const leftAnchors = new Set(left.anchors);
  const sharedAnchors: string[] = [];
  for (const anchor of right.anchors) {
    if (leftAnchors.has(anchor)) sharedAnchors.push(anchor);
  }
  const anchorScore =
    sharedAnchors.length * ALIGNMENT_WEIGHTS.matchingAnchor;

  let ratioScore = 0;
  if (left.characterCount > 0 && right.characterCount > 0) {
    const ratio = Math.max(left.characterCount, right.characterCount) /
      Math.min(left.characterCount, right.characterCount);
    if (ratio <= 3.5) {
      ratioScore += ALIGNMENT_WEIGHTS.lengthRatioGood;
    } else {
      ratioScore += ALIGNMENT_WEIGHTS.lengthRatioExtreme;
    }
  }

  let summary = `两端均为 ${left.kind} 单元`;
  if (left.kind === "heading") {
    summary += `（左侧 h${left.headingLevel}，右侧 h${right.headingLevel}）`;
  }
  if (sharedAnchors.length > 0) {
    summary += `，匹配到 ${sharedAnchors.length} 个锚点词（${sharedAnchors.slice(0, 3).join(", ")}）`;
  }
  if (alignment.ratio !== null) {
    summary += `，长度比例 ${alignment.ratio}`;
  }

  return {
    alignmentId,
    pairId: alignment.pairId,
    type: alignment.type,
    score: alignment.score,
    confidence: alignment.confidence,
    anchors: sharedAnchors,
    scoreComponents: {
      typeScore,
      anchorScore,
      ratioScore,
      gapPenalty: 0,
    },
    summary,
    alignmentType: alignment.type,
    totalScore: alignment.score,
    leftKind: left.kind,
    rightKind: right.kind,
    leftHeadingLevel: left.headingLevel ?? null,
    rightHeadingLevel: right.headingLevel ?? null,
    leftCharCount: left.characterCount,
    rightCharCount: right.characterCount,
    lengthRatio: alignment.ratio ?? 1,
    sameKind: left.kind === right.kind,
    breakdown: {
      kindScore: typeScore,
      headingDrift:
        left.kind === "heading" &&
        right.kind === "heading" &&
        left.headingLevel !== right.headingLevel,
      headingScore:
        left.kind === "heading" && right.kind === "heading"
          ? left.headingLevel === right.headingLevel
            ? ALIGNMENT_WEIGHTS.headingLevelMatch
            : ALIGNMENT_WEIGHTS.headingLevelDrift
          : 0,
      ratioScore,
      numberScore: anchorScore,
      anchorScore: 0,
    },
  };
}
