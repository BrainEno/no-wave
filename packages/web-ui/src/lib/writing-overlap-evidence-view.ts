import {
  normalizeOverlapText,
  OVERLAP_SHINGLE_WIDTH,
} from "./writing-overlap-model.ts";
import type {
  OverlapEvidence,
  OverlapEvidenceTerm,
} from "./writing-overlap-evidence.ts";

export type OverlapEvidenceFilter = {
  kind: "all" | OverlapEvidenceTerm["kind"];
  query: string;
  order: "source" | "imbalance";
};
export const DEFAULT_OVERLAP_EVIDENCE_FILTER: OverlapEvidenceFilter = {
  kind: "all",
  query: "",
  order: "source",
};
export type OverlapEvidenceContext = {
  pointStart: number;
  pointEnd: number;
  utf16Start: number;
  utf16End: number;
  index: number;
  total: number;
  before: string;
  match: string;
  after: string;
};

/** Query normalization is the already selected analysis mode, never a regex or a new candidate search. */
export function overlapEvidenceTerms(
  evidence: OverlapEvidence,
  filter: OverlapEvidenceFilter,
): OverlapEvidenceTerm[] {
  if (
    !filter ||
    Object.keys(filter).sort().join(",") !== "kind,order,query" ||
    !["all", "shared", "left-only", "right-only"].includes(filter.kind) ||
    !["source", "imbalance"].includes(filter.order) ||
    typeof filter.query !== "string" ||
    filter.query.length > 240 ||
    [...filter.query].length > 120 ||
    /[\u0000\p{Cs}]/u.test(filter.query)
  ) {
    throw new Error("片段筛选无效；只允许最多 120 个代码点的字面文字。");
  }
  const query = normalizeOverlapText(filter.query, evidence.mode);
  const result = evidence.terms.filter(
    (term) =>
      (filter.kind === "all" || term.kind === filter.kind) &&
      (!query || term.text.includes(query)),
  );
  if (filter.order === "imbalance")
    result.sort(
      (a, b) =>
        Math.abs(b.left.length - b.right.length) -
          Math.abs(a.left.length - a.right.length) ||
        b.left.length + b.right.length - a.left.length - a.right.length ||
        Number(a.id.slice(1)) - Number(b.id.slice(1)),
    );
  return result;
}

function evidenceSide(evidence: OverlapEvidence, side: "left" | "right") {
  if (side !== "left" && side !== "right")
    throw new Error("请选择明确的左右分析文字，未猜测来源。");
  return evidence[side];
}

/** Coordinates refer to the analyzed string (normalized when chosen), not to original editor nodes. */
export function overlapEvidenceContext(
  evidence: OverlapEvidence,
  side: "left" | "right",
  termId: string,
  index: number,
): OverlapEvidenceContext {
  const source = evidenceSide(evidence, side),
    term = evidence.terms.find((item) => item.id === termId);
  if (
    !term ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= term[side].length
  )
    throw new Error("该片段或出现位置不属于当前解释；没有定位邻近内容。");
  const pointStart = term[side][index]!,
    pointEnd = pointStart + OVERLAP_SHINGLE_WIDTH;
  const utf16Start = source.offsets[pointStart],
    utf16End = source.offsets[pointEnd];
  if (
    utf16Start === undefined ||
    utf16End === undefined ||
    source.text.slice(utf16Start, utf16End) !== term.text
  )
    throw new Error("片段位置与完整分析文字不符，未展示错误上下文。");
  const before = source.text.slice(
    source.offsets[Math.max(0, pointStart - 40)]!,
    utf16Start,
  );
  const after = source.text.slice(
    utf16End,
    source.offsets[Math.min(source.points, pointEnd + 40)]!,
  );
  return {
    pointStart,
    pointEnd,
    utf16Start,
    utf16End,
    index,
    total: term[side].length,
    before,
    match: term.text,
    after,
  };
}

/** A complete, gap-free partition of an existing literal page; highlighting cannot replace its text. */
export function overlapEvidenceSegments(
  evidence: OverlapEvidence,
  side: "left" | "right",
  start: number,
  end: number,
): { text: string; hit: boolean }[] {
  const source = evidenceSide(evidence, side);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end > source.text.length ||
    end - start > 2048 ||
    (start > 0 && /[\udc00-\udfff]/u.test(source.text[start] ?? "")) ||
    (end < source.text.length &&
      /[\udc00-\udfff]/u.test(source.text[end] ?? ""))
  ) {
    throw new Error("片段覆盖分页无效、过大或拆开代理对，未展示部分文字。");
  }
  const pieces: { text: string; hit: boolean }[] = [];
  for (const span of source.spans) {
    const from = source.offsets[span.start]!,
      to = source.offsets[span.end]!;
    if (to <= start) continue;
    if (from >= end) break;
    const text = source.text.slice(Math.max(from, start), Math.min(to, end));
    if (text) pieces.push({ text, hit: span.shared });
  }
  if (
    pieces.map((piece) => piece.text).join("") !== source.text.slice(start, end)
  )
    throw new Error("片段覆盖分页不完整，没有把丢失文字作为正常预览。");
  return pieces;
}

export function overlapEvidenceAnchors(
  evidence: OverlapEvidence,
  filter: "all" | "chain" | "outside",
) {
  if (!["all", "chain", "outside"].includes(filter))
    throw new Error("唯一片段链筛选无效。");
  return evidence.anchors.filter(
    (anchor) => filter === "all" || (filter === "chain") === anchor.inChain,
  );
}
