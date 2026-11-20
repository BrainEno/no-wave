import type { TermsAnalysis, TermsMatch } from "./writing-terms-model.ts";
import { termsInventory } from "./writing-terms-index.ts";
export type TermsContext = {
  before: string;
  match: string;
  after: string;
  start: number;
  end: number;
  pointStart: number;
  pointEnd: number;
};
export type TermsSegment = {
  text: string;
  start: number;
  end: number;
  claims: number;
  preferred: number;
  alternatives: number;
  rules: number;
  selected: boolean;
};
const splitPair = (text: string, offset: number) =>
  offset > 0 &&
  offset < text.length &&
  /[\udc00-\udfff]/u.test(text[offset]!) &&
  /[\ud800-\udbff]/u.test(text[offset - 1]!);
function contextOffset(text: string, from: number, direction: -1 | 1): number {
  let offset = from;
  for (
    let points = 0;
    points < 40 && (direction === 1 ? offset < text.length : offset > 0);
    points++
  ) {
    offset += direction;
    if (splitPair(text, offset)) offset += direction;
  }
  return offset;
}

/** Original-string windows only: ASCII folding never changes code-point or UTF-16 coordinates. */
export function termsMatchContext(
  analysis: TermsAnalysis,
  id: string,
): TermsContext {
  const inventory = termsInventory(analysis),
    match = inventory.matches.get(id);
  if (!match) throw new Error("该术语位置已失效，没有回退到相邻命中。");
  const unit = inventory.units.get(match.unit)!;
  return Object.freeze({
    before: unit.text.slice(
      contextOffset(unit.text, match.start, -1),
      match.start,
    ),
    match: unit.text.slice(match.start, match.end),
    after: unit.text.slice(match.end, contextOffset(unit.text, match.end, 1)),
    start: match.start,
    end: match.end,
    pointStart: match.pointStart,
    pointEnd: match.pointEnd,
  });
}

/** Sweep-line counters, not pairwise overlap arrays or quadratic active-ID copies. */
export function termsHighlightPage(
  analysis: TermsAnalysis,
  unitId: string,
  start: number,
  end: number,
  selected: string | null = null,
): TermsSegment[] {
  const inventory = termsInventory(analysis),
    unit = inventory.units.get(unitId);
  if (
    !unit ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end > unit.text.length ||
    end - start > 2048 ||
    splitPair(unit.text, start) ||
    splitPair(unit.text, end)
  )
    throw new Error("术语覆盖分页无效、过大或拆开代理对，未显示错误文字。");
  if (selected !== null && inventory.matches.get(selected)?.unit !== unitId)
    throw new Error("所选命中不属于本页原文，不借用其他文稿的位置。");
  type Event = { enter: TermsMatch[]; leave: TermsMatch[] };
  const events = new Map<number, Event>([
    [start, { enter: [], leave: [] }],
    [end, { enter: [], leave: [] }],
  ]);
  function event(at: number): Event {
    const previous = events.get(at);
    if (previous) return previous;
    const value = { enter: [], leave: [] };
    events.set(at, value);
    return value;
  }
  for (const match of inventory.inUnit.get(unitId) ?? []) {
    if (match.end <= start || match.start >= end) continue;
    event(Math.max(start, match.start)).enter.push(match);
    event(Math.min(end, match.end)).leave.push(match);
  }
  const active = new Set<string>(),
    groups = new Map<string, number>(),
    pieces: TermsSegment[] = [];
  let preferred = 0,
    alternatives = 0,
    cursor = start;
  function change(match: TermsMatch, delta: -1 | 1) {
    const pattern = inventory.patterns.get(match.pattern)!;
    if (delta === 1) active.add(match.id);
    else if (!active.delete(match.id))
      throw new Error("术语覆盖事件不守恒，未输出不完整高亮。");
    if (pattern.index === 0) preferred += delta;
    else alternatives += delta;
    const count = (groups.get(pattern.rule) ?? 0) + delta;
    if (count < 0) throw new Error("术语覆盖组计数无效。");
    if (count) groups.set(pattern.rule, count);
    else groups.delete(pattern.rule);
  }
  for (const [position, updates] of [...events].sort((a, b) => a[0] - b[0])) {
    if (position > cursor)
      pieces.push(
        Object.freeze({
          start: cursor,
          end: position,
          text: unit.text.slice(cursor, position),
          claims: active.size,
          preferred,
          alternatives,
          rules: groups.size,
          selected: selected !== null && active.has(selected),
        }),
      );
    for (const match of updates.leave) change(match, -1);
    for (const match of updates.enter) change(match, 1);
    cursor = position;
  }
  if (
    active.size ||
    preferred ||
    alternatives ||
    groups.size ||
    pieces.map((piece) => piece.text).join("") !== unit.text.slice(start, end)
  )
    throw new Error("术语覆盖分页不完整，未隐藏丢失的文字。");
  return Object.freeze(pieces) as TermsSegment[];
}
