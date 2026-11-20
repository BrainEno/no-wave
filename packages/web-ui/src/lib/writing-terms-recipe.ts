import { readCollectionJson } from "./writing-collection.ts";
import { writingRecord } from "./writing-document.ts";
import {
  TERMS_LIMITS,
  type TermsBudgets,
  type TermsPattern,
  type TermsPolicy,
  type TermsRecipe,
  type TermsRule,
} from "./writing-terms-model.ts";

export const TERMS_RECIPE_BYTES = 128 * 1024;

/** No compatibility normalization: every offset must continue to refer to the original string. */
export function foldTermsAscii(
  text: string,
  mode: TermsPolicy["mode"],
): string {
  return mode === "literal"
    ? text
    : text.replace(/[A-Z]/g, (point) => point.toLowerCase());
}
export function validateTermsPolicy(raw: TermsPolicy): TermsPolicy {
  if (
    !raw ||
    Object.keys(raw).sort().join(",") !== "mode,scope" ||
    !["literal", "ascii-fold"].includes(raw.mode) ||
    !["all", "paragraphs", "headings", "quotes", "lists"].includes(raw.scope)
  )
    throw new Error(
      "术语条件无效，请明确选择字面或 ASCII 大小写模式及正文范围。",
    );
  return Object.freeze({ mode: raw.mode, scope: raw.scope });
}
export function termsBudgets(raw: Partial<TermsBudgets> = {}): TermsBudgets {
  const limits: TermsBudgets = { ...TERMS_LIMITS };
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(limits, key)) throw new Error("未知术语计算预算。");
    const field = key as keyof TermsBudgets,
      value = raw[field];
    if (
      !Number.isSafeInteger(value) ||
      value! < 1 ||
      value! > TERMS_LIMITS[field]
    )
      throw new Error("术语预算只能在既有上限内缩小。");
    limits[field] = value!;
  }
  return limits;
}
function spelling(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 160 ||
    !value.length ||
    [...value].length > 80 ||
    value.trim() !== value ||
    /[\p{Cc}\p{Cs}\u202a-\u202e\u2066-\u2069]/u.test(value)
  )
    throw new Error(
      "每个词条须为 1–80 个代码点的完整文字，不含首尾空白、控制符或不完整代理对。",
    );
  return value;
}
/** An owned closed schema; IDs are assigned locally, never imported as authority. */
export function validateTermsRecipe(raw: unknown): TermsRecipe {
  const input = writingRecord(raw);
  if (
    !input ||
    Object.keys(input).sort().join(",") !== "format,rules,version" ||
    input.format !== "no-wave-writing-terms" ||
    input.version !== 1 ||
    !Array.isArray(input.rules) ||
    !input.rules.length ||
    input.rules.length > 128
  )
    throw new Error(
      "词表须为 no-wave-writing-terms v1，包含 1–128 个术语组且没有未知字段。",
    );
  let patterns = 0,
    points = 0;
  const rules: TermsRule[] = input.rules.map((value) => {
    const record = writingRecord(value);
    if (
      !record ||
      Object.keys(record).sort().join(",") !==
        "alternatives,boundary,preferred" ||
      !Array.isArray(record.alternatives) ||
      record.alternatives.length > 7 ||
      !["substring", "word"].includes(String(record.boundary))
    )
      throw new Error("术语组须明确给出偏好词、最多 7 个变体和边界条件。");
    const preferred = spelling(record.preferred),
      alternatives = record.alternatives.map(spelling);
    const variants = [preferred, ...alternatives];
    if (new Set(variants).size !== variants.length)
      throw new Error(
        "同一术语组不能重复列出完全相同的词条；跨组同形仍会保留并提示。",
      );
    patterns += variants.length;
    points += variants.reduce((sum, text) => sum + [...text].length, 0);
    if (patterns > TERMS_LIMITS.patterns || points > TERMS_LIMITS.patternPoints)
      throw new Error(
        "词表超过 512 个词条或 16384 个代码点预算，未接纳部分规则。",
      );
    Object.freeze(alternatives);
    return Object.freeze({
      preferred,
      alternatives,
      boundary: record.boundary as TermsRule["boundary"],
    });
  });
  Object.freeze(rules);
  return Object.freeze({ format: "no-wave-writing-terms", version: 1, rules });
}
export function parseTermsRecipe(text: string): TermsRecipe {
  if (
    typeof text !== "string" ||
    !text.length ||
    text.length > TERMS_RECIPE_BYTES ||
    new TextEncoder().encode(text).byteLength > TERMS_RECIPE_BYTES
  )
    throw new Error("词表 JSON 须大于 0 且不超过 128 KiB 字节，不截断解析。");
  return validateTermsRecipe(readCollectionJson(text));
}
export function termsPatterns(
  recipe: TermsRecipe,
  policy: TermsPolicy,
): TermsPattern[] {
  const patterns = recipe.rules.flatMap((rule, group) =>
    [rule.preferred, ...rule.alternatives].map((text, index) =>
      Object.freeze({
        id: `t${group + 1}:v${index + 1}`,
        rule: `t${group + 1}`,
        index,
        text,
        needle: foldTermsAscii(text, policy.mode),
        length: [...text].length,
        boundary: rule.boundary,
      }),
    ),
  );
  return Object.freeze(patterns) as TermsPattern[];
}
export function termsActive(signal: AbortSignal): void {
  if (signal.aborted)
    throw new DOMException("本机术语审阅已取消。", "AbortError");
}
export async function termsCheckpoint(
  signal: AbortSignal,
  pause: () => Promise<void>,
): Promise<void> {
  termsActive(signal);
  await pause();
  termsActive(signal);
}
