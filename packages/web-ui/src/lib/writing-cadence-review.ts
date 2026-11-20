import type {
  CadenceAnalysis,
  CadenceFindingKind,
  CadenceRange,
} from "./writing-cadence-model.ts";
import { cadenceInventory } from "./writing-cadence-index.ts";
import { overlapPreview } from "./writing-overlap-model.ts";
import { cadenceCode, displayCadenceText } from "./writing-cadence-symbols.ts";

export type CadenceMark = { id: string; state: "intentional" | "follow-up" };
export type CadenceFilters = {
  document: string;
  type: "all" | "findings" | "pairs" | "fragments";
  kind: "all" | CadenceFindingKind;
  state: "all" | "unreviewed" | CadenceMark["state"];
  sort: "source" | "length" | "depth";
};
export const DEFAULT_CADENCE_FILTERS: CadenceFilters = {
  document: "all",
  type: "findings",
  kind: "all",
  state: "all",
  sort: "source",
};
export type CadenceRow = CadenceRange & {
  id: string;
  unit: string;
  document: string;
  type: "findings" | "pairs" | "fragments";
  kind: string;
  length: number;
  depth: number;
  state: "unreviewed" | CadenceMark["state"];
};
const rowCache = new WeakMap<
  CadenceAnalysis,
  {
    rows: CadenceRow[];
    byId: Map<string, CadenceRow>;
    ordinal: Map<string, number>;
  }
>();
const findingKinds = [
  "unclosed-open",
  "unexpected-close",
  "blocked-close",
  "invisible",
  "whitespace-run",
  "punctuation-run",
];

function baseRows(analysis: CadenceAnalysis) {
  const inventory = cadenceInventory(analysis),
    cached = rowCache.get(analysis);
  if (cached) return cached;
  const rows: CadenceRow[] = [];
  for (const finding of analysis.findings)
    rows.push({
      id: finding.id,
      unit: finding.unit,
      document: inventory.units.get(finding.unit)!.document,
      type: "findings",
      kind: finding.kind,
      start: finding.start,
      end: finding.end,
      pointStart: finding.pointStart,
      pointEnd: finding.pointEnd,
      length: finding.pointEnd - finding.pointStart,
      depth: 0,
      state: "unreviewed",
    });
  for (const pair of analysis.pairs)
    rows.push({
      id: pair.id,
      unit: pair.unit,
      document: inventory.units.get(pair.unit)!.document,
      type: "pairs",
      kind: pair.family,
      start: pair.open.start,
      end: pair.close.end,
      pointStart: pair.open.pointStart,
      pointEnd: pair.close.pointEnd,
      length: pair.close.pointEnd - pair.open.pointStart,
      depth: inventory.topology.get(pair.id)!.depth,
      state: "unreviewed",
    });
  for (const fragment of analysis.fragments)
    rows.push({
      id: fragment.id,
      unit: fragment.unit,
      document: inventory.units.get(fragment.unit)!.document,
      type: "fragments",
      kind: fragment.ending,
      start: fragment.start,
      end: fragment.end,
      pointStart: fragment.pointStart,
      pointEnd: fragment.pointEnd,
      length: fragment.nonspace,
      depth: 0,
      state: "unreviewed",
    });
  rows.sort(
    (a, b) =>
      inventory.order.get(a.unit)! - inventory.order.get(b.unit)! ||
      a.start - b.start ||
      a.end - b.end ||
      a.id.localeCompare(b.id, "en", { numeric: true }),
  );
  for (const row of rows) Object.freeze(row);
  Object.freeze(rows);
  const result = {
    rows,
    byId: new Map(rows.map((row) => [row.id, row])),
    ordinal: new Map(rows.map((row, index) => [row.id, index])),
  };
  rowCache.set(analysis, result);
  return result;
}
export function resolveCadenceRow(
  analysis: CadenceAnalysis,
  id: string,
): CadenceRow {
  const row = baseRows(analysis).byId.get(id);
  if (!row) throw new Error("审阅编号不属于当前分析，没有定位相邻内容。");
  return row;
}

/** A bad member rejects the whole replacement; callers cannot accidentally preserve a valid subset. */
export function validateCadenceMarks(
  analysis: CadenceAnalysis,
  input: readonly CadenceMark[],
): CadenceMark[] {
  const index = baseRows(analysis),
    seen = new Set<string>(),
    result: CadenceMark[] = [];
  if (!Array.isArray(input) || input.length > index.rows.length)
    throw new Error("临时标记数量或结构无效。");
  for (const mark of input) {
    if (
      !mark ||
      Object.keys(mark).sort().join(",") !== "id,state" ||
      !index.byId.has(mark.id) ||
      seen.has(mark.id) ||
      !["intentional", "follow-up"].includes(mark.state)
    )
      throw new Error("临时标记含过期、重复或无效编号，整批未接纳。");
    seen.add(mark.id);
    result.push({ id: mark.id, state: mark.state });
  }
  result.sort((a, b) => index.ordinal.get(a.id)! - index.ordinal.get(b.id)!);
  return result;
}
export function cadenceMarksKey(
  analysis: CadenceAnalysis,
  marks: readonly CadenceMark[],
): string {
  return JSON.stringify(validateCadenceMarks(analysis, marks));
}
export function cadenceRows(
  analysis: CadenceAnalysis,
  filters: CadenceFilters = DEFAULT_CADENCE_FILTERS,
  marks: readonly CadenceMark[] = [],
): CadenceRow[] {
  const inventory = baseRows(analysis);
  if (
    !filters ||
    Object.keys(filters).sort().join(",") !== "document,kind,sort,state,type" ||
    (filters.document !== "all" &&
      !analysis.documents.includes(filters.document)) ||
    !["all", "findings", "pairs", "fragments"].includes(filters.type) ||
    !["all", ...findingKinds].includes(filters.kind) ||
    !["all", "unreviewed", "intentional", "follow-up"].includes(
      filters.state,
    ) ||
    !["source", "length", "depth"].includes(filters.sort)
  )
    throw new Error("审阅视图条件无效；没有回退到其他文稿。");
  const chosen = new Map(
    validateCadenceMarks(analysis, marks).map((mark) => [mark.id, mark.state]),
  );
  const rows: CadenceRow[] = [];
  for (const row of inventory.rows) {
    if (filters.document !== "all" && row.document !== filters.document)
      continue;
    if (filters.type !== "all" && row.type !== filters.type) continue;
    if (filters.kind !== "all" && row.kind !== filters.kind) continue;
    const state = chosen.get(row.id) ?? "unreviewed";
    if (filters.state !== "all" && state !== filters.state) continue;
    rows.push({ ...row, state });
  }
  if (filters.sort !== "source")
    rows.sort(
      (a, b) =>
        (filters.sort === "length" ? b.length - a.length : b.depth - a.depth) ||
        inventory.ordinal.get(a.id)! - inventory.ordinal.get(b.id)!,
    );
  return rows;
}

export type CadenceContext = {
  id: string;
  unit: string;
  path: number[];
  start: number;
  end: number;
  more: boolean;
  total: number;
  targets: { start: number; end: number; role: string }[];
  pieces: {
    text: string;
    start: number;
    end: number;
    selected: boolean;
    related: boolean;
  }[];
};
/** Projection escapes controls AFTER slicing and highlighting, so displayed expansion never becomes an original-text offset. */
export function cadenceContext(
  analysis: CadenceAnalysis,
  id: string,
  offset?: number,
): CadenceContext {
  const row = resolveCadenceRow(analysis, id),
    inventory = cadenceInventory(analysis),
    unit = inventory.units.get(row.unit)!;
  const page = overlapPreview(unit.text, offset ?? Math.max(0, row.start - 80));
  const ranges: {
    start: number;
    end: number;
    selected: boolean;
    related: boolean;
    role: string;
  }[] = [];
  if (row.type === "pairs") {
    const pair = inventory.pairs.get(id)!;
    ranges.push(
      { ...pair.open, selected: true, related: false, role: "open" },
      { ...pair.close, selected: true, related: false, role: "close" },
    );
  } else {
    ranges.push({
      start: row.start,
      end: row.end,
      selected: true,
      related: false,
      role: "primary",
    });
    for (const range of inventory.findings.get(id)?.related ?? [])
      ranges.push({
        ...range,
        selected: false,
        related: true,
        role: "related",
      });
  }
  const boundaries = new Set<number>([page.start, page.end]);
  for (const range of ranges) {
    if (range.start < page.end && range.end > page.start) {
      boundaries.add(Math.max(page.start, range.start));
      boundaries.add(Math.min(page.end, range.end));
    }
  }
  const ordered = [...boundaries].sort((a, b) => a - b),
    pieces: CadenceContext["pieces"] = [];
  for (let index = 1; index < ordered.length; index++) {
    const start = ordered[index - 1]!,
      end = ordered[index]!;
    if (start === end) continue;
    pieces.push({
      text: displayCadenceText(unit.text.slice(start, end)),
      start,
      end,
      selected: ranges.some(
        (range) => range.selected && range.start < end && range.end > start,
      ),
      related: ranges.some(
        (range) => range.related && range.start < end && range.end > start,
      ),
    });
  }
  return {
    id,
    unit: unit.id,
    path: [...unit.path],
    start: page.start,
    end: page.end,
    more: page.more,
    total: unit.text.length,
    targets: ranges.map((range) => ({
      start: range.start,
      end: range.end,
      role: range.role,
    })),
    pieces,
  };
}

export type CadenceCodepointGroup = {
  codepoint: string;
  category: string;
  count: number;
  documents: { document: string; count: number }[];
  examples: string[];
};
/** Only flagged invisible characters are inventoried; the source remains inert and full manuscript alphabets are not exported. */
export function cadenceCodepoints(
  analysis: CadenceAnalysis,
  document = "all",
): CadenceCodepointGroup[] {
  const inventory = cadenceInventory(analysis);
  if (document !== "all" && !analysis.documents.includes(document))
    throw new Error("隐形字符视图文稿无效。");
  const groups = new Map<
    string,
    {
      category: string;
      count: number;
      documents: Map<string, number>;
      examples: string[];
    }
  >();
  for (const finding of analysis.findings) {
    if (finding.kind !== "invisible") continue;
    const unit = inventory.units.get(finding.unit)!;
    if (document !== "all" && unit.document !== document) continue;
    const codepoint = cadenceCode(unit.text.slice(finding.start, finding.end));
    const group = groups.get(codepoint) ?? {
      category: finding.code,
      count: 0,
      documents: new Map<string, number>(),
      examples: [] as string[],
    };
    if (group.category !== finding.code)
      throw new Error("同一隐形字符的类别计数不一致。");
    group.count++;
    group.documents.set(
      unit.document,
      (group.documents.get(unit.document) ?? 0) + 1,
    );
    if (group.examples.length < 8) group.examples.push(finding.id);
    groups.set(codepoint, group);
  }
  return [...groups]
    .sort(
      ([a], [b]) =>
        Number.parseInt(a.slice(2), 16) - Number.parseInt(b.slice(2), 16),
    )
    .map(([codepoint, group]) => ({
      codepoint,
      category: group.category,
      count: group.count,
      documents: analysis.documents
        .filter((id) => group.documents.has(id))
        .map((document) => ({
          document,
          count: group.documents.get(document)!,
        })),
      examples: [...group.examples],
    }));
}
