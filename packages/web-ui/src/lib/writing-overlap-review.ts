import { writingTextDifference } from "./writing-compare.ts";
import { paginate } from "./work-types.ts";
import {
  overlapFamily,
  overlapFindings,
  overlapUnit,
  type OverlapAnalysis,
  type OverlapFamily,
  type OverlapFinding,
  type OverlapUnit,
} from "./writing-overlap-model.ts";

export type OverlapMark = {
  finding: string;
  verdict: "follow-up" | "intentional";
};
export type OverlapFilter = {
  kind: "all" | "exact" | "near";
  status: "all" | "unreviewed" | OverlapMark["verdict"];
  document: string;
};
export const DEFAULT_OVERLAP_FILTER: OverlapFilter = {
  kind: "all",
  status: "all",
  document: "all",
};
export type OverlapReviewRow = {
  finding: OverlapFinding;
  verdict: OverlapMark["verdict"] | null;
  occurrences: number;
  documents: number;
};

/** Manual annotations describe review, never authorize a manuscript edit or inferred deletion. */
export function validateOverlapMarks(
  analysis: OverlapAnalysis,
  marks: readonly OverlapMark[],
): OverlapMark[] {
  const findings = overlapFindings(analysis),
    allowed = new Set(findings.map((item) => item.id));
  if (!Array.isArray(marks) || marks.length > findings.length)
    throw new Error("审阅标记数量无效，没有应用部分选择。");
  const chosen = new Map<string, OverlapMark["verdict"]>();
  for (const mark of marks) {
    if (
      !mark ||
      Object.keys(mark).sort().join(",") !== "finding,verdict" ||
      !allowed.has(mark.finding) ||
      chosen.has(mark.finding) ||
      !["follow-up", "intentional"].includes(mark.verdict)
    ) {
      throw new Error("审阅标记含未知、重复或已失效的项目，没有应用部分选择。");
    }
    chosen.set(mark.finding, mark.verdict);
  }
  return findings.flatMap((item) =>
    chosen.has(item.id)
      ? [{ finding: item.id, verdict: chosen.get(item.id)! }]
      : [],
  );
}

export function overlapMarksKey(
  analysis: OverlapAnalysis,
  marks: readonly OverlapMark[],
): string {
  return JSON.stringify(
    validateOverlapMarks(analysis, marks).map((mark) => [
      mark.finding,
      mark.verdict,
    ]),
  );
}

function findingFamilies(
  analysis: OverlapAnalysis,
  finding: OverlapFinding,
): [OverlapFamily, OverlapFamily | null] {
  return finding.kind === "exact"
    ? [overlapFamily(analysis, finding.family), null]
    : [
        overlapFamily(analysis, finding.left),
        overlapFamily(analysis, finding.right),
      ];
}
function findingAt(analysis: OverlapAnalysis, id: string): OverlapFinding {
  const finding = overlapFindings(analysis).find((item) => item.id === id);
  if (!finding) throw new Error("审阅条目已经变化，请从当前结果重新打开。");
  return finding;
}

export function overlapReviewRows(
  analysis: OverlapAnalysis,
  marks: readonly OverlapMark[],
  filter: OverlapFilter,
): OverlapReviewRow[] {
  if (
    !filter ||
    Object.keys(filter).sort().join(",") !== "document,kind,status" ||
    !["all", "exact", "near"].includes(filter.kind) ||
    !["all", "unreviewed", "follow-up", "intentional"].includes(
      filter.status,
    ) ||
    (filter.document !== "all" &&
      !analysis.units.some((unit) => unit.document === filter.document))
  )
    throw new Error("段落审阅筛选无效。");
  const chosen = new Map(
    validateOverlapMarks(analysis, marks).map((mark) => [
      mark.finding,
      mark.verdict,
    ]),
  );
  return overlapFindings(analysis).flatMap((finding) => {
    const verdict = chosen.get(finding.id) ?? null;
    if (
      (filter.kind !== "all" && filter.kind !== finding.kind) ||
      (filter.status === "unreviewed" && verdict !== null) ||
      (["follow-up", "intentional"].includes(filter.status) &&
        filter.status !== verdict)
    )
      return [];
    const [left, right] = findingFamilies(analysis, finding);
    const documents = new Set(
      [...left.documents, ...(right?.documents ?? [])].map(([id]) => id),
    );
    if (filter.document !== "all" && !documents.has(filter.document)) return [];
    return [
      {
        finding,
        verdict,
        documents: documents.size,
        occurrences: left.units.length + (right?.units.length ?? 0),
      },
    ];
  });
}

/** A bounded view over all global results; changing a page never changes the report or marks. */
export function overlapReviewPage<T>(rows: readonly T[], requested: number) {
  if (!Number.isSafeInteger(requested) || requested < 0)
    throw new Error("段落审阅页码无效。");
  const pages = Math.max(1, Math.ceil(rows.length / 12)),
    page = Math.min(requested, pages - 1);
  return { page, pages, rows: paginate(rows, page + 1, 12).visible };
}

function permittedPartner(
  analysis: OverlapAnalysis,
  unit: OverlapUnit,
  right: OverlapFamily,
  exact: boolean,
): boolean {
  const same = new Map(right.documents).get(unit.document) ?? 0;
  return analysis.policy.scope === "all"
    ? right.units.length > (exact ? 1 : 0)
    : analysis.policy.scope === "within-document"
      ? same > (exact ? 1 : 0)
      : right.units.length > same;
}
function permittedPair(
  analysis: OverlapAnalysis,
  left: OverlapUnit,
  right: OverlapUnit,
): boolean {
  return (
    left.id !== right.id &&
    (analysis.policy.scope === "all" ||
      (analysis.policy.scope === "within-document") ===
        (left.document === right.document))
  );
}

/** Selects only supported occurrences; repeated paragraphs remain distinct by validated path. */
export function overlapOccurrences(
  analysis: OverlapAnalysis,
  findingId: string,
  side: "left" | "right",
  leftId: string | null = null,
): OverlapUnit[] {
  const finding = findingAt(analysis, findingId),
    [left, different] = findingFamilies(analysis, finding);
  const right = different ?? left,
    byId = new Map(analysis.units.map((unit) => [unit.id, unit]));
  if (side === "left")
    return left.units
      .map((id) => byId.get(id)!)
      .filter((unit) => permittedPartner(analysis, unit, right, !different));
  if (side !== "right" || !leftId || !left.units.includes(leftId))
    throw new Error("左右位置不在当前文字组内。");
  const from = byId.get(leftId)!;
  return right.units
    .map((id) => byId.get(id)!)
    .filter((unit) => permittedPair(analysis, from, unit));
}

/** Existing grapheme-safe diff is display-only; original text and structure are separately retained. */
export function resolveOverlapPair(
  analysis: OverlapAnalysis,
  findingId: string,
  left: string,
  right: string,
) {
  if (
    !overlapOccurrences(analysis, findingId, "left").some(
      (unit) => unit.id === left,
    ) ||
    !overlapOccurrences(analysis, findingId, "right", left).some(
      (unit) => unit.id === right,
    )
  )
    throw new Error("所选段落组、位置或文稿范围不符，没有猜测其他位置。");
  const before = overlapUnit(analysis, left),
    after = overlapUnit(analysis, right);
  return {
    left: before,
    right: after,
    rawEqual: before.text === after.text,
    structuralEqual: before.structure === after.structure,
    difference: writingTextDifference(before.text, after.text),
  };
}
