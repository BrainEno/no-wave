import { parallelInventory } from "./writing-parallel-index.ts";
import {
  computeFastHash,
  type ParallelAlignment,
  type ParallelAnalysis,
  type ParallelAsymmetry,
  type ParallelUnit,
} from "./writing-parallel-model.ts";

export type ParallelReviewMark = "intentional" | "check-later";

export type ParallelReviewFilter = {
  kind: "all" | "aligned" | "gap" | "asymmetry";
  status: "all" | "unreviewed" | "intentional" | "check-later";
};

export const DEFAULT_PARALLEL_FILTERS: ParallelReviewFilter = Object.freeze({
  kind: "all",
  status: "all",
});

export type ParallelReviewRow = {
  id: string;
  rowId: string;
  pairId: string;
  type: string;
  alignmentIndex: number;
  score: number;
  leftUnit: ParallelUnit | null;
  rightUnit: ParallelUnit | null;
  alignment: ParallelAlignment | null;
  asymmetry: ParallelAsymmetry | null;
  findings: ParallelAsymmetry[];
  ratio: number | null;
  status: ParallelReviewMark | "unreviewed";
  mark: ParallelReviewMark | "unreviewed";
};

export function parallelReviewRows(
  analysis: ParallelAnalysis,
  pairId: string = "all",
  filters: ParallelReviewFilter = DEFAULT_PARALLEL_FILTERS,
  marks: Record<string, ParallelReviewMark> = {},
): ParallelReviewRow[] {
  const inventory = parallelInventory(analysis);
  const rows: ParallelReviewRow[] = [];

  const targetPairs =
    pairId === "all"
      ? analysis.pairs
      : analysis.pairs.filter((p) => p.id === pairId);

  for (const pair of targetPairs) {
    let index = 0;
    for (const align of pair.alignments) {
      const alignmentIndex = index++;
      const left = align.leftId ? inventory.units.get(align.leftId) ?? null : null;
      const right = align.rightId
        ? inventory.units.get(align.rightId) ?? null
        : null;

      const isGap = align.type === "left-gap" || align.type === "right-gap";
      if (filters.kind === "aligned" && isGap) continue;
      if (filters.kind === "gap" && !isGap) continue;

      const asym =
        pair.asymmetries.find(
          (a) =>
            (align.leftId && a.leftId === align.leftId) ||
            (align.rightId && a.rightId === align.rightId),
        ) ?? null;

      if (filters.kind === "asymmetry" && !asym) continue;

      const status = marks[align.id] ?? "unreviewed";
      if (filters.status !== "all" && status !== filters.status) continue;

      rows.push({
        id: align.id,
        rowId: align.id,
        pairId: pair.id,
        type: align.type,
        alignmentIndex,
        score: align.score,
        leftUnit: left,
        rightUnit: right,
        alignment: align,
        asymmetry: asym,
        findings: asym ? [asym] : [],
        ratio: align.ratio,
        status,
        mark: status,
      });
    }
  }

  return rows;
}

export function parallelRows(
  analysis: ParallelAnalysis,
  filters: {
    pairId?: string;
    type?: string;
    findingKind?: string;
    markState?: string;
  } = {},
  marks: Record<string, ParallelReviewMark> = {},
): ParallelReviewRow[] {
  const kindFilter: ParallelReviewFilter["kind"] =
    filters.type === "left-gap" || filters.type === "right-gap"
      ? "gap"
      : filters.type === "strong-align" || filters.type === "partial-align"
        ? "aligned"
        : filters.findingKind && filters.findingKind !== "all"
          ? "asymmetry"
          : "all";

  const statusFilter: ParallelReviewFilter["status"] =
    filters.markState === "intentional" || filters.markState === "check-later"
      ? filters.markState
      : "all";

  const allRows = parallelReviewRows(
    analysis,
    filters.pairId ?? "all",
    { kind: kindFilter, status: statusFilter },
    marks,
  );

  return allRows.filter((r) => {
    if (filters.type && filters.type !== "all" && r.type !== filters.type) return false;
    if (
      filters.findingKind &&
      filters.findingKind !== "all" &&
      !r.findings.some((f) => f.kind === filters.findingKind)
    )
      return false;
    if (filters.markState && filters.markState !== "all" && r.mark !== filters.markState)
      return false;
    return true;
  });
}

export function parallelTextSlice(
  text: string,
  offset: number = 0,
  limit: number = 2048,
): { text: string; start: number; end: number; hasMore: boolean } {
  const safeOffset = Math.max(0, Math.min(text.length, offset));
  let safeEnd = Math.min(text.length, safeOffset + limit);

  // Avoid slicing middle of surrogate pair
  if (
    safeEnd < text.length &&
    text.charCodeAt(safeEnd - 1) >= 0xd800 &&
    text.charCodeAt(safeEnd - 1) <= 0xdbff
  ) {
    safeEnd--;
  }

  const sliced = text.slice(safeOffset, safeEnd);
  return {
    text: sliced,
    start: safeOffset,
    end: safeEnd,
    hasMore: safeEnd < text.length,
  };
}

export function validateParallelMarks(
  analysis: ParallelAnalysis,
  marks: Record<string, ParallelReviewMark>,
): void {
  const inventory = parallelInventory(analysis);
  for (const [id, value] of Object.entries(marks)) {
    if (!inventory.alignments.has(id)) {
      throw new Error(`Invalid mark ID: ${id} does not exist in analysis.`);
    }
    if (value !== "intentional" && value !== "check-later") {
      throw new Error(`Invalid mark value: ${value}`);
    }
  }
}

export type ParallelRedactedReport = {
  format: "no-wave-writing-parallel-report-v1";
  witness: string;
  timestamp: string;
  checksum: string;
  pairs: {
    pairId: string;
    leftDocument: string;
    rightDocument: string;
    leftBlocks: number;
    rightBlocks: number;
    alignedBlocks: number;
    leftGaps: number;
    rightGaps: number;
    similarityIndex: number;
    medianRatio: number;
    asymmetriesCount: number;
  }[];
  findingsCount: number;
  reviewedCount: number;
};

export function prepareParallelReport(
  analysis: ParallelAnalysis,
  marks: Record<string, ParallelReviewMark> = {},
): ParallelRedactedReport {
  validateParallelMarks(analysis, marks);

  const pairs = analysis.summaries.map((s) => ({
    pairId: s.pairId,
    leftDocument: s.leftDocument,
    rightDocument: s.rightDocument,
    leftBlocks: s.leftBlocks,
    rightBlocks: s.rightBlocks,
    alignedBlocks: s.alignedBlocks,
    leftGaps: s.leftGaps,
    rightGaps: s.rightGaps,
    similarityIndex: s.similarityIndex,
    medianRatio: s.medianRatio,
    asymmetriesCount: s.asymmetriesCount,
  }));

  const payload = JSON.stringify({ pairs, witness: analysis.witness });
  const checksum = computeFastHash(payload);

  const report: ParallelRedactedReport = {
    format: "no-wave-writing-parallel-report-v1",
    witness: analysis.witness,
    timestamp: analysis.timestamp,
    checksum,
    pairs,
    findingsCount: analysis.findings.length,
    reviewedCount: Object.keys(marks).length,
  };

  const fullJson = JSON.stringify(report, null, 2);
  if (new TextEncoder().encode(fullJson).byteLength > 2 * 1024 * 1024) {
    throw new Error("Report exceeds maximum 2 MiB size limit.");
  }

  return report;
}
