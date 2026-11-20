import type { CollectionArtifact } from "./writing-collection-index.ts";
import type { ParallelAnalysis } from "./writing-parallel-model.ts";
import {
  prepareParallelReport,
  type ParallelRedactedReport,
  type ParallelReviewMark,
} from "./writing-parallel-review.ts";

export type PreparedParallelReport = CollectionArtifact & {
  report: ParallelRedactedReport;
  witness: string;
  pairsCount: number;
  asymmetriesCount: number;
  reviewedCount: number;
};

export function createParallelReportArtifact(
  analysis: ParallelAnalysis,
  marks: Record<string, ParallelReviewMark> = {},
  now = new Date(),
): PreparedParallelReport {
  const report = prepareParallelReport(analysis, marks);
  const text = JSON.stringify(report, null, 2) + "\n";
  const bytes = new TextEncoder().encode(text).byteLength;
  const dateStr = now.toISOString().slice(0, 10);
  const name = `no-wave-parallel-report-${dateStr}.json`;

  return Object.freeze({
    name,
    mime: "application/json;charset=utf-8",
    text,
    bytes,
    report,
    witness: analysis.witness,
    pairsCount: report.pairs.length,
    asymmetriesCount: report.findingsCount,
    reviewedCount: report.reviewedCount,
  });
}
