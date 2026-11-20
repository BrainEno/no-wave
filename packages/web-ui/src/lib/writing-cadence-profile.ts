import type {
  CadenceAnalysis,
  CadenceFindingKind,
  CadenceFragment,
  CadencePair,
  CadencePolicy,
  CadenceUnit,
} from "./writing-cadence-model.ts";
import { cadenceInventory } from "./writing-cadence-index.ts";
import {
  compareCadenceDistributions,
  groupCadenceRhythm,
  summarizeCadenceLengths,
} from "./writing-cadence-rhythm.ts";

export type CadenceCoverageState =
  "complete" | "partial" | "unscanned" | "outside-scope";
export type CadenceBand = "short" | "middle" | "long";
const bands: CadenceBand[] = ["short", "middle", "long"];
const emptyFindings = (): Record<CadenceFindingKind, number> => ({
  "unclosed-open": 0,
  "unexpected-close": 0,
  "blocked-close": 0,
  invisible: 0,
  "whitespace-run": 0,
  "punctuation-run": 0,
});
function frozen<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function band(length: number, policy: CadencePolicy): CadenceBand | null {
  if (length === 0) return null;
  return length <= policy.short
    ? "short"
    : length >= policy.long
      ? "long"
      : "middle";
}

/** A sequence diagnostic independent of the histogram: only actually adjacent samples within one structural run contribute. */
export function cadenceTransitions(
  fragments: readonly CadenceFragment[],
  policy: CadencePolicy,
) {
  const cells = bands.flatMap((from) =>
      bands.map((to) => ({ from, to, count: 0, outgoing: 0 })),
    ),
    lookup = new Map(cells.map((cell) => [`${cell.from}/${cell.to}`, cell]));
  let previous: { fragment: CadenceFragment; band: CadenceBand } | null = null,
    total = 0,
    changes = 0;
  for (const fragment of fragments) {
    const current = band(fragment.nonspace, policy);
    if (!current) {
      previous = null;
      continue;
    }
    if (
      previous &&
      previous.fragment.unit === fragment.unit &&
      previous.fragment.run === fragment.run &&
      previous.fragment.end === fragment.start
    ) {
      lookup.get(`${previous.band}/${current}`)!.count++;
      total++;
      if (previous.band !== current) changes++;
    }
    previous = { fragment, band: current };
  }
  for (const from of bands) {
    const outgoing = cells
      .filter((cell) => cell.from === from)
      .reduce((sum, cell) => sum + cell.count, 0);
    for (const cell of cells) if (cell.from === from) cell.outgoing = outgoing;
  }
  if (
    cells.reduce((sum, cell) => sum + cell.count, 0) !== total ||
    changes > total
  )
    throw new Error("节奏转移计数不守恒。");
  return { total, changes, cells };
}

function pairSummary(pairs: readonly CadencePair[], analysis: CadenceAnalysis) {
  const index = cadenceInventory(analysis),
    families = new Map<string, number>(),
    byUnit = new Map<string, CadencePair[]>();
  let roots = 0,
    maximumDepth = 0,
    spanPoints = 0,
    maximumSpan = 0,
    coveredPoints = 0;
  for (const pair of pairs) {
    const node = index.topology.get(pair.id)!;
    if (node.parent === null) roots++;
    maximumDepth = Math.max(maximumDepth, node.depth);
    spanPoints += node.points;
    maximumSpan = Math.max(maximumSpan, node.points);
    families.set(pair.family, (families.get(pair.family) ?? 0) + 1);
    const members = byUnit.get(pair.unit) ?? [];
    members.push(pair);
    byUnit.set(pair.unit, members);
  }
  for (const members of byUnit.values()) {
    members.sort(
      (a, b) =>
        a.open.pointStart - b.open.pointStart ||
        b.close.pointEnd - a.close.pointEnd,
    );
    let start = -1,
      end = -1;
    for (const pair of members) {
      if (pair.open.pointStart > end) {
        if (start >= 0) coveredPoints += end - start;
        start = pair.open.pointStart;
        end = pair.close.pointEnd;
      } else end = Math.max(end, pair.close.pointEnd);
    }
    if (start >= 0) coveredPoints += end - start;
  }
  if (roots > pairs.length || coveredPoints > spanPoints)
    throw new Error("嵌套配对覆盖计数无效。");
  return {
    count: pairs.length,
    roots,
    maximumDepth,
    maximumSpan,
    spanPoints,
    coveredPoints,
    families: [...families]
      .sort(([a], [b]) => a.localeCompare(b, "en"))
      .map(([family, count]) => ({ family, count })),
  };
}
function coverageState(units: number, scanned: number): CadenceCoverageState {
  return units === 0
    ? "outside-scope"
    : scanned === 0
      ? "unscanned"
      : units === scanned
        ? "complete"
        : "partial";
}
function unitPoints(unit: CadenceUnit): number {
  return [...unit.text].length;
}
export type CadenceDocumentProfile = {
  document: string;
  coverage: CadenceCoverageState;
  units: number;
  scannedUnits: number;
  characters: number;
  points: number;
  scannedPoints: number;
  protectedCharacters: number;
  findings: Record<CadenceFindingKind, number>;
  pairs: ReturnType<typeof pairSummary>;
  lengths: ReturnType<typeof summarizeCadenceLengths>;
  rhythm: ReturnType<typeof groupCadenceRhythm>;
  transitions: ReturnType<typeof cadenceTransitions>;
};
export type CadenceUnitProfile = {
  unit: string;
  document: string;
  scanned: boolean;
  points: number;
  protectedCharacters: number;
  findings: number;
  pairs: number;
  fragments: number;
  longest: { id: string; length: number } | null;
};
export type CadenceProfile = {
  documents: CadenceDocumentProfile[];
  units: CadenceUnitProfile[];
  lengths: ReturnType<typeof summarizeCadenceLengths>;
  transitions: ReturnType<typeof cadenceTransitions>;
  pairs: ReturnType<typeof pairSummary>;
};
const cache = new WeakMap<CadenceAnalysis, CadenceProfile>();

/** Full matrix retains zero cells and explicit coverage even for documents after the unscanned frontier. */
export function cadenceProfile(analysis: CadenceAnalysis): CadenceProfile {
  const inventory = cadenceInventory(analysis),
    previous = cache.get(analysis);
  if (previous) return previous;
  const byDocument = new Map(
    analysis.documents.map((document) => [
      document,
      {
        units: [] as CadenceUnit[],
        pairs: [] as CadencePair[],
        fragments: [] as CadenceFragment[],
        findings: emptyFindings(),
      },
    ]),
  );
  const unitProfiles = new Map(
    analysis.units.map((unit, ordinal) => [
      unit.id,
      {
        unit: unit.id,
        document: unit.document,
        scanned: ordinal < analysis.coverage.scannedUnits,
        points: unitPoints(unit),
        protectedCharacters: unit.barriers.reduce(
          (sum, barrier) => sum + barrier.end - barrier.start,
          0,
        ),
        findings: 0,
        pairs: 0,
        fragments: 0,
        longest: null,
      } as CadenceUnitProfile,
    ]),
  );
  for (const unit of analysis.units)
    byDocument.get(unit.document)!.units.push(unit);
  for (const finding of analysis.findings) {
    const unit = inventory.units.get(finding.unit)!;
    byDocument.get(unit.document)!.findings[finding.kind]++;
    unitProfiles.get(unit.id)!.findings++;
  }
  for (const pair of analysis.pairs) {
    const unit = inventory.units.get(pair.unit)!;
    byDocument.get(unit.document)!.pairs.push(pair);
    unitProfiles.get(unit.id)!.pairs++;
  }
  for (const fragment of analysis.fragments) {
    const unit = inventory.units.get(fragment.unit)!,
      profile = unitProfiles.get(unit.id)!;
    byDocument.get(unit.document)!.fragments.push(fragment);
    profile.fragments++;
    if (!profile.longest || fragment.nonspace > profile.longest.length)
      profile.longest = { id: fragment.id, length: fragment.nonspace };
  }
  const documents: CadenceDocumentProfile[] = [];
  for (const document of analysis.documents) {
    const source = byDocument.get(document)!;
    let characters = 0,
      points = 0,
      scannedPoints = 0,
      scannedUnits = 0,
      protectedCharacters = 0;
    for (const unit of source.units) {
      const info = unitProfiles.get(unit.id)!;
      characters += unit.text.length;
      points += info.points;
      protectedCharacters += info.protectedCharacters;
      if (info.scanned) {
        scannedUnits++;
        scannedPoints += info.points;
      }
    }
    documents.push({
      document,
      coverage: coverageState(source.units.length, scannedUnits),
      units: source.units.length,
      scannedUnits,
      characters,
      points,
      scannedPoints,
      protectedCharacters,
      findings: source.findings,
      pairs: pairSummary(source.pairs, analysis),
      lengths: summarizeCadenceLengths(source.fragments, analysis.policy),
      rhythm: groupCadenceRhythm(source.fragments, analysis.policy),
      transitions: cadenceTransitions(source.fragments, analysis.policy),
    });
  }
  if (
    documents.reduce((sum, document) => sum + document.scannedUnits, 0) !==
      analysis.coverage.scannedUnits ||
    documents.reduce((sum, document) => sum + document.pairs.count, 0) !==
      analysis.pairs.length ||
    documents.reduce(
      (sum, document) =>
        sum + Object.values(document.findings).reduce((a, b) => a + b, 0),
      0,
    ) !== analysis.findings.length
  )
    throw new Error("画像与全局分析计数不守恒，未显示部分画像。");
  const result = frozen({
    documents,
    units: [...unitProfiles.values()],
    lengths: summarizeCadenceLengths(analysis.fragments, analysis.policy),
    transitions: cadenceTransitions(analysis.fragments, analysis.policy),
    pairs: pairSummary(analysis.pairs, analysis),
  });
  cache.set(analysis, result);
  return result;
}

/** Explicit pair only. Equal observed distributions never imply equal order, text, quality or complete coverage. */
export function compareCadenceDocuments(
  analysis: CadenceAnalysis,
  left: string,
  right: string,
) {
  cadenceInventory(analysis);
  if (
    left === right ||
    !analysis.documents.includes(left) ||
    !analysis.documents.includes(right)
  )
    throw new Error("请选择当前来源中两篇不同文稿；不猜测默认文稿。");
  const profile = cadenceProfile(analysis),
    a = profile.documents.find((document) => document.document === left)!,
    b = profile.documents.find((document) => document.document === right)!;
  const inDocument = (fragment: CadenceFragment, document: string) =>
    cadenceInventory(analysis).units.get(fragment.unit)!.document === document;
  const distribution = compareCadenceDistributions(
    analysis.fragments.filter((fragment) => inDocument(fragment, left)),
    analysis.fragments.filter((fragment) => inDocument(fragment, right)),
    analysis.policy,
  );
  const pointDenominator = a.scannedPoints * b.scannedPoints;
  const findingDifferences = (
    Object.keys(a.findings) as CadenceFindingKind[]
  ).map((kind) => ({
    kind,
    left: a.findings[kind],
    right: b.findings[kind],
    countDifference: a.findings[kind] - b.findings[kind],
    perPointDifference: pointDenominator
      ? {
          numerator:
            a.findings[kind] * b.scannedPoints -
            b.findings[kind] * a.scannedPoints,
          denominator: pointDenominator,
        }
      : null,
  }));
  const transitionDenominator = a.transitions.total * b.transitions.total;
  const transitions = a.transitions.cells.map((cell, index) => ({
    from: cell.from,
    to: cell.to,
    left: cell.count,
    right: b.transitions.cells[index]!.count,
    difference: transitionDenominator
      ? {
          numerator:
            cell.count * b.transitions.total -
            b.transitions.cells[index]!.count * a.transitions.total,
          denominator: transitionDenominator,
        }
      : null,
  }));
  return frozen({
    left,
    right,
    coverage: { left: a.coverage, right: b.coverage },
    complete: a.coverage === "complete" && b.coverage === "complete",
    distribution,
    findingDifferences,
    transitions,
    pairDifference: a.pairs.count - b.pairs.count,
    depthDifference: a.pairs.maximumDepth - b.pairs.maximumDepth,
  });
}
