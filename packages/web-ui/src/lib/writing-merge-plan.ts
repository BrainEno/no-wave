import {
  collectionCanonicalJson,
  collectionChecksum,
  readCollectionJson,
} from "./writing-collection.ts";
import { writingRecord } from "./writing-document.ts";
import {
  assertWritingMergeActive,
  MERGE_ROLES,
  MERGE_CHOICES,
  validateWritingMergeDecisions,
  WRITING_MERGE_ALGORITHM,
  type WritingMergeAnalysis,
  type WritingMergeDecision,
  type WritingMergeRole,
} from "./writing-merge.ts";

export const MERGE_PLAN_BYTE_LIMIT = 64 * 1024;
const FORMAT = "no-wave-writing-merge-plan";
const SHA256 = /^[a-f0-9]{64}$/;
const PLAN_FIELDS = [
  "format",
  "version",
  "algorithm",
  "createdAt",
  "analysisKey",
  "sources",
  "decisions",
  "digest",
];
export type WritingMergePlan = {
  format: typeof FORMAT;
  version: 1;
  algorithm: typeof WRITING_MERGE_ALGORITHM;
  createdAt: string;
  analysisKey: string;
  sources: Record<WritingMergeRole, string>;
  decisions: WritingMergeDecision[];
  digest: string;
};
export type PreparedWritingMergePlan = { plan: WritingMergePlan; text: string };
export type WritingMergePlanPreview = {
  analysisKey: string;
  decisions: WritingMergeDecision[];
  plan: WritingMergePlan;
  manual: number;
  unresolved: number;
};

function exact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const data = writingRecord(value);
  if (
    !data ||
    Object.keys(data).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(data, key))
  ) {
    throw new Error("合并计划含缺失、未知字段或无效结构。");
  }
  return data;
}

function timestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error("合并计划创建时间无效。");
  }
  return value;
}

function bounded(text: string): void {
  if (
    !text.length ||
    text.length > MERGE_PLAN_BYTE_LIMIT ||
    new TextEncoder().encode(text).byteLength > MERGE_PLAN_BYTE_LIMIT
  ) {
    throw new Error("合并计划须大于 0 且不超过 64 KiB。");
  }
}

function sourceReferences(raw: unknown): Record<WritingMergeRole, string> {
  const data = exact(raw, MERGE_ROLES);
  const sources = {} as Record<WritingMergeRole, string>;
  for (const role of MERGE_ROLES) {
    const digest = data[role];
    if (typeof digest !== "string" || !SHA256.test(digest))
      throw new Error("合并计划的来源摘要无效。");
    sources[role] = digest;
  }
  return sources;
}

/** Content-free navigation/choice data. A checksum is not a signature or author approval. */
export async function createWritingMergePlan(
  analysis: WritingMergeAnalysis,
  raw: readonly WritingMergeDecision[],
  now = new Date(),
  signal?: AbortSignal,
): Promise<PreparedWritingMergePlan> {
  assertWritingMergeActive(signal);
  const decisions = validateWritingMergeDecisions(analysis, raw);
  const payload = {
    format: FORMAT,
    version: 1,
    algorithm: WRITING_MERGE_ALGORITHM,
    createdAt: timestamp(now.toISOString()),
    analysisKey: analysis.key,
    sources: sourceReferences(analysis.sources),
    decisions,
  } as const;
  const digest = await collectionChecksum(payload, signal);
  const plan: WritingMergePlan = { ...payload, digest };
  const text = JSON.stringify(plan, null, 2) + "\n";
  bounded(text);
  assertWritingMergeActive(signal);
  return { plan, text };
}

/** Standalone syntax/integrity only: membership still requires the original analysis. */
export async function parseWritingMergePlan(
  text: string,
  signal?: AbortSignal,
): Promise<WritingMergePlan> {
  assertWritingMergeActive(signal);
  bounded(text);
  const raw = exact(readCollectionJson(text), PLAN_FIELDS);
  if (
    raw.format !== FORMAT ||
    raw.version !== 1 ||
    raw.algorithm !== WRITING_MERGE_ALGORITHM
  ) {
    throw new Error("不是支持的合并计划版本或算法。");
  }
  const createdAt = timestamp(raw.createdAt);
  if (
    typeof raw.analysisKey !== "string" ||
    !SHA256.test(raw.analysisKey) ||
    typeof raw.digest !== "string" ||
    !SHA256.test(raw.digest)
  ) {
    throw new Error("合并计划的分析摘要或校验摘要无效。");
  }
  const sources = sourceReferences(raw.sources);
  if (
    (await collectionChecksum(
      { algorithm: WRITING_MERGE_ALGORITHM, sources },
      signal,
    )) !== raw.analysisKey
  ) {
    throw new Error("合并计划的分析摘要与来源摘要不一致。");
  }
  if (!Array.isArray(raw.decisions) || raw.decisions.length > 406)
    throw new Error("合并取舍数量无效。");
  const decisions: WritingMergeDecision[] = [];
  const seen = new Set<string>();
  const fields = [
    "field:title",
    "field:summary",
    "field:locale",
    "field:workType",
    "root",
  ];
  let lastField = -1,
    lastEnd = -1;
  for (const value of raw.decisions) {
    const item = exact(value, ["unit", "choice"]);
    if (
      typeof item.unit !== "string" ||
      !MERGE_CHOICES.includes(item.choice as WritingMergeDecision["choice"]) ||
      seen.has(item.unit)
    ) {
      throw new Error("合并取舍引用了无效或重复条目或选项。");
    }
    const field = fields.indexOf(item.unit);
    if (field >= 0) {
      if (lastEnd >= 0 || field <= lastField)
        throw new Error("合并计划条目顺序无效。");
      lastField = field;
    } else {
      const match = /^body:(0|[1-9]\d{0,2}):(0|[1-9]\d{0,2})$/.exec(item.unit);
      const start = Number(match?.[1]),
        end = Number(match?.[2]);
      if (!match || start > end || end > 200 || start < lastEnd)
        throw new Error("合并取舍正文条目无效或顺序重叠。");
      lastEnd = end;
    }
    seen.add(item.unit);
    decisions.push({
      unit: item.unit,
      choice: item.choice as WritingMergeDecision["choice"],
    });
  }
  const payload = {
    format: FORMAT,
    version: 1,
    algorithm: WRITING_MERGE_ALGORITHM,
    createdAt,
    analysisKey: raw.analysisKey,
    sources,
    decisions,
  } as const;
  if ((await collectionChecksum(payload, signal)) !== raw.digest)
    throw new Error("合并计划摘要不匹配，未接纳任何人工取舍。");
  assertWritingMergeActive(signal);
  return { ...payload, digest: raw.digest };
}

/** The caller must separately confirm this preview against its current decision revision. */
export async function previewWritingMergePlan(
  text: string,
  analysis: WritingMergeAnalysis,
  signal?: AbortSignal,
): Promise<WritingMergePlanPreview> {
  const plan = await parseWritingMergePlan(text, signal);
  // This still includes roles and the complete validated backups, not filenames.
  if (
    plan.analysisKey !== analysis.key ||
    MERGE_ROLES.some((role) => plan.sources[role] !== analysis.sources[role])
  ) {
    throw new Error("合并计划的来源或角色已经变化，旧计划不能用于这三份文件。");
  }
  const decisions = validateWritingMergeDecisions(analysis, plan.decisions);
  if (
    collectionCanonicalJson(decisions) !==
    collectionCanonicalJson(plan.decisions)
  ) {
    throw new Error("合并计划条目顺序无效，请用工作台重新导出计划。");
  }
  const selected = new Set(decisions.map((item) => item.unit));
  const unresolved = analysis.units.filter(
    (unit) => unit.status === "conflict" && !selected.has(unit.id),
  ).length;
  assertWritingMergeActive(signal);
  return {
    analysisKey: analysis.key,
    decisions,
    plan,
    manual: decisions.length,
    unresolved,
  };
}
