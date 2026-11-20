import type { OpenedCollection } from "./writing-collection.ts";
import { alignDocumentPair } from "./writing-parallel-align.ts";
import { detectAsymmetries } from "./writing-parallel-asymmetry.ts";
import { sealParallelAnalysis } from "./writing-parallel-index.ts";
import {
  computeFastHash,
  DEFAULT_PARALLEL_POLICY,
  type ParallelAnalysis,
  type ParallelAsymmetry,
  type ParallelDocumentPair,
  type ParallelOptions,
  type ParallelPairMetrics,
  type ParallelPairProfile,
  type ParallelPolicy,
  type ParallelUnit,
} from "./writing-parallel-model.ts";
import { summarizePairProfile } from "./writing-parallel-profile.ts";
import { calculateRatioStatistics } from "./writing-parallel-ratios.ts";
import { prepareParallelSource } from "./writing-parallel-source.ts";
import {
  parallelBudgets,
  ParallelMeter,
  validateParallelPolicy,
} from "./writing-parallel-symbols.ts";

export async function analyzeWritingParallel(
  opened: OpenedCollection,
  rawPolicy: ParallelPolicy = DEFAULT_PARALLEL_POLICY,
  signal = new AbortController().signal,
  options: ParallelOptions = {},
): Promise<ParallelAnalysis> {
  if (signal.aborted) {
    throw new Error("Parallel analysis was aborted.");
  }

  const policy = validateParallelPolicy(rawPolicy);
  const budgets = parallelBudgets(options.budgets);

  const pause =
    options.pause ?? (() => new Promise((resolve) => setTimeout(resolve, 0)));
  const progress = options.progress ?? (() => {});

  const meter = new ParallelMeter(budgets, pause, progress);

  const source = await prepareParallelSource(opened, policy, budgets);

  const unitsById = new Map<string, ParallelUnit>();
  for (const unit of source.units) {
    unitsById.set(unit.id, unit);
  }

  const analyzedPairs: ParallelDocumentPair[] = [];
  const allFindings: ParallelAsymmetry[] = [];
  const summaries: ParallelPairProfile[] = [];

  for (const pairRef of source.pairsToAnalyze) {
    if (signal.aborted) {
      throw new Error("Parallel analysis was aborted.");
    }

    const pairId = `${pairRef.left}:${pairRef.right}`;
    const leftUnits = source.byDocument.get(pairRef.left) ?? [];
    const rightUnits = source.byDocument.get(pairRef.right) ?? [];

    const alignmentResult = await alignDocumentPair(
      pairId,
      leftUnits,
      rightUnits,
      policy,
      budgets,
      meter,
    );

    const ratioStats = calculateRatioStatistics(alignmentResult.alignments);

    const asymmetries = detectAsymmetries(
      pairId,
      alignmentResult.alignments,
      unitsById,
      policy,
      ratioStats.median,
      meter,
    );

    const alignedBlockCount = alignmentResult.alignments.filter(
      (a) => a.leftId && a.rightId,
    ).length;
    const leftGapCount = alignmentResult.alignments.filter(
      (a) => a.leftId && !a.rightId,
    ).length;
    const rightGapCount = alignmentResult.alignments.filter(
      (a) => !a.leftId && a.rightId,
    ).length;

    let linkCountLeft = 0;
    let imageCountLeft = 0;
    for (const u of leftUnits) {
      linkCountLeft += u.links.length;
      imageCountLeft += u.images.length;
    }

    let linkCountRight = 0;
    let imageCountRight = 0;
    for (const u of rightUnits) {
      linkCountRight += u.links.length;
      imageCountRight += u.images.length;
    }

    const metrics: ParallelPairMetrics = {
      leftBlockCount: leftUnits.length,
      rightBlockCount: rightUnits.length,
      alignedBlockCount,
      leftGapCount,
      rightGapCount,
      structuralSimilarityIndex: alignmentResult.similarityIndex,
      medianRatio: ratioStats.median,
      linkCountLeft,
      linkCountRight,
      imageCountLeft,
      imageCountRight,
    };

    const docPair: ParallelDocumentPair = {
      id: pairId,
      leftDocument: pairRef.left,
      rightDocument: pairRef.right,
      leftLocale: source.documentLocales.get(pairRef.left) ?? "und",
      rightLocale: source.documentLocales.get(pairRef.right) ?? "und",
      leftUnits,
      rightUnits,
      alignments: alignmentResult.alignments,
      asymmetries,
      metrics,
    };

    analyzedPairs.push(docPair);
    allFindings.push(...asymmetries);
    summaries.push(summarizePairProfile(docPair));
  }

  // Deterministic witness token
  const witnessPayload = JSON.stringify({
    collection: opened.prepared.collection.digest,
    pairs: analyzedPairs.map((p) => ({
      id: p.id,
      alignments: p.alignments.length,
      asymmetries: p.asymmetries.length,
      similarity: p.metrics.structuralSimilarityIndex,
    })),
  });
  const witness = computeFastHash(witnessPayload);
  const timestamp = new Date().toISOString();

  const analysis: ParallelAnalysis = {
    pairs: analyzedPairs,
    summaries,
    findings: allFindings,
    units: source.units,
    witness,
    timestamp,
  };

  return sealParallelAnalysis(analysis);
}
