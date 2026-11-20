import type {
  CadenceAnalysis,
  CadenceFinding,
  CadenceFragment,
  CadencePair,
  CadenceRange,
  CadenceUnit,
} from "./writing-cadence-model.ts";
import {
  cadenceDelimiter,
  cadenceFamily,
  cadenceInvisible,
  cadencePunctuation,
  validateCadencePolicy,
} from "./writing-cadence-symbols.ts";

export type CadencePairNode = {
  id: string;
  parent: string | null;
  depth: number;
  points: number;
  children: string[];
};
export type CadenceInventory = {
  units: ReadonlyMap<string, CadenceUnit>;
  findings: ReadonlyMap<string, CadenceFinding>;
  pairs: ReadonlyMap<string, CadencePair>;
  fragments: ReadonlyMap<string, CadenceFragment>;
  order: ReadonlyMap<string, number>;
  topology: ReadonlyMap<string, CadencePairNode>;
};
const witnesses = new WeakMap<CadenceAnalysis, CadenceInventory>();
// Do not expose a mutable Map behind a readonly TypeScript assertion: freeze(Map) alone does not protect entries.
function readonlyMap<Key, Value>(
  map: Map<Key, Value>,
): ReadonlyMap<Key, Value> {
  const view: ReadonlyMap<Key, Value> = {
    get: (key) => map.get(key),
    has: (key) => map.has(key),
    get size() {
      return map.size;
    },
    keys: () => map.keys(),
    values: () => map.values(),
    entries: () => map.entries(),
    [Symbol.iterator]: () => map.entries(),
    forEach: (callback, receiver) =>
      map.forEach((value, key) => callback.call(receiver, value, key, view)),
  };
  return Object.freeze(view);
}
function invalid(): never {
  throw new Error("标点分析的完整性或原文位置无效，未展示猜测内容。");
}
function freezeTree(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const item of Object.values(value)) freezeTree(item);
  Object.freeze(value);
}
function offsets(text: string): Map<number, number> {
  const result = new Map<number, number>([[0, 0]]);
  let offset = 0,
    points = 0;
  for (const point of text) {
    offset += point.length;
    result.set(offset, ++points);
  }
  return result;
}
function checkRange(
  range: CadenceRange,
  points: ReadonlyMap<number, number>,
): void {
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start >= range.end ||
    points.get(range.start) !== range.pointStart ||
    points.get(range.end) !== range.pointEnd
  )
    invalid();
}
function withinRun(
  unit: CadenceUnit,
  range: Pick<CadenceRange, "start" | "end">,
): boolean {
  let low = 0,
    high = unit.runs.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (unit.runs[middle]!.start <= range.start) low = middle + 1;
    else high = middle;
  }
  const run = unit.runs[low - 1];
  return run !== undefined && range.start >= run.start && range.end <= run.end;
}

/** Sort successful pairs independently into a forest; crossing pairs or reused delimiter positions are rejected. */
function pairForest(
  pairs: readonly CadencePair[],
  order: ReadonlyMap<string, number>,
): Map<string, CadencePairNode> {
  const sorted = [...pairs].sort(
    (a, b) =>
      order.get(a.unit)! - order.get(b.unit)! ||
      a.open.start - b.open.start ||
      b.close.end - a.close.end,
  );
  const forest = new Map<string, CadencePairNode>(),
    stack: CadencePair[] = [];
  let unit = "";
  for (const pair of sorted) {
    if (pair.unit !== unit) {
      stack.length = 0;
      unit = pair.unit;
    }
    while (stack.length && stack.at(-1)!.close.end <= pair.open.start)
      stack.pop();
    const parent = stack.at(-1);
    if (parent && pair.close.end > parent.close.start) invalid();
    const node = {
      id: pair.id,
      parent: parent?.id ?? null,
      depth: stack.length + 1,
      points: pair.close.pointEnd - pair.open.pointStart,
      children: [] as string[],
    };
    forest.set(pair.id, node);
    if (parent) forest.get(parent.id)!.children.push(pair.id);
    stack.push(pair);
  }
  for (const node of forest.values()) freezeTree(node);
  return forest;
}

/** Only the analyzer seals a witness; serialized/cloned reports and structurally similar objects are not live analyses. */
export function sealCadenceAnalysis(
  analysis: CadenceAnalysis,
): CadenceAnalysis {
  if (witnesses.has(analysis)) return analysis;
  const policy = validateCadencePolicy(analysis.policy);
  if (
    analysis.algorithm !== "no-wave-writing-cadence-v1" ||
    !/^[a-f0-9]{64}$/u.test(analysis.sourceKey) ||
    !["single", "collection"].includes(analysis.source) ||
    !analysis.documents.length ||
    analysis.documents.length > 20 ||
    new Set(analysis.documents).size !== analysis.documents.length ||
    analysis.documents.some((id) => !/^d(?:[1-9]|1\d|20)$/u.test(id))
  )
    invalid();
  const units = new Map<string, CadenceUnit>(),
    order = new Map<string, number>(),
    pointMaps = new Map<string, Map<number, number>>();
  let characters = 0,
    points = 0,
    protectedCharacters = 0,
    scannedCharacters = 0,
    scannedPoints = 0,
    previousDocument = -1;
  const scanned = analysis.coverage.scannedUnits;
  if (
    !Number.isSafeInteger(scanned) ||
    scanned < 0 ||
    scanned > analysis.units.length
  )
    invalid();
  for (const [index, unit] of analysis.units.entries()) {
    const documentIndex = analysis.documents.indexOf(unit.document);
    if (
      units.has(unit.id) ||
      !unit.path.length ||
      unit.path.some((part) => !Number.isSafeInteger(part) || part < 0) ||
      unit.id !== `${unit.document}:${unit.path.join(".")}` ||
      documentIndex < previousDocument ||
      documentIndex < 0
    )
      invalid();
    previousDocument = documentIndex;
    const map = offsets(unit.text),
      spans = [...unit.runs, ...unit.barriers].sort(
        (a, b) => a.start - b.start,
      );
    let end = 0;
    for (const span of spans) {
      checkRange(span, map);
      if (span.start !== end) invalid();
      end = span.end;
    }
    if (end !== unit.text.length) invalid();
    for (const barrier of unit.barriers) {
      if (!["break", "inline-code"].includes(barrier.kind)) invalid();
      if (
        barrier.kind === "break" &&
        !/^[\t\n\r]$/u.test(unit.text.slice(barrier.start, barrier.end))
      )
        invalid();
      protectedCharacters += barrier.end - barrier.start;
    }
    const pointCount = map.get(unit.text.length)!;
    characters += unit.text.length;
    points += pointCount;
    if (index < scanned) {
      scannedCharacters += unit.text.length;
      scannedPoints += pointCount;
    }
    units.set(unit.id, unit);
    order.set(unit.id, index);
    pointMaps.set(unit.id, map);
  }
  const coverage = analysis.coverage;
  if (
    coverage.documents !== analysis.documents.length ||
    coverage.eligibleUnits !== units.size ||
    coverage.units !== coverage.eligibleUnits + coverage.excludedUnits ||
    !Number.isSafeInteger(coverage.excludedUnits) ||
    coverage.excludedUnits < 0 ||
    coverage.characters !== characters ||
    coverage.points !== points ||
    coverage.protectedCharacters !== protectedCharacters ||
    coverage.scannedCharacters !== scannedCharacters ||
    coverage.scannedPoints !== scannedPoints ||
    !Number.isSafeInteger(coverage.steps) ||
    coverage.steps < 0
  )
    invalid();
  const next = analysis.units[scanned];
  if (next) {
    if (
      !analysis.limit ||
      !["steps", "findings", "pairs", "fragments", "depth"].includes(
        analysis.limit,
      ) ||
      JSON.stringify(analysis.frontier) !==
        JSON.stringify({
          unit: scanned,
          document: next.document,
          path: next.path,
          start: 0,
          pointStart: 0,
        })
    )
      invalid();
  } else if (analysis.limit !== null || analysis.frontier !== null) invalid();
  const findings = new Map<string, CadenceFinding>(),
    pairs = new Map<string, CadencePair>(),
    fragments = new Map<string, CadenceFragment>(),
    tokens = new Set<string>();
  const locate = (unitId: string, range: CadenceRange): CadenceUnit => {
    const unit = units.get(unitId);
    if (!unit || order.get(unitId)! >= scanned) invalid();
    checkRange(range, pointMaps.get(unitId)!);
    return unit;
  };
  const ownToken = (unit: CadenceUnit, range: CadenceRange) => {
    if (range.pointEnd - range.pointStart !== 1 || !withinRun(unit, range))
      invalid();
    const key = `${unit.id}/${range.start}`;
    if (tokens.has(key)) invalid();
    tokens.add(key);
  };
  let findingOrder = -1,
    findingStart = -1;
  for (const [index, finding] of analysis.findings.entries()) {
    if (finding.id !== `f${index + 1}` || findings.has(finding.id)) invalid();
    const unit = locate(finding.unit, finding),
      position = order.get(unit.id)!;
    if (
      position < findingOrder ||
      (position === findingOrder && finding.start < findingStart)
    )
      invalid();
    findingOrder = position;
    findingStart = finding.start;
    const text = unit.text.slice(finding.start, finding.end);
    if (finding.kind === "invisible") {
      if (
        finding.pointEnd - finding.pointStart !== 1 ||
        cadenceInvisible(text) !== finding.code ||
        !withinRun(unit, finding)
      )
        invalid();
    } else if (finding.kind === "whitespace-run") {
      if (
        !/^\s+$/u.test(text) ||
        unit.barriers.some(
          (barrier) =>
            barrier.kind === "inline-code" &&
            finding.start < barrier.end &&
            finding.end > barrier.start,
        )
      )
        invalid();
    } else if (finding.kind === "punctuation-run") {
      if (
        [...text].length < 2 ||
        [...text].some((point) => !cadencePunctuation(point)) ||
        !withinRun(unit, finding)
      )
        invalid();
    } else if (
      ["unclosed-open", "unexpected-close", "blocked-close"].includes(
        finding.kind,
      )
    )
      ownToken(unit, finding);
    else invalid();
    if (
      !["unclosed-open", "unexpected-close", "blocked-close"].includes(
        finding.kind,
      ) &&
      finding.family !== null
    )
      invalid();
    for (const related of finding.related) {
      locate(unit.id, related);
      if (!withinRun(unit, related)) invalid();
    }
    findings.set(finding.id, finding);
  }
  for (const [index, pair] of analysis.pairs.entries()) {
    if (pair.id !== `p${index + 1}` || pairs.has(pair.id)) invalid();
    const unit = locate(pair.unit, pair.open);
    locate(pair.unit, pair.close);
    if (
      pair.open.end > pair.close.start ||
      cadenceFamily(
        unit.text.slice(pair.open.start, pair.open.end),
        unit.text.slice(pair.close.start, pair.close.end),
        policy,
      ) !== pair.family ||
      !withinRun(unit, { start: pair.open.start, end: pair.close.end })
    )
      invalid();
    ownToken(unit, pair.open);
    ownToken(unit, pair.close);
    pairs.set(pair.id, pair);
  }
  // Every recognized delimiter has exactly one primary outcome: pair endpoint or stack observation.
  for (const unit of analysis.units.slice(0, scanned)) {
    for (const run of unit.runs) {
      const chars = [...unit.text.slice(run.start, run.end)];
      let start = run.start,
        slashes = 0;
      for (const [index, point] of chars.entries()) {
        const token = cadenceDelimiter(
          point,
          chars[index - 1],
          chars[index + 1],
          policy,
          slashes % 2 === 1,
        );
        const key = `${unit.id}/${start}`;
        if (Boolean(token) !== tokens.has(key)) invalid();
        slashes = point === "\\" ? slashes + 1 : 0;
        start += point.length;
      }
    }
  }
  let fragmentIndex = 0;
  for (const unit of analysis.units.slice(0, scanned)) {
    for (const [runIndex, run] of unit.runs.entries()) {
      let cursor = run.start;
      while (cursor < run.end) {
        const fragment = analysis.fragments[fragmentIndex];
        if (
          !fragment ||
          fragment.id !== `s${fragmentIndex + 1}` ||
          fragment.unit !== unit.id ||
          fragment.run !== runIndex ||
          fragment.start !== cursor ||
          fragment.end > run.end
        )
          invalid();
        locate(unit.id, fragment);
        const text = unit.text.slice(fragment.start, fragment.end);
        if (
          fragment.points !== [...text].length ||
          fragment.nonspace !==
            [...text].filter((point) => !/\s/u.test(point)).length ||
          !["terminal", "boundary"].includes(fragment.ending) ||
          (fragment.ending === "boundary" && fragment.end !== run.end)
        )
          invalid();
        cursor = fragment.end;
        fragments.set(fragment.id, fragment);
        fragmentIndex++;
      }
    }
  }
  if (fragmentIndex !== analysis.fragments.length) invalid();
  const topology = pairForest(analysis.pairs, order);
  freezeTree(analysis);
  witnesses.set(
    analysis,
    Object.freeze({
      units: readonlyMap(units),
      findings: readonlyMap(findings),
      pairs: readonlyMap(pairs),
      fragments: readonlyMap(fragments),
      order: readonlyMap(order),
      topology: readonlyMap(topology),
    }),
  );
  return analysis;
}
export function cadenceInventory(analysis: CadenceAnalysis): CadenceInventory {
  const value = witnesses.get(analysis);
  if (!value || !Object.isFrozen(analysis)) invalid();
  return value;
}
