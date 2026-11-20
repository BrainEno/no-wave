import type {
  ParallelAnalysis,
  ParallelDocumentPair,
  ParallelFindingKind,
  ParallelPairProfile,
} from "./writing-parallel-model.ts";

export type ParallelProfileResult = {
  pairs: ParallelPairProfile[];
  globalAsymmetryCounts: Record<ParallelFindingKind, number>;
  totalAsymmetries: number;
  totalAlignments: number;
};

export function summarizePairProfile(
  pair: ParallelDocumentPair,
): ParallelPairProfile {
  let errorCount = 0;
  let warningCount = 0;
  const counts: Record<ParallelFindingKind, number> = {
    "missing-block": 0,
    "heading-level-drift": 0,
    "link-mismatch": 0,
    "link-parity-mismatch": 0,
    "image-mismatch": 0,
    "image-parity-mismatch": 0,
    "extreme-ratio": 0,
  };

  for (const asym of pair.asymmetries) {
    if (asym.severity === "error") errorCount++;
    else if (asym.severity === "warning") warningCount++;
    if (counts[asym.kind] !== undefined) {
      counts[asym.kind]++;
    }
  }

  return {
    pairId: pair.id,
    leftDocument: pair.leftDocument,
    rightDocument: pair.rightDocument,
    leftLocale: pair.leftLocale,
    rightLocale: pair.rightLocale,
    leftBlocks: pair.leftUnits.length,
    rightBlocks: pair.rightUnits.length,
    alignedBlocks: pair.metrics.alignedBlockCount,
    leftGaps: pair.metrics.leftGapCount,
    rightGaps: pair.metrics.rightGapCount,
    similarityIndex: pair.metrics.structuralSimilarityIndex,
    medianRatio: pair.metrics.medianRatio,
    asymmetriesCount: pair.asymmetries.length,
    asymmetryCounts: counts,
    errorCount,
    warningCount,
  };
}

export function parallelProfile(
  analysis: ParallelAnalysis,
): ParallelProfileResult {
  const pairs = analysis.pairs.map((p) => summarizePairProfile(p));
  const counts: Record<ParallelFindingKind, number> = {
    "missing-block": 0,
    "heading-level-drift": 0,
    "link-mismatch": 0,
    "link-parity-mismatch": 0,
    "image-mismatch": 0,
    "image-parity-mismatch": 0,
    "extreme-ratio": 0,
  };
  for (const f of analysis.findings) {
    if (counts[f.kind] !== undefined) {
      counts[f.kind]++;
    }
  }
  const totalAlignments = analysis.pairs.reduce(
    (sum, p) => sum + p.alignments.length,
    0,
  );
  return {
    pairs,
    globalAsymmetryCounts: counts,
    totalAsymmetries: analysis.findings.length,
    totalAlignments,
  };
}
