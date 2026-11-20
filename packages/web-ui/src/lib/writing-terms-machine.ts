import {
  foldTermsAscii,
  termsActive,
  termsCheckpoint,
} from "./writing-terms-recipe.ts";
import type {
  TermsBudgets,
  TermsCoverage,
  TermsMatch,
  TermsPattern,
  TermsPolicy,
  TermsUnit,
} from "./writing-terms-model.ts";

type State = {
  edges: Map<string, number>;
  failure: number;
  suffix: number;
  terminal: number[];
};
export type TermTextMatch = Omit<TermsMatch, "id" | "unit">;
type Counter = Pick<
  TermsCoverage,
  "steps" | "outputs" | "wordRejected" | "boundaryRejected"
>;
export type TermScan = {
  matches: TermTextMatch[];
  points: number;
  utf16: number;
  limit: "steps" | "outputs" | "matches" | null;
};
export type TermsMachine = {
  patterns: TermsPattern[];
  states: number;
  scan(
    text: string,
    blocked: TermsUnit["blocked"],
    counters: Counter,
    budgets: TermsBudgets,
    ignoreBoundaries?: boolean,
  ): Promise<TermScan>;
};

export function termsIntersectsBoundary(
  blocked: TermsUnit["blocked"],
  start: number,
  end: number,
): boolean {
  let low = 0,
    high = blocked.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (blocked[middle]!.end <= start) low = middle + 1;
    else high = middle;
  }
  return low < blocked.length && blocked[low]!.start < end;
}
export const termsWordPoint = (point: string | undefined) =>
  point !== undefined && /[\p{L}\p{N}\p{M}_]/u.test(point);

/** Aho–Corasick with terminal suffix links, not copied inherited output lists. Every spelling claim survives. */
export async function compileTermsMachine(
  patterns: TermsPattern[],
  policy: TermsPolicy,
  budgets: TermsBudgets,
  signal: AbortSignal,
  pause: () => Promise<void>,
): Promise<TermsMachine> {
  if (
    patterns.length > budgets.patterns ||
    patterns.reduce((sum, pattern) => sum + pattern.length, 0) >
      budgets.patternPoints
  )
    throw new Error("词表超过本轮模式/字符预算，未使用部分词表。");
  const states: State[] = [
    { edges: new Map(), failure: 0, suffix: -1, terminal: [] },
  ];
  let work = 0;
  async function yieldWork() {
    if (++work % 128 === 0) await termsCheckpoint(signal, pause);
  }
  await termsCheckpoint(signal, pause);
  for (const [ordinal, pattern] of patterns.entries()) {
    let state = 0;
    for (const point of pattern.needle) {
      await yieldWork();
      let next = states[state]!.edges.get(point);
      if (next === undefined) {
        if (states.length === budgets.states)
          throw new Error("词表自动机状态超过预算，未编译部分规则。");
        next = states.length;
        states.push({ edges: new Map(), failure: 0, suffix: -1, terminal: [] });
        states[state]!.edges.set(point, next);
      }
      state = next;
    }
    states[state]!.terminal.push(ordinal);
  }
  const queue = [...states[0]!.edges.values()];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const parent = queue[cursor]!;
    for (const [point, child] of states[parent]!.edges) {
      await yieldWork();
      let failure = states[parent]!.failure;
      while (failure && !states[failure]!.edges.has(point)) {
        await yieldWork();
        failure = states[failure]!.failure;
      }
      const target = states[failure]!.edges.get(point) ?? 0;
      states[child]!.failure = target;
      states[child]!.suffix = states[target]!.terminal.length
        ? target
        : states[target]!.suffix;
      queue.push(child);
    }
  }
  termsActive(signal);
  async function scan(
    text: string,
    blocked: TermsUnit["blocked"],
    counters: Counter,
    limits: TermsBudgets,
    ignoreBoundaries = false,
  ): Promise<TermScan> {
    const points = [...text],
      offsets = [0],
      matches: TermTextMatch[] = [];
    let state = 0,
      completed = 0,
      utf16 = 0,
      ticks = 0;
    const stop = (limit: TermScan["limit"]): TermScan => ({
      matches,
      points: completed,
      utf16,
      limit,
    });
    const step = () => {
      if (counters.steps === limits.steps) return false;
      counters.steps++;
      return true;
    };
    for (let index = 0; index < points.length; index++) {
      if (++ticks % 128 === 0) await termsCheckpoint(signal, pause);
      if (!step()) return stop("steps");
      const point = foldTermsAscii(points[index]!, policy.mode);
      while (state && !states[state]!.edges.has(point)) {
        if (!step()) return stop("steps");
        state = states[state]!.failure;
      }
      state = states[state]!.edges.get(point) ?? 0;
      const end = utf16 + points[index]!.length;
      offsets.push(end);
      const pending: { ordinal: number; match: TermTextMatch }[] = [];
      let output = state;
      while (output !== -1) {
        for (const ordinal of states[output]!.terminal) {
          if (++ticks % 128 === 0) await termsCheckpoint(signal, pause);
          if (counters.outputs === limits.outputs) return stop("outputs");
          counters.outputs++;
          const pattern = patterns[ordinal]!,
            pointStart = index + 1 - pattern.length,
            start = offsets[pointStart]!;
          if (
            !ignoreBoundaries &&
            pattern.boundary === "word" &&
            (termsWordPoint(points[pointStart - 1]) ||
              termsWordPoint(points[index + 1]))
          ) {
            counters.wordRejected++;
            continue;
          }
          if (
            !ignoreBoundaries &&
            termsIntersectsBoundary(blocked, start, end)
          ) {
            counters.boundaryRejected++;
            continue;
          }
          pending.push({
            ordinal,
            match: {
              pattern: pattern.id,
              start,
              end,
              pointStart,
              pointEnd: index + 1,
            },
          });
        }
        output = states[output]!.suffix;
      }
      if (matches.length + pending.length > limits.matches)
        return stop("matches");
      pending.sort((a, b) => a.ordinal - b.ordinal);
      matches.push(...pending.map((item) => item.match));
      completed++;
      utf16 = end;
    }
    termsActive(signal);
    return stop(null);
  }
  return Object.freeze({ patterns, states: states.length, scan });
}
