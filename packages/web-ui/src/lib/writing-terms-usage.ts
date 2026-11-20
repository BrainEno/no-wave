import { termsInventory } from "./writing-terms-index.ts";
import type { TermsAnalysis } from "./writing-terms-model.ts";
export type TermsDocumentCoverage = {
  document: string;
  units: number;
  scannedUnits: number;
  scannedPoints: number;
  state: "outside-scope" | "complete" | "partial" | "unscanned";
};
export type TermsSpellingClass = { id: string; patterns: string[] };
export type TermsUsageCell = {
  document: string;
  coverage: TermsDocumentCoverage["state"];
  classes: { id: string; claims: number; locations: number }[];
  observed: string[];
  locations: number;
  claims: number;
};
export type TermsUsageGroup = {
  rule: string;
  classes: TermsSpellingClass[];
  cells: TermsUsageCell[];
  observed: string[];
  mixedDocuments: string[];
  signatures: {
    id: string;
    classes: string[];
    coverage: TermsDocumentCoverage["state"];
    documents: string[];
  }[];
  coUses: {
    left: string;
    right: string;
    both: string[];
    leftObservedOnly: string[];
    rightObservedOnly: string[];
    neitherObserved: string[];
  }[];
};
export type TermsUsage = {
  sourceKey: string;
  recipeKey: string;
  documents: TermsDocumentCoverage[];
  groups: TermsUsageGroup[];
};
export type TermsUsageComparison = {
  left: string;
  right: string;
  comparable: boolean;
  groups: {
    rule: string;
    state: "both-unseen" | "same-observed-set" | "different-observed-set";
    shared: string[];
    leftOnly: string[];
    rightOnly: string[];
    leftLocations: number;
    rightLocations: number;
    difference: number;
  }[];
};
const profiles = new WeakMap<TermsAnalysis, TermsUsage>();
function freezeUsage<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeUsage(child);
    Object.freeze(value);
  }
  return value;
}
function documentCoverage(analysis: TermsAnalysis): TermsDocumentCoverage[] {
  const index = termsInventory(analysis),
    documents = new Map(
      analysis.documents.map((document) => [
        document,
        {
          document,
          units: 0,
          scannedUnits: 0,
          scannedPoints: 0,
          state: "unscanned" as TermsDocumentCoverage["state"],
        },
      ]),
    );
  const frontier = analysis.frontier
    ? index.unitOrder.get(analysis.frontier.unit)!
    : analysis.units.length;
  for (const [ordinal, unit] of analysis.units.entries()) {
    const document = documents.get(unit.document)!;
    document.units++;
    if (ordinal < frontier) {
      document.scannedUnits++;
      for (const _point of unit.text) document.scannedPoints++;
    } else if (ordinal === frontier && analysis.frontier)
      document.scannedPoints += analysis.frontier.point;
  }
  for (const document of documents.values()) {
    if (!document.units) document.state = "outside-scope";
    else if (document.scannedUnits === document.units)
      document.state = "complete";
    else if (document.scannedUnits || document.scannedPoints)
      document.state = "partial";
  }
  const result = [...documents.values()];
  if (
    result.reduce((sum, document) => sum + document.scannedUnits, 0) !==
      analysis.coverage.scannedUnits ||
    result.reduce((sum, document) => sum + document.scannedPoints, 0) !==
      analysis.coverage.scannedPoints
  )
    throw new Error("术语文稿覆盖与扫描前沿不守恒，未推断完整缺席。");
  return result;
}
type Count = { claims: number; locations: Set<string> };
type CellCount = {
  claims: number;
  locations: Set<string>;
  classes: Map<string, Count>;
};

/** Presence signatures operate on comparison-spelling classes, not duplicate term claims or semantic identities. */
export function profileTermsUsage(analysis: TermsAnalysis): TermsUsage {
  const index = termsInventory(analysis),
    previous = profiles.get(analysis);
  if (previous) return previous;
  const documents = documentCoverage(analysis),
    classes = new Map<string, TermsSpellingClass[]>(),
    patternClass = new Map<string, string>();
  const needles = new Map<string, Map<string, TermsSpellingClass>>();
  for (const pattern of analysis.patterns) {
    const dictionary =
        needles.get(pattern.rule) ?? new Map<string, TermsSpellingClass>(),
      definitions = classes.get(pattern.rule) ?? [];
    let spelling = dictionary.get(pattern.needle);
    if (!spelling) {
      spelling = {
        id: `${pattern.rule}:s${definitions.length + 1}`,
        patterns: [],
      };
      dictionary.set(pattern.needle, spelling);
      definitions.push(spelling);
    }
    spelling.patterns.push(pattern.id);
    patternClass.set(pattern.id, spelling.id);
    needles.set(pattern.rule, dictionary);
    classes.set(pattern.rule, definitions);
  }
  const counts = new Map<string, CellCount>();
  for (const [rule, definitions] of classes)
    for (const document of documents) {
      counts.set(`${rule}/${document.document}`, {
        claims: 0,
        locations: new Set(),
        classes: new Map(
          definitions.map((spelling) => [
            spelling.id,
            { claims: 0, locations: new Set() },
          ]),
        ),
      });
    }
  let claims = 0;
  for (const match of analysis.matches) {
    const pattern = index.patterns.get(match.pattern)!,
      document = index.units.get(match.unit)!.document,
      spelling = patternClass.get(pattern.id)!;
    const cell = counts.get(`${pattern.rule}/${document}`)!,
      entry = cell.classes.get(spelling)!,
      location = `${match.unit}:${match.start}:${match.end}`;
    claims++;
    cell.claims++;
    entry.claims++;
    cell.locations.add(location);
    entry.locations.add(location);
  }
  const groups: TermsUsageGroup[] = [];
  for (const [rule, definitions] of classes) {
    const signatures = new Map<string, TermsUsageGroup["signatures"][number]>(),
      cells: TermsUsageCell[] = [];
    const allObserved = new Set<string>(),
      mixedDocuments: string[] = [];
    for (const document of documents) {
      const raw = counts.get(`${rule}/${document.document}`)!;
      const rows = definitions.map((spelling) => {
        const entry = raw.classes.get(spelling.id)!;
        if (
          entry.locations.size > entry.claims ||
          entry.claims > entry.locations.size * spelling.patterns.length
        )
          throw new Error("术语折叠类计数不守恒。");
        return {
          id: spelling.id,
          claims: entry.claims,
          locations: entry.locations.size,
        };
      });
      const observed = rows
        .filter((row) => row.locations > 0)
        .map((row) => row.id);
      for (const id of observed) allObserved.add(id);
      if (observed.length > 1) mixedDocuments.push(document.document);
      const key = `${document.state}/${observed.join(",")}`;
      let signature = signatures.get(key);
      if (!signature) {
        signature = {
          id: `${rule}:u${signatures.size + 1}`,
          classes: observed,
          coverage: document.state,
          documents: [],
        };
        signatures.set(key, signature);
      }
      signature.documents.push(document.document);
      cells.push({
        document: document.document,
        coverage: document.state,
        classes: rows,
        observed,
        claims: raw.claims,
        locations: raw.locations.size,
      });
      if (
        rows.reduce((sum, row) => sum + row.claims, 0) !== raw.claims ||
        rows.reduce((sum, row) => sum + row.locations, 0) !== raw.locations.size
      )
        throw new Error("术语拼写画像丢失或重复计算原文位置。");
    }
    const coUses: TermsUsageGroup["coUses"] = [];
    for (let left = 0; left < definitions.length; left++)
      for (let right = left + 1; right < definitions.length; right++) {
        const a = definitions[left]!.id,
          b = definitions[right]!.id;
        const item = {
          left: a,
          right: b,
          both: [] as string[],
          leftObservedOnly: [] as string[],
          rightObservedOnly: [] as string[],
          neitherObserved: [] as string[],
        };
        for (const cell of cells) {
          const hasA = cell.observed.includes(a),
            hasB = cell.observed.includes(b);
          if (hasA && hasB) item.both.push(cell.document);
          else if (hasA) item.leftObservedOnly.push(cell.document);
          else if (hasB) item.rightObservedOnly.push(cell.document);
          else item.neitherObserved.push(cell.document);
        }
        if (
          item.both.length +
            item.leftObservedOnly.length +
            item.rightObservedOnly.length +
            item.neitherObserved.length !==
          documents.length
        )
          throw new Error("术语共现文稿分区不完整。");
        coUses.push(item);
      }
    groups.push({
      rule,
      classes: definitions,
      cells,
      observed: definitions
        .filter((spelling) => allObserved.has(spelling.id))
        .map((spelling) => spelling.id),
      mixedDocuments,
      signatures: [...signatures.values()],
      coUses,
    });
  }
  if (
    claims !== analysis.matches.length ||
    groups.reduce(
      (sum, group) =>
        sum + group.cells.reduce((sum, cell) => sum + cell.claims, 0),
      0,
    ) !== claims
  )
    throw new Error("术语拼写画像与完整命中清单不一致。");
  const result = freezeUsage({
    sourceKey: analysis.sourceKey,
    recipeKey: analysis.recipeKey,
    documents,
    groups,
  });
  profiles.set(analysis, result);
  return result;
}

/** Compare only two explicitly chosen document profiles; equal sets are not equal bodies, counts or editorial correctness. */
export function compareTermsUsage(
  analysis: TermsAnalysis,
  usage: TermsUsage,
  left: string,
  right: string,
): TermsUsageComparison {
  if (profileTermsUsage(analysis) !== usage || left === right)
    throw new Error("术语拼写画像已失效或文稿配对无效，未借用旧结果。");
  const a = usage.documents.find((document) => document.document === left),
    b = usage.documents.find((document) => document.document === right);
  if (!a || !b) throw new Error("须明确选择本轮两篇不同的文稿。");
  const groups: TermsUsageComparison["groups"] = [];
  for (const group of usage.groups) {
    const leftCell = group.cells.find((cell) => cell.document === left)!,
      rightCell = group.cells.find((cell) => cell.document === right)!;
    const shared = leftCell.observed.filter((id) =>
        rightCell.observed.includes(id),
      ),
      leftOnly = leftCell.observed.filter(
        (id) => !rightCell.observed.includes(id),
      ),
      rightOnly = rightCell.observed.filter(
        (id) => !leftCell.observed.includes(id),
      );
    const difference = leftOnly.length + rightOnly.length;
    const state =
      !leftCell.observed.length && !rightCell.observed.length
        ? "both-unseen"
        : difference
          ? "different-observed-set"
          : "same-observed-set";
    if (
      shared.length + leftOnly.length !== leftCell.observed.length ||
      shared.length + rightOnly.length !== rightCell.observed.length
    )
      throw new Error("术语文稿对照丢失拼写类。");
    groups.push({
      rule: group.rule,
      state,
      shared,
      leftOnly,
      rightOnly,
      leftLocations: leftCell.locations,
      rightLocations: rightCell.locations,
      difference,
    });
  }
  return freezeUsage({
    left,
    right,
    comparable: a.state === "complete" && b.state === "complete",
    groups,
  });
}
