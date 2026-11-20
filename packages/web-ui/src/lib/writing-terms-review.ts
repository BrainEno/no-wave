import type {
  TermsAnalysis,
  TermsMatch,
  TermsPattern,
  TermsUnit,
} from "./writing-terms-model.ts";
import { termsInventory } from "./writing-terms-index.ts";
export type TermsMark = { match: string; verdict: "intentional" | "follow-up" };
export type TermsFilter = {
  document: string;
  rule: string;
  variant: string;
  kind: "all" | "preferred" | "alternative";
  status: "all" | "unreviewed" | TermsMark["verdict"];
  overlap: "all" | "overlapping" | "isolated";
  order: "source" | "rule" | "document";
};
export type TermsCluster = {
  id: string;
  unit: string;
  start: number;
  end: number;
  claims: string[];
  patterns: string[];
  rules: string[];
};
export type TermsRow = {
  witness: TermsAnalysis;
  match: TermsMatch;
  pattern: TermsPattern;
  unit: TermsUnit;
  cluster: TermsCluster;
  verdict: TermsMark["verdict"] | null;
};
export type TermsCell = {
  rule: string;
  document: string;
  claims: number;
  locations: number;
  preferred: number;
  alternatives: number;
  variants: string[];
  unreviewed: number;
  intentional: number;
  followUp: number;
};
export type TermsGroupSummary = Omit<TermsCell, "document"> & {
  documents: string[];
  state: "unseen" | "preferred" | "alternatives" | "mixed";
  overlappingClaims: number;
};
export type TermsSummary = {
  claims: number;
  locations: number;
  overlappingClaims: number;
  unreviewed: number;
  complete: boolean;
  groups: TermsGroupSummary[];
  cells: TermsCell[];
  documents: {
    id: string;
    claims: number;
    locations: number;
    units: number;
    ruleCount: number;
    unreviewed: number;
  }[];
};
export const DEFAULT_TERMS_FILTER: TermsFilter = {
  document: "all",
  rule: "all",
  variant: "all",
  kind: "all",
  status: "all",
  overlap: "all",
  order: "source",
};

/** Closed, atomic human annotations; never turn a preference into a replacement instruction. */
export function validateTermsMarks(
  analysis: TermsAnalysis,
  raw: readonly TermsMark[],
): TermsMark[] {
  const inventory = termsInventory(analysis);
  if (!Array.isArray(raw) || raw.length > analysis.matches.length)
    throw new Error("术语标记数量无效，未应用部分选择。");
  const marks = new Map<string, TermsMark["verdict"]>();
  for (const mark of raw) {
    if (
      !mark ||
      Object.keys(mark).sort().join(",") !== "match,verdict" ||
      !inventory.matches.has(mark.match) ||
      marks.has(mark.match) ||
      !["intentional", "follow-up"].includes(mark.verdict)
    )
      throw new Error("术语标记含重复、未知或失效项目，未应用部分选择。");
    marks.set(mark.match, mark.verdict);
  }
  return analysis.matches.flatMap((match) =>
    marks.has(match.id)
      ? [Object.freeze({ match: match.id, verdict: marks.get(match.id)! })]
      : [],
  );
}
export function termsMarksKey(
  analysis: TermsAnalysis,
  marks: readonly TermsMark[],
): string {
  return JSON.stringify(
    validateTermsMarks(analysis, marks).map((mark) => [
      mark.match,
      mark.verdict,
    ]),
  );
}
export function termsClusters(
  analysis: TermsAnalysis,
): readonly TermsCluster[] {
  return termsInventory(analysis).clusters;
}

/** Filters restrict a view, not the global evidence, annotations or report. */
export function termsRows(
  analysis: TermsAnalysis,
  marks: readonly TermsMark[],
  filter: TermsFilter,
): TermsRow[] {
  const index = termsInventory(analysis),
    groups = new Set(analysis.patterns.map((pattern) => pattern.rule));
  const selectedVariant = index.patterns.get(filter?.variant);
  if (
    !filter ||
    Object.keys(filter).sort().join(",") !==
      "document,kind,order,overlap,rule,status,variant" ||
    !["all", "preferred", "alternative"].includes(filter.kind) ||
    !["all", "unreviewed", "intentional", "follow-up"].includes(
      filter.status,
    ) ||
    !["source", "rule", "document"].includes(filter.order) ||
    !["all", "overlapping", "isolated"].includes(filter.overlap) ||
    (filter.document !== "all" &&
      !analysis.documents.includes(filter.document)) ||
    (filter.rule !== "all" && !groups.has(filter.rule)) ||
    (filter.variant !== "all" &&
      (!selectedVariant ||
        (filter.rule !== "all" && selectedVariant.rule !== filter.rule)))
  )
    throw new Error("术语筛选无效，未退回其他文稿或词条。");
  const chosen = new Map(
    validateTermsMarks(analysis, marks).map((mark) => [
      mark.match,
      mark.verdict,
    ]),
  );
  const rows: TermsRow[] = [];
  for (const match of analysis.matches) {
    const unit = index.units.get(match.unit)!,
      pattern = index.patterns.get(match.pattern)!,
      cluster = index.clusterOf.get(match.id)!,
      verdict = chosen.get(match.id) ?? null;
    if (
      (filter.document !== "all" && unit.document !== filter.document) ||
      (filter.rule !== "all" && pattern.rule !== filter.rule) ||
      (filter.variant !== "all" && pattern.id !== filter.variant)
    )
      continue;
    if (
      (filter.kind === "preferred" && pattern.index !== 0) ||
      (filter.kind === "alternative" && pattern.index === 0)
    )
      continue;
    if (
      (filter.status === "unreviewed" && verdict !== null) ||
      (["intentional", "follow-up"].includes(filter.status) &&
        verdict !== filter.status)
    )
      continue;
    if (
      (filter.overlap === "overlapping" && cluster.claims.length === 1) ||
      (filter.overlap === "isolated" && cluster.claims.length !== 1)
    )
      continue;
    rows.push(
      Object.freeze({
        witness: analysis,
        match,
        unit,
        pattern,
        cluster,
        verdict,
      }),
    );
  }
  if (filter.order !== "source")
    rows.sort((a, b) => {
      const primary =
        filter.order === "rule"
          ? Number(a.pattern.rule.slice(1)) - Number(b.pattern.rule.slice(1))
          : analysis.documents.indexOf(a.unit.document) -
            analysis.documents.indexOf(b.unit.document);
      return (
        primary ||
        index.unitOrder.get(a.unit.id)! - index.unitOrder.get(b.unit.id)! ||
        a.match.start - b.match.start ||
        a.match.end - b.match.end ||
        index.patternOrder.get(a.pattern.id)! -
          index.patternOrder.get(b.pattern.id)!
      );
    });
  return rows;
}
export function resolveTermsRow(
  analysis: TermsAnalysis,
  row: TermsRow,
): TermsRow {
  const index = termsInventory(analysis);
  if (
    row.witness !== analysis ||
    index.matches.get(row.match.id) !== row.match ||
    index.units.get(row.unit.id) !== row.unit ||
    index.patterns.get(row.pattern.id) !== row.pattern ||
    index.clusterOf.get(row.match.id) !== row.cluster
  )
    throw new Error("该术语位置来自旧分析，未定位其他内容。");
  return row;
}

type Tally = {
  claims: number;
  locations: Set<string>;
  preferred: number;
  alternatives: number;
  variants: Set<string>;
  documents: Set<string>;
  rules: Set<string>;
  unreviewed: number;
  intentional: number;
  followUp: number;
  overlappingClaims: number;
};
const tally = (): Tally => ({
  claims: 0,
  locations: new Set(),
  preferred: 0,
  alternatives: 0,
  variants: new Set(),
  documents: new Set(),
  rules: new Set(),
  unreviewed: 0,
  intentional: 0,
  followUp: 0,
  overlappingClaims: 0,
});
function addClaim(tally: Tally, row: TermsRow): void {
  tally.claims++;
  tally.locations.add(`${row.unit.id}:${row.match.start}:${row.match.end}`);
  if (row.pattern.index === 0) tally.preferred++;
  else tally.alternatives++;
  tally.variants.add(row.pattern.id);
  tally.documents.add(row.unit.document);
  tally.rules.add(row.pattern.rule);
  if (row.verdict === "intentional") tally.intentional++;
  else if (row.verdict === "follow-up") tally.followUp++;
  else tally.unreviewed++;
  if (row.cluster.claims.length > 1) tally.overlappingClaims++;
}
function cell(
  rule: string,
  document: string,
  tally: Tally,
  patternOrder: ReadonlyMap<string, number>,
): TermsCell {
  const variants = [...tally.variants].sort(
    (a, b) => patternOrder.get(a)! - patternOrder.get(b)!,
  );
  Object.freeze(variants);
  return Object.freeze({
    rule,
    document,
    claims: tally.claims,
    locations: tally.locations.size,
    preferred: tally.preferred,
    alternatives: tally.alternatives,
    variants,
    unreviewed: tally.unreviewed,
    intentional: tally.intentional,
    followUp: tally.followUp,
  });
}

/** One pass over claims; retain empty cells and distinguish exact locations from overlapping labels. */
export function summarizeTerms(
  analysis: TermsAnalysis,
  marks: readonly TermsMark[] = [],
): TermsSummary {
  const index = termsInventory(analysis),
    rows = termsRows(analysis, marks, DEFAULT_TERMS_FILTER),
    total = tally();
  const rules = analysis.recipe.rules.map((_, ordinal) => `t${ordinal + 1}`),
    groups = new Map(rules.map((id) => [id, tally()])),
    docs = new Map(analysis.documents.map((id) => [id, tally()]));
  const grid = new Map<string, Tally>();
  for (const rule of rules)
    for (const document of analysis.documents)
      grid.set(`${rule}/${document}`, tally());
  for (const row of rows) {
    addClaim(total, row);
    addClaim(groups.get(row.pattern.rule)!, row);
    addClaim(docs.get(row.unit.document)!, row);
    addClaim(grid.get(`${row.pattern.rule}/${row.unit.document}`)!, row);
  }
  const cells: TermsCell[] = [];
  for (const rule of rules)
    for (const document of analysis.documents)
      cells.push(
        cell(
          rule,
          document,
          grid.get(`${rule}/${document}`)!,
          index.patternOrder,
        ),
      );
  const summaries: TermsGroupSummary[] = rules.map((rule) => {
    const counts = groups.get(rule)!,
      { document: _document, ...values } = cell(
        rule,
        "",
        counts,
        index.patternOrder,
      );
    const documents = analysis.documents.filter((id) =>
      counts.documents.has(id),
    );
    Object.freeze(documents);
    const state = !counts.claims
      ? "unseen"
      : !counts.alternatives
        ? "preferred"
        : !counts.preferred
          ? "alternatives"
          : "mixed";
    return Object.freeze({
      ...values,
      documents,
      state,
      overlappingClaims: counts.overlappingClaims,
    });
  });
  const documents = analysis.documents.map((id) => {
    const counts = docs.get(id)!;
    return Object.freeze({
      id,
      claims: counts.claims,
      locations: counts.locations.size,
      units: analysis.units.filter((unit) => unit.document === id).length,
      ruleCount: counts.rules.size,
      unreviewed: counts.unreviewed,
    });
  });
  if (
    total.claims !== analysis.matches.length ||
    total.unreviewed !== analysis.matches.length - marks.length ||
    cells.reduce((sum, item) => sum + item.claims, 0) !== total.claims
  )
    throw new Error("术语分布与全局位置计数不一致，未输出部分概览。");
  Object.freeze(summaries);
  Object.freeze(documents);
  Object.freeze(cells);
  return Object.freeze({
    claims: total.claims,
    locations: total.locations.size,
    overlappingClaims: total.overlappingClaims,
    unreviewed: total.unreviewed,
    complete: analysis.limit === null,
    groups: summaries,
    documents,
    cells,
  });
}
