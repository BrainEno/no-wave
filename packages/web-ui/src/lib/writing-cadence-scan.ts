import type {
  CadenceBudgets,
  CadenceFinding,
  CadencePolicy,
  CadenceRange,
  CadenceTape,
  CadenceUnit,
  CadenceUnitAudit,
} from "./writing-cadence-model.ts";
import {
  cadenceCheckpoint,
  cadenceDelimiter,
  cadenceInvisible,
  cadencePunctuation,
  cadenceRange,
  CadenceBudgetStop,
  CadenceMeter,
} from "./writing-cadence-symbols.ts";
import { fragmentCadenceTape } from "./writing-cadence-rhythm.ts";

type Frame = { family: string; range: CadenceRange };

async function tapeFor(
  unit: CadenceUnit,
  range: CadenceRange,
  meter: CadenceMeter,
  signal: AbortSignal,
  pause: () => Promise<void>,
): Promise<CadenceTape> {
  const chars: string[] = [],
    offsets = [range.start];
  let position = range.start;
  for (const point of unit.text.slice(range.start, range.end)) {
    meter.take();
    if (chars.length % 1024 === 0) await cadenceCheckpoint(signal, pause);
    chars.push(point);
    position += point.length;
    offsets.push(position);
  }
  if (
    position !== range.end ||
    chars.length !== range.pointEnd - range.pointStart
  )
    throw new Error("正文代码点游程与原始坐标不符。");
  return { chars, offsets, pointStart: range.pointStart };
}

/** One independent observation for each whitespace run; breaks split pairing, not their literal whitespace inventory. */
async function whitespace(
  unit: CadenceUnit,
  meter: CadenceMeter,
  signal: AbortSignal,
  pause: () => Promise<void>,
  accept: (finding: Omit<CadenceFinding, "id" | "unit">) => void,
): Promise<void> {
  const protectedRanges = unit.barriers.filter(
    (barrier) => barrier.kind === "inline-code",
  );
  let protectedIndex = 0,
    offset = 0,
    pointIndex = 0,
    start = -1,
    pointStart = 0,
    hasBreak = false,
    iterations = 0;
  const flush = () => {
    if (
      start >= 0 &&
      (pointIndex - pointStart > 1 ||
        start === 0 ||
        offset === unit.text.length ||
        hasBreak)
    ) {
      const code = hasBreak
        ? "contains-break"
        : start === 0
          ? "leading"
          : offset === unit.text.length
            ? "trailing"
            : "repeated";
      accept({
        kind: "whitespace-run",
        code,
        family: null,
        start,
        end: offset,
        pointStart,
        pointEnd: pointIndex,
        related: [],
      });
    }
    start = -1;
    hasBreak = false;
  };
  while (offset < unit.text.length) {
    if (iterations++ % 1024 === 0) await cadenceCheckpoint(signal, pause);
    const protectedRange = protectedRanges[protectedIndex];
    if (protectedRange && offset === protectedRange.start) {
      flush();
      offset = protectedRange.end;
      pointIndex = protectedRange.pointEnd;
      protectedIndex++;
      continue;
    }
    meter.take();
    const point = String.fromCodePoint(unit.text.codePointAt(offset)!);
    if (/\s/u.test(point)) {
      if (start < 0) {
        start = offset;
        pointStart = pointIndex;
      }
      if (point === "\t" || point === "\n" || point === "\r") hasBreak = true;
    } else flush();
    offset += point.length;
    pointIndex++;
  }
  flush();
}

/** No recovery edit: a closer below the stack top is observed but never pops intervening openers. */
export async function auditCadenceUnit(
  unit: CadenceUnit,
  policy: CadencePolicy,
  remaining: Pick<CadenceBudgets, "findings" | "pairs" | "fragments" | "depth">,
  meter: CadenceMeter,
  signal: AbortSignal,
  pause: () => Promise<void>,
): Promise<CadenceUnitAudit> {
  const result: CadenceUnitAudit = { findings: [], pairs: [], fragments: [] };
  const finding = (value: CadenceUnitAudit["findings"][number]) => {
    if (result.findings.length >= remaining.findings)
      throw new CadenceBudgetStop("findings");
    result.findings.push(value);
  };
  const acceptPair = (value: CadenceUnitAudit["pairs"][number]) => {
    if (result.pairs.length >= remaining.pairs)
      throw new CadenceBudgetStop("pairs");
    result.pairs.push(value);
  };
  const acceptFragment = (value: CadenceUnitAudit["fragments"][number]) => {
    if (result.fragments.length >= remaining.fragments)
      throw new CadenceBudgetStop("fragments");
    result.fragments.push(value);
  };
  for (const [runIndex, run] of unit.runs.entries()) {
    const tape = await tapeFor(unit, run, meter, signal, pause),
      stack: Frame[] = [],
      families = new Map<string, Frame[]>();
    let slashes = 0,
      punctuationStart = -1;
    const flushPunctuation = (end: number) => {
      if (punctuationStart >= 0 && end - punctuationStart >= 2)
        finding({
          ...cadenceRange(tape, punctuationStart, end),
          kind: "punctuation-run",
          code: "adjacent-punctuation",
          family: null,
          related: [],
        });
      punctuationStart = -1;
    };
    for (let index = 0; index < tape.chars.length; index++) {
      meter.take();
      if (index % 1024 === 0) await cadenceCheckpoint(signal, pause);
      const point = tape.chars[index]!,
        range = cadenceRange(tape, index, index + 1);
      const invisible = cadenceInvisible(point);
      if (invisible)
        finding({
          ...range,
          kind: "invisible",
          code: invisible,
          family: null,
          related: [],
        });
      if (cadencePunctuation(point)) {
        if (punctuationStart < 0) punctuationStart = index;
      } else flushPunctuation(index);
      const token = cadenceDelimiter(
        point,
        tape.chars[index - 1],
        tape.chars[index + 1],
        policy,
        slashes % 2 === 1,
      );
      slashes = point === "\\" ? slashes + 1 : 0;
      if (!token) continue;
      const active = families.get(token.family) ?? [],
        top = stack.at(-1);
      const isClose =
        token.role === "close" ||
        (token.role === "symmetric" && active.length > 0);
      if (!isClose) {
        if (stack.length >= remaining.depth)
          throw new CadenceBudgetStop("depth");
        const frame = { family: token.family, range };
        active.push(frame);
        families.set(token.family, active);
        stack.push(frame);
        continue;
      }
      if (top?.family === token.family) {
        stack.pop();
        if (active.pop() !== top)
          throw new Error("配对栈计数不一致，未提交本单元。");
        acceptPair({ family: token.family, open: top.range, close: range });
      } else {
        const matching = active.at(-1),
          related: CadenceRange[] = [];
        if (matching) related.push(matching.range);
        if (top) related.push(top.range);
        finding({
          ...range,
          kind: matching ? "blocked-close" : "unexpected-close",
          code: matching ? "stack-blocked" : "no-open-at-top",
          family: token.family,
          related,
        });
      }
    }
    flushPunctuation(tape.chars.length);
    for (const frame of stack)
      finding({
        ...frame.range,
        kind: "unclosed-open",
        code: "open-at-run-boundary",
        family: frame.family,
        related: [],
      });
    await fragmentCadenceTape(
      tape,
      runIndex,
      policy,
      meter,
      signal,
      pause,
      acceptFragment,
    );
  }
  await whitespace(unit, meter, signal, pause, finding);
  result.findings.sort(
    (a, b) =>
      a.start - b.start || a.end - b.end || a.kind.localeCompare(b.kind, "en"),
  );
  return result;
}
