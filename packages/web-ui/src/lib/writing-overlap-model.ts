export type OverlapPolicy = {
  mode: "literal" | "folded";
  scope: "all" | "cross-document" | "within-document";
  minimum: number;
  threshold: number;
};
export const DEFAULT_OVERLAP_POLICY: OverlapPolicy = {
  mode: "literal",
  scope: "cross-document",
  minimum: 24,
  threshold: 65,
};
export const OVERLAP_SHINGLE_WIDTH = 5;
export const OVERLAP_LIMITS = {
  units: 4096,
  characters: 2_000_000,
  nearCharacters: 4096,
  indexGrams: 200_000,
  posting: 64,
  candidates: 12_000,
  postingSteps: 250_000,
  comparisonSteps: 1_000_000,
  results: 200,
} as const;
export type OverlapBudgets = {
  -readonly [K in keyof typeof OVERLAP_LIMITS]: number;
};
export type OverlapLimit =
  | "long-unit"
  | "index-budget"
  | "common-grams"
  | "candidate-budget"
  | "posting-budget"
  | "comparison-budget"
  | "result-budget";
export type OverlapUnit = {
  id: string;
  document: string;
  group: string;
  path: number[];
  kind: string;
  text: string;
  normalized: string;
  structure: string;
};
export type OverlapFamily = {
  id: string;
  units: string[];
  normalized: string;
  documents: [string, number][];
};
export type OverlapExact = {
  id: string;
  kind: "exact";
  family: string;
  pairs: number;
  rawVariants: number;
  structuralVariants: number;
};
export type OverlapNear = {
  id: string;
  kind: "near";
  left: string;
  right: string;
  pairs: number;
  intersection: number;
  union: number;
  basisPoints: number;
};
export type OverlapFinding = OverlapExact | OverlapNear;
export type OverlapCoverage = {
  documents: number;
  units: number;
  eligible: number;
  excluded: number;
  families: number;
  indexed: number;
  long: number;
  grams: number;
  candidates: number;
  compared: number;
  probes: number;
  common: number;
  qualified: number;
};
export type OverlapAnalysis = {
  algorithm: "no-wave-writing-overlap-v1";
  sourceKey: string;
  policy: OverlapPolicy;
  units: OverlapUnit[];
  families: OverlapFamily[];
  exact: OverlapExact[];
  near: OverlapNear[];
  coverage: OverlapCoverage;
  limits: OverlapLimit[];
};
export type OverlapProgress = {
  stage: "source" | "index" | "candidates" | "compare";
  done: number;
  total: number;
};
export type OverlapOptions = {
  pause?: () => Promise<void>;
  progress?: (value: OverlapProgress) => void;
  budgets?: Partial<OverlapBudgets>;
};
export function overlapActive(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new DOMException("本机段落审阅已取消。", "AbortError");
}
export function validateOverlapPolicy(value: OverlapPolicy): OverlapPolicy {
  if (
    !value ||
    Object.keys(value).sort().join(",") !== "minimum,mode,scope,threshold" ||
    !["literal", "folded"].includes(value.mode) ||
    !["all", "cross-document", "within-document"].includes(value.scope) ||
    !Number.isSafeInteger(value.minimum) ||
    value.minimum < 8 ||
    value.minimum > 500 ||
    !Number.isSafeInteger(value.threshold) ||
    value.threshold < 50 ||
    value.threshold > 95
  ) {
    throw new Error(
      "段落条件无效：最短 8–500 个字符，相似阈值 50–95，且须明确选择文字与范围模式。",
    );
  }
  return {
    mode: value.mode,
    scope: value.scope,
    minimum: value.minimum,
    threshold: value.threshold,
  };
}
export function overlapBudgets(
  raw: Partial<OverlapBudgets> = {},
): OverlapBudgets {
  const result: OverlapBudgets = { ...OVERLAP_LIMITS };
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(result, key)) throw new Error("未知段落计算预算。");
    const field = key as keyof OverlapBudgets;
    const value = raw[field];
    if (
      !Number.isSafeInteger(value) ||
      value! < 1 ||
      value! > OVERLAP_LIMITS[field]
    )
      throw new Error("段落预算只能在固定上限内缩小。");
    result[field] = value!;
  }
  return result;
}
export function normalizeOverlapText(
  text: string,
  mode: OverlapPolicy["mode"],
): string {
  return mode === "literal"
    ? text
    : text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}
export function overlapPairCount(
  left: OverlapFamily,
  right: OverlapFamily | null,
  scope: OverlapPolicy["scope"],
): number {
  const all = right
    ? left.units.length * right.units.length
    : (left.units.length * (left.units.length - 1)) / 2;
  let within = 0;
  if (right) {
    const counts = new Map(right.documents);
    for (const [document, count] of left.documents)
      within += count * (counts.get(document) ?? 0);
  } else
    for (const [, count] of left.documents) within += (count * (count - 1)) / 2;
  return scope === "all"
    ? all
    : scope === "within-document"
      ? within
      : all - within;
}
export function overlapFindings(analysis: OverlapAnalysis): OverlapFinding[] {
  return [...analysis.exact, ...analysis.near];
}
export function overlapFamily(
  analysis: OverlapAnalysis,
  id: string,
): OverlapFamily {
  const family = analysis.families.find((item) => item.id === id);
  if (!family) throw new Error("段落文字组已经失效。");
  return family;
}
export function overlapUnit(
  analysis: OverlapAnalysis,
  id: string,
): OverlapUnit {
  const unit = analysis.units.find((item) => item.id === id);
  if (!unit) throw new Error("段落位置已经失效。");
  return unit;
}
export function overlapPreview(
  text: string,
  offset = 0,
): { text: string; start: number; end: number; more: boolean } {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length)
    throw new Error("文字预览偏移无效。");
  let start = offset;
  if (start && /[\udc00-\udfff]/u.test(text[start]!)) start--;
  let end = Math.min(text.length, start + 2048);
  if (end < text.length && /[\udc00-\udfff]/u.test(text[end]!)) end--;
  return { text: text.slice(start, end), start, end, more: end < text.length };
}
