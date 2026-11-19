import { collectionCanonicalJson } from "./writing-collection.ts";
import type { WritingNode } from "./writing-document.ts";
import {
  verifyWritingMergeOutput,
  writingMergeRootAttributes,
} from "./writing-merge-integrity.ts";
import {
  writingMergeResultReview,
  writingMergeReviewRows,
  type MergeReviewRow,
} from "./writing-merge-review.ts";
import {
  MERGE_ROLES,
  parseWritingMergeSource,
  type PreparedWritingMerge,
  type WritingMergeAnalysis,
  type WritingMergeChoice,
  type WritingMergeDecision,
  type WritingMergeField,
  type WritingMergeRole,
} from "./writing-merge.ts";

type Branch = Exclude<WritingMergeRole, "base">;
export type WritingMergeImpactItem = MergeReviewRow & {
  choice: WritingMergeChoice;
  unadopted: Branch[];
  override: boolean;
  baseConflict: boolean;
  empty: boolean;
  selectedBlocks: number | null;
};
type SourceRelation = {
  blocks: number;
  bodyEqual: boolean;
  rootEqual: boolean;
  fields: WritingMergeField[];
};
export type WritingMergeImpact = {
  items: WritingMergeImpactItem[];
  byUnit: Map<string, WritingMergeImpactItem>;
  sources: Record<WritingMergeRole, SourceRelation>;
  unadopted: Record<Branch, number>;
  overrides: number;
  baseConflicts: number;
  emptySelections: number;
  ambiguous: number;
};
export type WritingMergeImpactFilter =
  "all" | "conflicts" | "overrides" | "empty";
const BRANCHES: Branch[] = ["current", "incoming"];

/** No paragraph matching: compare each candidate as a whole and reconcile each complete source stream. */
export function reviewWritingMergeImpact(
  analysis: WritingMergeAnalysis,
  decisions: readonly WritingMergeDecision[],
  prepared: PreparedWritingMerge,
): WritingMergeImpact {
  writingMergeResultReview(analysis, decisions, prepared);
  const serialized = parseWritingMergeSource(prepared.text);
  if (
    collectionCanonicalJson(serialized) !==
    collectionCanonicalJson(prepared.backup)
  )
    throw new Error("取舍影响守恒检查失败：实际下载文本与结果预览不一致。");
  verifyWritingMergeOutput(analysis, decisions, serialized);
  const output = serialized.draft;
  const rows = writingMergeReviewRows(analysis, decisions, "all");
  const items: WritingMergeImpactItem[] = [];
  const unadopted = { current: 0, incoming: 0 };
  let overrides = 0,
    baseConflicts = 0,
    emptySelections = 0,
    ambiguous = 0;
  for (const row of rows) {
    const { unit, choice } = row;
    if (!choice) throw new Error("取舍影响仍有未解决项，不能展示完整核对。");
    const selected = collectionCanonicalJson(unit.values[choice]);
    const baseline = collectionCanonicalJson(unit.values.base);
    const rejected = BRANCHES.filter((role) => {
      const value = collectionCanonicalJson(unit.values[role]);
      return value !== baseline && value !== selected;
    });
    for (const role of rejected) unadopted[role]++;
    const override =
      row.manual && unit.recommended !== null && choice !== unit.recommended;
    const baseConflict = unit.status === "conflict" && choice === "base";
    const empty =
      unit.kind === "body" &&
      unit.values[choice].length === 0 &&
      MERGE_ROLES.some((role) => unit.values[role].length > 0);
    if (override) overrides++;
    if (baseConflict) baseConflicts++;
    if (empty) emptySelections++;
    if (unit.reason === "ambiguous-order") ambiguous++;
    if (rejected.length || override || empty)
      items.push({
        ...row,
        choice,
        unadopted: rejected,
        override,
        baseConflict,
        empty,
        selectedBlocks:
          unit.kind === "body" ? unit.values[choice].length : null,
      });
  }
  const sources = {} as Record<WritingMergeRole, SourceRelation>;
  const outputRoot = collectionCanonicalJson(
    writingMergeRootAttributes(serialized),
  );
  const outputBody = collectionCanonicalJson(output.editorState!.root.children);
  for (const role of MERGE_ROLES) {
    const blocks: WritingNode[] = [];
    const fields: WritingMergeField[] = [];
    let rootEqual = false;
    for (const unit of analysis.units) {
      if (unit.kind === "field") {
        if (unit.values[role] !== output[unit.field]) fields.push(unit.field);
      } else if (unit.kind === "root") {
        rootEqual = collectionCanonicalJson(unit.values[role]) === outputRoot;
      } else blocks.push(...unit.values[role]);
    }
    sources[role] = {
      blocks: blocks.length,
      bodyEqual: collectionCanonicalJson(blocks) === outputBody,
      rootEqual,
      fields,
    };
  }
  return {
    items,
    byUnit: new Map(items.map((item) => [item.unit.id, item])),
    sources,
    unadopted,
    overrides,
    baseConflicts,
    emptySelections,
    ambiguous,
  };
}

/** This view never edits decisions or mistakes a missing candidate for deleted prose. */
export function writingMergeImpactRows(
  report: WritingMergeImpact,
  filter: WritingMergeImpactFilter,
): WritingMergeImpactItem[] {
  if (!["all", "conflicts", "overrides", "empty"].includes(filter))
    throw new Error("取舍影响筛选无效。");
  return report.items.filter(
    (item) =>
      filter === "all" ||
      (filter === "conflicts" && item.unit.status === "conflict") ||
      (filter === "overrides" && item.override) ||
      (filter === "empty" && item.empty),
  );
}
