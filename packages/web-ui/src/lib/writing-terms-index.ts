import {
  TERMS_LIMITS,
  type TermsAnalysis,
  type TermsMatch,
  type TermsPattern,
  type TermsUnit,
} from "./writing-terms-model.ts";
import {
  foldTermsAscii,
  termsPatterns,
  validateTermsPolicy,
  validateTermsRecipe,
} from "./writing-terms-recipe.ts";
import {
  termsIntersectsBoundary,
  termsWordPoint,
} from "./writing-terms-machine.ts";
import type { TermsCluster } from "./writing-terms-review.ts";

type Inventory = {
  units: ReadonlyMap<string, TermsUnit>;
  patterns: ReadonlyMap<string, TermsPattern>;
  matches: ReadonlyMap<string, TermsMatch>;
  unitOrder: ReadonlyMap<string, number>;
  patternOrder: ReadonlyMap<string, number>;
  inUnit: ReadonlyMap<string, readonly TermsMatch[]>;
  clusterOf: ReadonlyMap<string, TermsCluster>;
  clusters: readonly TermsCluster[];
};
const cached = new WeakMap<TermsAnalysis, Inventory>();
function invalid(): never {
  throw new Error(
    "术语分析的位置、完整性或所属清单已经变化；未展示猜测的内容。",
  );
}

function closed(value: object, keys: string): void {
  if (!Object.isFrozen(value) || Object.keys(value).sort().join(",") !== keys)
    invalid();
}
function checkCatalog(
  analysis: TermsAnalysis,
  patterns: ReadonlyMap<string, TermsPattern>,
  order: ReadonlyMap<string, number>,
): void {
  const catalog = analysis.catalog;
  closed(catalog, "complete,components,relations");
  if (
    typeof catalog.complete !== "boolean" ||
    !Object.isFrozen(catalog.relations) ||
    !Object.isFrozen(catalog.components) ||
    catalog.relations.length > TERMS_LIMITS.relations ||
    catalog.components.length > patterns.size
  )
    invalid();
  const seen = new Set<string>(),
    neighbors = new Map<string, Set<string>>();
  for (const relation of catalog.relations) {
    closed(relation, "kind,left,offsets,right");
    const left = patterns.get(relation.left),
      right = patterns.get(relation.right),
      key = `${relation.left}/${relation.right}`;
    if (
      !left ||
      !right ||
      left.id === right.id ||
      seen.has(key) ||
      !["equal", "contains"].includes(relation.kind) ||
      !Object.isFrozen(relation.offsets)
    )
      invalid();
    seen.add(key);
    const a = [...left.needle],
      b = [...right.needle],
      offsets: number[] = [];
    for (let start = 0; start <= a.length - b.length; start++)
      if (a.slice(start, start + b.length).join("") === right.needle)
        offsets.push(start);
    if (
      !offsets.length ||
      (relation.kind === "equal" &&
        (left.needle !== right.needle ||
          order.get(left.id)! >= order.get(right.id)!)) ||
      (relation.kind === "contains" && left.needle === right.needle) ||
      JSON.stringify(offsets) !== JSON.stringify(relation.offsets)
    )
      invalid();
    const from = neighbors.get(relation.left) ?? new Set<string>(),
      to = neighbors.get(relation.right) ?? new Set<string>();
    from.add(relation.right);
    to.add(relation.left);
    neighbors.set(relation.left, from);
    neighbors.set(relation.right, to);
  }
  // Independent graph traversal verifies the supplied union-find output before any report can expose it.
  const visited = new Set<string>(),
    expectedComponents: string[][] = [];
  for (const id of patterns.keys()) {
    if (visited.has(id) || !neighbors.has(id)) continue;
    const pending = [id],
      members: string[] = [];
    visited.add(id);
    for (let cursor = 0; cursor < pending.length; cursor++) {
      const current = pending[cursor]!;
      members.push(current);
      for (const neighbor of neighbors.get(current)!) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        pending.push(neighbor);
      }
    }
    members.sort((left, right) => order.get(left)! - order.get(right)!);
    expectedComponents.push(members);
  }
  if (JSON.stringify(expectedComponents) !== JSON.stringify(catalog.components))
    invalid();
  const seenComponents = new Set<string>();
  for (const component of catalog.components) {
    if (
      !Object.isFrozen(component) ||
      component.length < 2 ||
      component.length > patterns.size
    )
      invalid();
    let previous = -1;
    for (const id of component) {
      const ordinal = order.get(id);
      if (
        ordinal === undefined ||
        ordinal <= previous ||
        seenComponents.has(id)
      )
        invalid();
      previous = ordinal;
      seenComponents.add(id);
    }
  }
}

/** A linear independent inventory check before views/export: no rescanning every spelling against the body. */
export function termsInventory(analysis: TermsAnalysis): Inventory {
  const previous = cached.get(analysis);
  if (previous) return previous;
  if (
    !Object.isFrozen(analysis) ||
    analysis.algorithm !== "no-wave-writing-terms-v1" ||
    !/^[a-f0-9]{64}$/u.test(analysis.sourceKey) ||
    !/^[a-f0-9]{64}$/u.test(analysis.recipeKey) ||
    !analysis.documents.length ||
    analysis.documents.length > 20 ||
    new Set(analysis.documents).size !== analysis.documents.length ||
    analysis.documents.some((id) => !/^d(?:[1-9]|1\d|20)$/u.test(id))
  )
    invalid();
  const policy = validateTermsPolicy(analysis.policy),
    recipe = validateTermsRecipe(analysis.recipe),
    expected = termsPatterns(recipe, policy);
  if (
    JSON.stringify(analysis.patterns) !== JSON.stringify(expected) ||
    !Object.isFrozen(analysis.patterns) ||
    analysis.units.length > TERMS_LIMITS.units ||
    analysis.matches.length > TERMS_LIMITS.matches
  )
    invalid();
  const patterns = new Map(
      analysis.patterns.map((pattern) => [pattern.id, pattern]),
    ),
    units = new Map<string, TermsUnit>(),
    matches = new Map<string, TermsMatch>();
  const patternOrder = new Map(
      analysis.patterns.map((pattern, ordinal) => [pattern.id, ordinal]),
    ),
    unitOrder = new Map<string, number>();
  closed(
    analysis,
    "algorithm,catalog,coverage,documents,frontier,limit,matches,patterns,policy,recipe,recipeKey,sourceKey,units",
  );
  if (
    !Object.isFrozen(analysis.documents) ||
    !Object.isFrozen(analysis.units) ||
    !Object.isFrozen(analysis.matches)
  )
    invalid();
  closed(analysis.policy, "mode,scope");
  closed(analysis.recipe, "format,rules,version");
  if (!Object.isFrozen(analysis.recipe.rules)) invalid();
  for (const rule of analysis.recipe.rules) {
    closed(rule, "alternatives,boundary,preferred");
    if (!Object.isFrozen(rule.alternatives)) invalid();
  }
  for (const pattern of analysis.patterns)
    closed(pattern, "boundary,id,index,length,needle,rule,text");
  checkCatalog(analysis, patterns, patternOrder);
  let characters = 0;
  for (const [ordinal, unit] of analysis.units.entries()) {
    closed(unit, "blocked,document,id,kind,path,text");
    if (
      !Object.isFrozen(unit) ||
      !Object.isFrozen(unit.path) ||
      !Object.isFrozen(unit.blocked) ||
      !analysis.documents.includes(unit.document) ||
      units.has(unit.id) ||
      !unit.path.length ||
      unit.path.length > 8 ||
      unit.path.some((index) => !Number.isSafeInteger(index) || index < 0) ||
      unit.id !== `${unit.document}:${unit.path.join(".")}` ||
      typeof unit.text !== "string" ||
      !["paragraph", "heading", "quote", "listitem"].includes(unit.kind)
    )
      invalid();
    characters += unit.text.length;
    if (characters > TERMS_LIMITS.characters) invalid();
    let end = 0;
    for (const range of unit.blocked) {
      closed(range, "end,start");
      if (
        !Object.isFrozen(range) ||
        !Number.isSafeInteger(range.start) ||
        !Number.isSafeInteger(range.end) ||
        range.start < end ||
        range.end < range.start ||
        range.end > unit.text.length
      )
        invalid();
      end = range.end;
    }
    units.set(unit.id, unit);
    unitOrder.set(unit.id, ordinal);
  }
  const inUnit = new Map<string, TermsMatch[]>(),
    positions = new Set<string>();
  let lastUnit = -1,
    lastEnd = -1,
    lastPattern = -1;
  for (const [ordinal, match] of analysis.matches.entries()) {
    closed(match, "end,id,pattern,pointEnd,pointStart,start,unit");
    const unit = units.get(match.unit),
      pattern = patterns.get(match.pattern);
    if (
      !unit ||
      !pattern ||
      !Object.isFrozen(match) ||
      match.id !== `m${ordinal + 1}` ||
      !Number.isSafeInteger(match.start) ||
      !Number.isSafeInteger(match.end) ||
      match.start < 0 ||
      match.end <= match.start ||
      match.end > unit.text.length ||
      match.end - match.start > 160 ||
      foldTermsAscii(unit.text.slice(match.start, match.end), policy.mode) !==
        pattern.needle ||
      match.pointEnd - match.pointStart !== pattern.length
    )
      invalid();
    const sourceOrder = unitOrder.get(unit.id)!,
      ruleOrder = patternOrder.get(pattern.id)!;
    if (
      sourceOrder < lastUnit ||
      (sourceOrder === lastUnit &&
        (match.end < lastEnd ||
          (match.end === lastEnd && ruleOrder <= lastPattern)))
    )
      invalid();
    lastUnit = sourceOrder;
    lastEnd = match.end;
    lastPattern = ruleOrder;
    const key = `${unit.id}:${match.start}:${match.end}:${pattern.id}`;
    if (positions.has(key)) invalid();
    positions.add(key);
    const before = [
        ...unit.text.slice(Math.max(0, match.start - 2), match.start),
      ].at(-1),
      after =
        match.end < unit.text.length
          ? String.fromCodePoint(unit.text.codePointAt(match.end)!)
          : undefined;
    if (
      termsIntersectsBoundary(unit.blocked, match.start, match.end) ||
      (pattern.boundary === "word" &&
        (termsWordPoint(before) || termsWordPoint(after)))
    )
      invalid();
    const list = inUnit.get(unit.id) ?? [];
    list.push(match);
    inUnit.set(unit.id, list);
    matches.set(match.id, match);
  }
  let points = 0,
    scannedPoints = 0,
    scannedCharacters = 0;
  if (analysis.frontier) closed(analysis.frontier, "point,unit,utf16");
  const frontierOrder = analysis.frontier
    ? unitOrder.get(analysis.frontier.unit)
    : undefined;
  if (
    analysis.limit === null
      ? analysis.frontier !== null
      : !["matches", "outputs", "steps"].includes(analysis.limit) ||
        frontierOrder === undefined
  )
    invalid();
  for (const [ordinal, unit] of analysis.units.entries()) {
    const list = inUnit.get(unit.id) ?? [],
      wanted = new Map<number, number>();
    for (const match of list) {
      wanted.set(match.start, -1);
      wanted.set(match.end, -1);
    }
    if (analysis.frontier?.unit === unit.id)
      wanted.set(analysis.frontier.utf16, -1);
    let point = 0,
      offset = 0;
    for (const character of unit.text) {
      if (wanted.has(offset)) wanted.set(offset, point);
      offset += character.length;
      point++;
    }
    if (wanted.has(offset)) wanted.set(offset, point);
    points += point;
    for (const match of list) {
      if (
        wanted.get(match.start) !== match.pointStart ||
        wanted.get(match.end) !== match.pointEnd
      )
        invalid();
      if (
        frontierOrder !== undefined &&
        (ordinal > frontierOrder ||
          (ordinal === frontierOrder && match.end > analysis.frontier!.utf16))
      )
        invalid();
    }
    if (frontierOrder === undefined || ordinal < frontierOrder) {
      scannedPoints += point;
      scannedCharacters += unit.text.length;
    } else if (ordinal === frontierOrder) {
      const frontier = analysis.frontier!;
      if (
        !Number.isSafeInteger(frontier.point) ||
        !Number.isSafeInteger(frontier.utf16) ||
        frontier.utf16 < 0 ||
        frontier.utf16 >= unit.text.length ||
        wanted.get(frontier.utf16) !== frontier.point
      )
        invalid();
      scannedPoints += frontier.point;
      scannedCharacters += frontier.utf16;
    }
    Object.freeze(list);
  }
  const coverage = analysis.coverage;
  closed(
    coverage,
    "boundaryRejected,characters,documents,eligibleUnits,excludedUnits,outputs,points,scannedCharacters,scannedPoints,scannedUnits,steps,units,wordRejected",
  );
  if (
    !Object.isFrozen(coverage) ||
    coverage.documents !== analysis.documents.length ||
    coverage.eligibleUnits !== units.size ||
    coverage.units !== coverage.eligibleUnits + coverage.excludedUnits ||
    coverage.units > TERMS_LIMITS.units ||
    coverage.characters !== characters ||
    coverage.points !== points ||
    coverage.scannedCharacters !== scannedCharacters ||
    coverage.scannedPoints !== scannedPoints ||
    coverage.scannedUnits !== (frontierOrder ?? units.size) ||
    coverage.steps > TERMS_LIMITS.steps ||
    coverage.steps < coverage.scannedPoints ||
    coverage.outputs > TERMS_LIMITS.outputs ||
    analysis.matches.length +
      coverage.wordRejected +
      coverage.boundaryRejected >
      coverage.outputs
  )
    invalid();
  for (const value of Object.values(coverage))
    if (!Number.isSafeInteger(value) || value < 0) invalid();
  const clusters: TermsCluster[] = [],
    clusterOf = new Map<string, TermsCluster>();
  for (const unit of analysis.units) {
    const sorted = [...(inUnit.get(unit.id) ?? [])].sort(
      (a, b) =>
        a.start - b.start ||
        a.end - b.end ||
        patternOrder.get(a.pattern)! - patternOrder.get(b.pattern)!,
    );
    let current: TermsCluster | null = null;
    for (const match of sorted) {
      if (!current || match.start >= current.end) {
        current = {
          id: `c${clusters.length + 1}`,
          unit: unit.id,
          start: match.start,
          end: match.end,
          claims: [],
          patterns: [],
          rules: [],
        };
        clusters.push(current);
      }
      current.end = Math.max(current.end, match.end);
      current.claims.push(match.id);
      const pattern = patterns.get(match.pattern)!;
      if (!current.patterns.includes(pattern.id))
        current.patterns.push(pattern.id);
      if (!current.rules.includes(pattern.rule))
        current.rules.push(pattern.rule);
      clusterOf.set(match.id, current);
    }
  }
  for (const cluster of clusters) {
    cluster.claims.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    cluster.patterns.sort(
      (a, b) => patternOrder.get(a)! - patternOrder.get(b)!,
    );
    cluster.rules.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    Object.freeze(cluster.claims);
    Object.freeze(cluster.patterns);
    Object.freeze(cluster.rules);
    Object.freeze(cluster);
  }
  Object.freeze(clusters);
  const index: Inventory = {
    patterns,
    units,
    matches,
    inUnit,
    patternOrder,
    unitOrder,
    clusterOf,
    clusters,
  };
  cached.set(analysis, index);
  return index;
}
