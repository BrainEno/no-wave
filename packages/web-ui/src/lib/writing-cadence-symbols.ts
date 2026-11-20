import {
  CADENCE_LIMITS,
  type CadenceBudgets,
  type CadenceLimit,
  type CadencePolicy,
  type CadenceRange,
  type CadenceTape,
} from "./writing-cadence-model.ts";

const DELIMITERS = [
  ["round", "(", ")"],
  ["square", "[", "]"],
  ["brace", "{", "}"],
  ["round-wide", "（", "）"],
  ["square-wide", "［", "］"],
  ["brace-wide", "｛", "｝"],
  ["corner", "「", "」"],
  ["white-corner", "『", "』"],
  ["book", "《", "》"],
  ["angle", "〈", "〉"],
  ["lenticular", "【", "】"],
  ["tortoise", "〔", "〕"],
  ["white-lenticular", "〖", "〗"],
  ["curly-double", "“", "”"],
  ["curly-single", "‘", "’"],
] as const;
const openers = new Map<string, string>(
  DELIMITERS.map(([family, open]) => [open, family]),
);
const closers = new Map<string, string>(
  DELIMITERS.map(([family, , close]) => [close, family]),
);
const named = new Map<number, string>([
  [0x00a0, "nonbreaking-space"],
  [0x202f, "nonbreaking-space"],
  [0x2007, "nonbreaking-space"],
  [0x200b, "zero-width-space"],
  [0x2060, "word-joiner"],
  [0xfeff, "byte-order-mark"],
  [0x00ad, "soft-hyphen"],
  [0x200c, "join-control"],
  [0x200d, "join-control"],
  [0x034f, "combining-grapheme-joiner"],
  [0x061c, "direction-control"],
  [0x200e, "direction-control"],
  [0x200f, "direction-control"],
]);
const word = (text: string | undefined) =>
  text !== undefined && /[\p{L}\p{N}\p{M}]/u.test(text);

export function validateCadencePolicy(value: unknown): CadencePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("请选择完整的本机标点分析条件。");
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).sort().join(",") !== "dot,long,quotes,scope,short" ||
    !["all", "paragraphs", "headings", "quotes", "lists"].includes(
      String(input.scope),
    ) ||
    !["off", "double", "all"].includes(String(input.quotes)) ||
    typeof input.dot !== "boolean" ||
    !Number.isSafeInteger(input.short) ||
    !Number.isSafeInteger(input.long) ||
    Number(input.short) < 1 ||
    Number(input.long) <= Number(input.short) ||
    Number(input.long) > 10000
  )
    throw new Error(
      "分析条件无效：短片段阈值须为正整数，长阈值须更大且不超过10000。",
    );
  return {
    scope: input.scope as CadencePolicy["scope"],
    quotes: input.quotes as CadencePolicy["quotes"],
    dot: input.dot,
    short: Number(input.short),
    long: Number(input.long),
  };
}

export function cadenceBudgets(
  input: Partial<CadenceBudgets> = {},
): CadenceBudgets {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("计算预算结构无效。");
  const result: CadenceBudgets = { ...CADENCE_LIMITS };
  for (const name of Object.keys(input)) {
    if (!Object.hasOwn(result, name))
      throw new Error("未知计算预算，未忽略字段。");
    const key = name as keyof CadenceBudgets,
      value = input[key];
    if (
      !Number.isSafeInteger(value) ||
      value! < 0 ||
      value! > CADENCE_LIMITS[key]
    )
      throw new Error("预算只能缩小固定上限，不能放宽。");
    result[key] = value!;
  }
  return result;
}

export function cadenceActive(signal: AbortSignal): void {
  if (signal.aborted)
    throw new DOMException("本机标点分析已取消。", "AbortError");
}
export async function cadenceCheckpoint(
  signal: AbortSignal,
  pause: () => Promise<void>,
): Promise<void> {
  cadenceActive(signal);
  await pause();
  cadenceActive(signal);
}
export class CadenceBudgetStop extends Error {
  readonly limit: CadenceLimit;
  constructor(limit: CadenceLimit) {
    super("本单元尚未完整扫描，未提交部分发现。");
    this.limit = limit;
  }
}
export class CadenceMeter {
  steps = 0;
  private maximum: number;
  constructor(maximum: number) {
    this.maximum = maximum;
  }
  take(): void {
    if (this.steps >= this.maximum) throw new CadenceBudgetStop("steps");
    this.steps++;
  }
}
export function cadenceRange(
  tape: CadenceTape,
  from: number,
  to: number,
): CadenceRange {
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    to <= from ||
    to > tape.chars.length
  )
    throw new Error("原文范围无效，没有定位相邻字符。");
  return {
    start: tape.offsets[from]!,
    end: tape.offsets[to]!,
    pointStart: tape.pointStart + from,
    pointEnd: tape.pointStart + to,
  };
}
export function cadenceDelimiter(
  point: string,
  previous: string | undefined,
  next: string | undefined,
  policy: CadencePolicy,
  escaped: boolean,
): { family: string; role: "open" | "close" | "symmetric" } | null {
  if ((point === "'" || point === "’") && word(previous) && word(next))
    return null;
  if (point === '"' || point === "'") {
    if (
      escaped ||
      policy.quotes === "off" ||
      (point === "'" && policy.quotes !== "all")
    )
      return null;
    return {
      family: point === '"' ? "ascii-double" : "ascii-single",
      role: "symmetric",
    };
  }
  const open = openers.get(point),
    close = closers.get(point);
  if (open) return { family: open, role: "open" };
  if (close) return { family: close, role: "close" };
  return null;
}
export function cadenceFamily(
  open: string,
  close: string,
  policy: CadencePolicy,
): string | null {
  if (open === close && (open === '"' || open === "'")) {
    if (policy.quotes === "off" || (open === "'" && policy.quotes !== "all"))
      return null;
    return open === '"' ? "ascii-double" : "ascii-single";
  }
  const family = openers.get(open);
  return family && closers.get(close) === family ? family : null;
}
export function cadenceAttaches(
  point: string | undefined,
  policy: CadencePolicy,
): boolean {
  return (
    point !== undefined &&
    (closers.has(point) ||
      (point === '"' && policy.quotes !== "off") ||
      (point === "'" && policy.quotes === "all"))
  );
}
export function cadenceInvisible(point: string): string | null {
  const code = point.codePointAt(0)!;
  if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069))
    return "direction-control";
  if (
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xe0100 && code <= 0xe01ef)
  )
    return "variation-selector";
  const known = named.get(code);
  if (known) return known;
  if (code >= 0xe0020 && code <= 0xe007f) return "tag-character";
  if (/\p{Cf}/u.test(point)) return "other-format-control";
  if (/\p{Zs}/u.test(point) && point !== " ") return "unusual-space";
  if (point === "\u2028" || point === "\u2029") return "unicode-separator";
  return null;
}
export function cadenceCode(point: string): string {
  return `U+${point.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
}
/** Escape invisible/bidi controls before rendering ANY imported text, not only the selected finding. */
export function displayCadenceText(text: string): string {
  const pieces: string[] = [];
  for (const point of text) {
    if (point === "\t") pieces.push("⟦TAB⟧");
    else if (point === "\n") pieces.push("⟦LF⟧\n");
    else if (point === "\r") pieces.push("⟦CR⟧");
    else if (cadenceInvisible(point) || /\p{Cc}/u.test(point))
      pieces.push(`⟦${cadenceCode(point)}⟧`);
    else pieces.push(point);
  }
  return pieces.join("");
}
export function cadenceTerminal(
  chars: readonly string[],
  at: number,
  policy: CadencePolicy,
): boolean {
  const point = chars[at];
  if (point === undefined) return false;
  if (/[。！？!?]/u.test(point)) return true;
  if (point === "…") return chars[at - 1] === "…" || chars[at + 1] === "…";
  if (point !== "." || !policy.dot) return false;
  return !(
    /[0-9]/u.test(chars[at - 1] ?? "") && /[0-9]/u.test(chars[at + 1] ?? "")
  );
}
export function cadencePunctuation(point: string | undefined): boolean {
  return point !== undefined && /[。！？!?…。.,，、;；:：—-]/u.test(point);
}
