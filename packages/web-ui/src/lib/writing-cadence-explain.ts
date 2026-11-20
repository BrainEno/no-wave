import type { CadenceAnalysis, CadenceRange } from "./writing-cadence-model.ts";
import { cadenceInventory } from "./writing-cadence-index.ts";
import { resolveCadenceRow } from "./writing-cadence-review.ts";
import { cadenceActive, cadenceCheckpoint } from "./writing-cadence-symbols.ts";

const LIMITS = Object.freeze({ steps: 1_000_000, tokens: 10_000, window: 20 });
export type CadenceStackFrame = CadenceRange & { item: string; family: string };
export type CadenceStackEvent = CadenceRange & {
  token: number;
  item: string;
  family: string;
  action: "push" | "pair" | "blocked" | "unexpected";
  depthBefore: number;
  depthAfter: number;
  reference: string | null;
  obstruction: string | null;
};
export type CadenceStackExplanation = {
  sourceKey: string;
  id: string;
  focus: "start" | "end";
  unit: string;
  at: number;
  run: CadenceRange | null;
  status: "explained" | "structural-boundary";
  events: CadenceStackEvent[];
  stackAtFocus: CadenceStackFrame[] | null;
  endingOpens: CadenceStackFrame[] | null;
  coverage: {
    steps: number;
    examinedReferences: number;
    totalTokens: number | null;
    replayedTokens: number;
    complete: boolean;
    selectedReached: boolean;
    omittedBefore: number;
    omittedAfter: number;
  };
  frontier: {
    stage: "inventory" | "replay";
    token: number | null;
    start: number | null;
  } | null;
};
export type CadenceExplanationOptions = {
  steps?: number;
  tokens?: number;
  window?: number;
  pause?: () => Promise<void>;
};
type ReplayToken = CadenceRange & {
  item: string;
  family: string;
  action: CadenceStackEvent["action"];
  opener: CadenceRange | null;
  related: CadenceRange[];
  unclosed: boolean;
};
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function sameRange(left: CadenceRange, right: CadenceRange): boolean {
  return (
    left.start === right.start &&
    left.end === right.end &&
    left.pointStart === right.pointStart &&
    left.pointEnd === right.pointEnd
  );
}
class StopInventory extends Error {}

/** Replay owned outcomes, NOT manuscript guessing or a second punctuation parser. The visible window never stores the body. */
export async function explainCadenceStack(
  analysis: CadenceAnalysis,
  id: string,
  focus: "start" | "end" = "start",
  signal = new AbortController().signal,
  options: CadenceExplanationOptions = {},
): Promise<CadenceStackExplanation> {
  const inventory = cadenceInventory(analysis),
    row = resolveCadenceRow(analysis, id),
    unit = inventory.units.get(row.unit)!;
  if (focus !== "start" && focus !== "end")
    throw new Error("请选择原始跨度的起点或终点边界。");
  if (
    Object.keys(options).some(
      (key) => !["steps", "tokens", "window", "pause"].includes(key),
    )
  )
    throw new Error("未知栈解释预算。");
  const limits = {
    steps: options.steps ?? LIMITS.steps,
    tokens: options.tokens ?? LIMITS.tokens,
    window: options.window ?? LIMITS.window,
  };
  if (
    !Number.isSafeInteger(limits.steps) ||
    limits.steps < 0 ||
    limits.steps > LIMITS.steps ||
    !Number.isSafeInteger(limits.tokens) ||
    limits.tokens < 0 ||
    limits.tokens > LIMITS.tokens ||
    !Number.isSafeInteger(limits.window) ||
    limits.window < 0 ||
    limits.window > 40
  )
    throw new Error("栈解释预算或窗口超过固定上限，未放宽计算。");
  const pause =
      options.pause ?? (() => new Promise((resolve) => setTimeout(resolve, 0))),
    at = focus === "start" ? row.start : row.end;
  const run =
    unit.runs.find((run) => row.start >= run.start && row.end <= run.end) ??
    null;
  const result: CadenceStackExplanation = {
    sourceKey: analysis.sourceKey,
    id,
    focus,
    unit: unit.id,
    at,
    run: run ? { ...run } : null,
    status: run ? "explained" : "structural-boundary",
    events: [],
    stackAtFocus: null,
    endingOpens: null,
    coverage: {
      steps: 0,
      examinedReferences: 0,
      totalTokens: null,
      replayedTokens: 0,
      complete: false,
      selectedReached: false,
      omittedBefore: 0,
      omittedAfter: 0,
    },
    frontier: null,
  };
  cadenceActive(signal);
  if (!run) return freeze(result);
  const tokens: ReplayToken[] = [];
  const take = () => {
    if (result.coverage.steps >= limits.steps) throw new StopInventory();
    result.coverage.steps++;
  };
  const belongs = (unitId: string, span: CadenceRange) =>
    unitId === unit.id && span.start >= run.start && span.end <= run.end;
  try {
    for (const pair of analysis.pairs) {
      take();
      if (result.coverage.examinedReferences++ % 512 === 0)
        await cadenceCheckpoint(signal, pause);
      if (!belongs(pair.unit, pair.open)) continue;
      if (!belongs(pair.unit, pair.close))
        throw new Error("配对越过解释游程，未猜测轨迹。");
      tokens.push({
        ...pair.open,
        item: pair.id,
        family: pair.family,
        action: "push",
        opener: null,
        related: [],
        unclosed: false,
      });
      tokens.push({
        ...pair.close,
        item: pair.id,
        family: pair.family,
        action: "pair",
        opener: pair.open,
        related: [],
        unclosed: false,
      });
    }
    for (const finding of analysis.findings) {
      take();
      if (result.coverage.examinedReferences++ % 512 === 0)
        await cadenceCheckpoint(signal, pause);
      if (
        !belongs(finding.unit, finding) ||
        !["unclosed-open", "unexpected-close", "blocked-close"].includes(
          finding.kind,
        )
      )
        continue;
      if (typeof finding.family !== "string")
        throw new Error("配对观察的字符族缺失，未解释轨迹。");
      tokens.push({
        start: finding.start,
        end: finding.end,
        pointStart: finding.pointStart,
        pointEnd: finding.pointEnd,
        item: finding.id,
        family: finding.family,
        action:
          finding.kind === "unclosed-open"
            ? "push"
            : finding.kind === "blocked-close"
              ? "blocked"
              : "unexpected",
        opener: null,
        related: finding.related,
        unclosed: finding.kind === "unclosed-open",
      });
    }
    result.coverage.totalTokens = tokens.length;
    tokens.sort((a, b) => {
      take();
      return a.start - b.start;
    });
  } catch (error) {
    if (!(error instanceof StopInventory)) throw error;
    cadenceActive(signal);
    result.frontier = { stage: "inventory", token: null, start: null };
    return freeze(result);
  }
  await cadenceCheckpoint(signal, pause);
  let low = 0,
    high = tokens.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (tokens[middle]!.start < at) low = middle + 1;
    else high = middle;
  }
  const focusToken = low,
    from = Math.max(0, focusToken - limits.window),
    to = Math.min(tokens.length, focusToken + limits.window + 1);
  const stack: CadenceStackFrame[] = [],
    byFamily = new Map<string, CadenceStackFrame[]>();
  const snapshot = () => stack.map((frame) => ({ ...frame }));
  let previous = -1;
  for (let ordinal = 0; ordinal < tokens.length; ordinal++) {
    if (ordinal >= limits.tokens || result.coverage.steps >= limits.steps) {
      result.frontier = {
        stage: "replay",
        token: ordinal,
        start: tokens[ordinal]!.start,
      };
      break;
    }
    result.coverage.steps++;
    if (ordinal % 512 === 0) await cadenceCheckpoint(signal, pause);
    if (ordinal === focusToken) result.stackAtFocus = snapshot();
    const token = tokens[ordinal]!,
      before = stack.length,
      top = stack.at(-1),
      family = byFamily.get(token.family) ?? [];
    if (token.start <= previous)
      throw new Error("一个原文端点有重复或乱序解释，未选择赢家。");
    previous = token.start;
    let reference: string | null = null,
      obstruction: string | null = null;
    if (token.action === "push") {
      if (stack.length >= 128)
        throw new Error("已提交分析的嵌套超过固定上限。");
      const frame = {
        item: token.item,
        family: token.family,
        start: token.start,
        end: token.end,
        pointStart: token.pointStart,
        pointEnd: token.pointEnd,
      };
      stack.push(frame);
      family.push(frame);
      byFamily.set(token.family, family);
    } else if (token.action === "pair") {
      if (
        !top ||
        top.family !== token.family ||
        top.item !== token.item ||
        !token.opener ||
        !sameRange(top, token.opener) ||
        family.at(-1) !== top
      )
        throw new Error("配对结果不能由当前栈解释，未猜测跨越或修复。");
      reference = top.item;
      family.pop();
      stack.pop();
    } else {
      const matching = family.at(-1),
        expected: CadenceRange[] = [];
      if (token.action === "blocked") {
        if (!matching || !top || matching === top)
          throw new Error("越栈观察与实际嵌套关系不一致。");
        reference = matching.item;
        obstruction = top.item;
        expected.push(matching, top);
      } else {
        if (matching) throw new Error("意外闭符仍有同族开符，未展示错误解释。");
        if (top) {
          expected.push(top);
          obstruction = top.item;
        }
      }
      if (
        expected.length !== token.related.length ||
        expected.some(
          (range, index) => !sameRange(range, token.related[index]!),
        )
      )
        throw new Error("关联开符与当前栈不一致，未展示旧定位。");
    }
    if (ordinal >= from && ordinal < to)
      result.events.push({
        token: ordinal,
        item: token.item,
        family: token.family,
        action: token.action,
        start: token.start,
        end: token.end,
        pointStart: token.pointStart,
        pointEnd: token.pointEnd,
        depthBefore: before,
        depthAfter: stack.length,
        reference,
        obstruction,
      });
    result.coverage.replayedTokens++;
  }
  const complete = result.coverage.replayedTokens === tokens.length;
  if (complete) {
    const expected = tokens.filter((token) => token.unclosed);
    if (
      expected.length !== stack.length ||
      expected.some(
        (token, index) =>
          token.item !== stack[index]!.item || !sameRange(token, stack[index]!),
      )
    )
      throw new Error("游程末开放符号不守恒，未输出尾栈结论。");
    result.endingOpens = snapshot();
    if (focusToken === tokens.length) result.stackAtFocus = snapshot();
  }
  result.coverage.complete = complete;
  result.coverage.selectedReached = result.stackAtFocus !== null;
  result.coverage.omittedBefore = Math.min(
    from,
    result.coverage.replayedTokens,
  );
  result.coverage.omittedAfter =
    tokens.length - Math.min(to, result.coverage.replayedTokens);
  cadenceActive(signal);
  return freeze(result);
}
