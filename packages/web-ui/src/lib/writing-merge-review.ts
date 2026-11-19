import {
  validateWritingMergeDecisions,
  writingMergeDecisionsKey,
  type PreparedWritingMerge,
  type WritingMergeAnalysis,
  type WritingMergeChoice,
  type WritingMergeDecision,
  type WritingMergeUnit,
} from "./writing-merge.ts";

export const MERGE_REVIEW_PAGE_SIZE = 12;
export type MergeReviewFilter =
  "changed" | "unresolved" | "conflicts" | "manual" | "all";
export type MergeReviewRow = {
  unit: WritingMergeUnit;
  choice: WritingMergeChoice | null;
  manual: boolean;
  unresolved: boolean;
};

/** Filtering is a view only: every witness check and output still uses all decisions. */
export function writingMergeReviewRows(
  analysis: WritingMergeAnalysis,
  decisions: readonly WritingMergeDecision[],
  filter: MergeReviewFilter,
): MergeReviewRow[] {
  if (!["changed", "unresolved", "conflicts", "manual", "all"].includes(filter))
    throw new Error("合并审阅筛选无效。");
  const choices = new Map(
    validateWritingMergeDecisions(analysis, decisions).map((item) => [
      item.unit,
      item.choice,
    ]),
  );
  return analysis.units.flatMap((unit) => {
    const manual = choices.has(unit.id);
    const choice = choices.get(unit.id) ?? unit.recommended;
    const unresolved = unit.status === "conflict" && !manual;
    const include =
      filter === "all" ||
      (filter === "changed" && (unit.status !== "same" || manual)) ||
      (filter === "unresolved" && unresolved) ||
      (filter === "conflicts" && unit.status === "conflict") ||
      (filter === "manual" && manual);
    return include ? [{ unit, choice, manual, unresolved }] : [];
  });
}

export function writingMergeReviewPage(
  rows: readonly MergeReviewRow[],
  requested: number,
) {
  if (!Number.isSafeInteger(requested) || requested < 0)
    throw new Error("合并审阅页码无效。");
  const pages = Math.max(1, Math.ceil(rows.length / MERGE_REVIEW_PAGE_SIZE));
  const page = Math.min(requested, pages - 1);
  const start = page * MERGE_REVIEW_PAGE_SIZE;
  return {
    page,
    pages,
    start,
    end: Math.min(rows.length, start + MERGE_REVIEW_PAGE_SIZE),
    rows: rows.slice(start, start + MERGE_REVIEW_PAGE_SIZE),
  };
}

/** Circular navigation uses document order, not the currently paginated/filtered DOM. */
export function writingMergeConflictTarget(
  analysis: WritingMergeAnalysis,
  decisions: readonly WritingMergeDecision[],
  from: string | null,
  direction: -1 | 1,
): string | null {
  if (direction !== -1 && direction !== 1)
    throw new Error("冲突定位方向无效。");
  const pending = new Set(
    writingMergeReviewRows(analysis, decisions, "unresolved").map(
      (row) => row.unit.id,
    ),
  );
  if (!pending.size) return null;
  const anchor =
    from === null
      ? direction === 1
        ? -1
        : 0
      : analysis.units.findIndex((unit) => unit.id === from);
  if (from !== null && anchor < 0) throw new Error("冲突定位起点已过期。");
  for (let step = 1; step <= analysis.units.length; step++) {
    const index =
      (anchor + direction * step + analysis.units.length) %
      analysis.units.length;
    const id = analysis.units[index]!.id;
    if (pending.has(id)) return id;
  }
  return null;
}

/** Plan review includes implicit resets, even when the resulting default happens to be unchanged. */
export function writingMergeDecisionChanges(
  analysis: WritingMergeAnalysis,
  before: readonly WritingMergeDecision[],
  after: readonly WritingMergeDecision[],
) {
  const left = new Map(
    validateWritingMergeDecisions(analysis, before).map((item) => [
      item.unit,
      item.choice,
    ]),
  );
  const right = new Map(
    validateWritingMergeDecisions(analysis, after).map((item) => [
      item.unit,
      item.choice,
    ]),
  );
  return analysis.units.flatMap((unit) => {
    const previous = left.get(unit.id) ?? null;
    const next = right.get(unit.id) ?? null;
    if (previous === next) return [];
    return [
      {
        unit,
        before: previous,
        after: next,
        beforeEffective: previous ?? unit.recommended,
        afterEffective: next ?? unit.recommended,
      },
    ];
  });
}

/** Provenance is local selection accounting, never a statement about authorship or server commits. */
export function writingMergeResultReview(
  analysis: WritingMergeAnalysis,
  decisions: readonly WritingMergeDecision[],
  prepared: PreparedWritingMerge,
) {
  if (
    prepared.analysisKey !== analysis.key ||
    prepared.decisionsKey !== writingMergeDecisionsKey(analysis, decisions)
  ) {
    throw new Error("结果审阅已过期，请重新准备当前人工取舍。");
  }
  const selected = new Map(
    validateWritingMergeDecisions(analysis, decisions).map((item) => [
      item.unit,
      item.choice,
    ]),
  );
  const from = { base: 0, current: 0, incoming: 0 };
  let removed = 0,
    added = 0,
    overridden = 0,
    ambiguous = 0,
    baseConflicts = 0;
  const fields: {
    field: string;
    choice: WritingMergeChoice;
    manual: boolean;
  }[] = [];
  for (const unit of analysis.units) {
    const choice = selected.get(unit.id) ?? unit.recommended;
    if (!choice) throw new Error("结果仍含未解决冲突，不能作为完整审阅。");
    const manual = selected.has(unit.id);
    if (manual && unit.recommended !== null && choice !== unit.recommended)
      overridden++;
    if (unit.status === "conflict" && choice === "base") baseConflicts++;
    if (unit.reason === "ambiguous-order") ambiguous++;
    if (unit.kind === "field")
      fields.push({ field: unit.field, choice, manual });
    if (unit.kind !== "body") continue;
    const count = unit.values[choice].length;
    from[choice] += count;
    removed += Math.max(0, unit.values.base.length - count);
    added += Math.max(0, count - unit.values.base.length);
  }
  const blockCount = prepared.backup.draft.editorState!.root.children.length;
  if (from.base + from.current + from.incoming !== blockCount)
    throw new Error("输出块数与本机取舍账目不符，不能展示成功审阅。");
  return {
    from,
    removed,
    added,
    overridden,
    ambiguous,
    baseConflicts,
    fields,
    blockCount,
  };
}
