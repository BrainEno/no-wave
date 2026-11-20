import type { ParallelAlignment } from "./writing-parallel-model.ts";

export type RatioStatistics = {
  count: number;
  median: number;
  mean: number;
  variance: number;
  standardDeviation: number;
  mad: number; // Median Absolute Deviation
  min: number;
  max: number;
  q1: number;
  q3: number;
  iqr: number;
  lowerInnerFence: number;
  upperInnerFence: number;
  lowerOuterFence: number;
  upperOuterFence: number;
};

export type RatioOutlierKind = "normal" | "mild-outlier" | "extreme-outlier";

export function calculateRatioStatistics(
  alignments: ParallelAlignment[],
): RatioStatistics {
  const ratios: number[] = [];
  for (const align of alignments) {
    if (align.ratio !== null && Number.isFinite(align.ratio) && align.ratio > 0) {
      ratios.push(align.ratio);
    }
  }

  if (ratios.length === 0) {
    return {
      count: 0,
      median: 1.0,
      mean: 1.0,
      variance: 0.0,
      standardDeviation: 0.0,
      mad: 0.0,
      min: 1.0,
      max: 1.0,
      q1: 1.0,
      q3: 1.0,
      iqr: 0.0,
      lowerInnerFence: 1.0,
      upperInnerFence: 1.0,
      lowerOuterFence: 1.0,
      upperOuterFence: 1.0,
    };
  }

  ratios.sort((a, b) => a - b);
  const n = ratios.length;

  const median =
    n % 2 === 1
      ? ratios[Math.floor(n / 2)]!
      : (ratios[n / 2 - 1]! + ratios[n / 2]!) / 2;

  const q1 = ratios[Math.floor(n * 0.25)]!;
  const q3 = ratios[Math.floor(n * 0.75)]!;
  const iqr = q3 - q1;
  const mean = ratios.reduce((sum, r) => sum + r, 0) / n;

  let sumSquaredDiff = 0;
  for (const r of ratios) {
    const diff = r - mean;
    sumSquaredDiff += diff * diff;
  }
  const variance = sumSquaredDiff / n;
  const standardDeviation = Math.sqrt(variance);

  // Compute Median Absolute Deviation (MAD)
  const absoluteDeviations: number[] = [];
  for (const r of ratios) {
    absoluteDeviations.push(Math.abs(r - median));
  }
  absoluteDeviations.sort((a, b) => a - b);
  const mad =
    n % 2 === 1
      ? absoluteDeviations[Math.floor(n / 2)]!
      : (absoluteDeviations[n / 2 - 1]! + absoluteDeviations[n / 2]!) / 2;

  const lowerInnerFence = Math.max(0.01, q1 - 1.5 * iqr);
  const upperInnerFence = q3 + 1.5 * iqr;
  const lowerOuterFence = Math.max(0.01, q1 - 3.0 * iqr);
  const upperOuterFence = q3 + 3.0 * iqr;

  return {
    count: n,
    median: Math.round(median * 100) / 100,
    mean: Math.round(mean * 100) / 100,
    variance: Math.round(variance * 1000) / 1000,
    standardDeviation: Math.round(standardDeviation * 100) / 100,
    mad: Math.round(mad * 100) / 100,
    min: Math.round(ratios[0]! * 100) / 100,
    max: Math.round(ratios[n - 1]! * 100) / 100,
    q1: Math.round(q1 * 100) / 100,
    q3: Math.round(q3 * 100) / 100,
    iqr: Math.round(iqr * 100) / 100,
    lowerInnerFence: Math.round(lowerInnerFence * 100) / 100,
    upperInnerFence: Math.round(upperInnerFence * 100) / 100,
    lowerOuterFence: Math.round(lowerOuterFence * 100) / 100,
    upperOuterFence: Math.round(upperOuterFence * 100) / 100,
  };
}

export function classifyRatioOutlier(
  ratio: number,
  stats: RatioStatistics,
): RatioOutlierKind {
  if (ratio < stats.lowerOuterFence || ratio > stats.upperOuterFence) {
    return "extreme-outlier";
  }
  if (ratio < stats.lowerInnerFence || ratio > stats.upperInnerFence) {
    return "mild-outlier";
  }
  return "normal";
}

export type SectionDriftSample = {
  sectionIndex: number;
  sectionHeading: string;
  alignmentCount: number;
  averageRatio: number;
  driftFromGlobalMedian: number;
};

export function analyzeSectionRatioDrift(
  alignments: ParallelAlignment[],
  stats: RatioStatistics,
): SectionDriftSample[] {
  const sections: SectionDriftSample[] = [];
  let currentHeading = "Preamble";
  let sectionIndex = 0;
  let currentSectionAlignments: number[] = [];

  for (const align of alignments) {
    if (align.type === "strong-align" || align.type === "partial-align") {
      if (align.ratio !== null) {
        currentSectionAlignments.push(align.ratio);
      }
    }
  }

  if (currentSectionAlignments.length > 0) {
    const avg =
      currentSectionAlignments.reduce((sum, r) => sum + r, 0) /
      currentSectionAlignments.length;
    sections.push({
      sectionIndex,
      sectionHeading: currentHeading,
      alignmentCount: currentSectionAlignments.length,
      averageRatio: Math.round(avg * 100) / 100,
      driftFromGlobalMedian: Math.round(Math.abs(avg - stats.median) * 100) / 100,
    });
  }

  return sections;
}
