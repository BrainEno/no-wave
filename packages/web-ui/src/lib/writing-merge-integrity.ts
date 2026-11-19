import type { WritingBackup } from "./writing-backup.ts";
import { collectionCanonicalJson } from "./writing-collection.ts";
import type { WritingNode } from "./writing-document.ts";
import type {
  WritingMergeAnalysis,
  WritingMergeChoice,
  WritingMergeDecision,
  WritingMergeField,
  WritingMergeRole,
  WritingMergeSources,
  WritingMergeUnit,
} from "./writing-merge.ts";

export function writingMergeRootAttributes(backup: WritingBackup): WritingNode {
  const { children: _children, ...attributes } = backup.draft.editorState!.root;
  return attributes;
}
function corrupted(message: string): never {
  throw new Error(`三方守恒校验失败：${message}，没有生成可下载结果。`);
}
function equal(before: unknown, after: unknown): boolean {
  return collectionCanonicalJson(before) === collectionCanonicalJson(after);
}

/** Independent of LCS/interval projection: consume each source as an ordered, lossless stream. */
export function verifyWritingMergePartition(
  sources: WritingMergeSources,
  units: readonly WritingMergeUnit[],
): Record<WritingMergeRole, number> {
  if (!units.length || units.length > 605) corrupted("区间数量无效");
  const consumed: Record<WritingMergeRole, number> = {
    base: 0,
    current: 0,
    incoming: 0,
  };
  const roles = Object.keys(consumed) as WritingMergeRole[];
  const fields = new Set<WritingMergeField>();
  const knownFields: WritingMergeField[] = [
    "title",
    "summary",
    "locale",
    "workType",
  ];
  const seen = new Set<string>();
  let roots = 0;
  for (const unit of units) {
    if (seen.has(unit.id)) corrupted("区间或元数据编号重复");
    seen.add(unit.id);
    if (
      Object.keys(unit.values).length !== roles.length ||
      roles.some((role) => !Object.hasOwn(unit.values, role))
    )
      corrupted("区间缺少完整来源");
    if (unit.kind === "field") {
      if (
        !knownFields.includes(unit.field) ||
        fields.has(unit.field) ||
        unit.id !== `field:${unit.field}`
      )
        corrupted("元数据字段重复或未知");
      for (const role of roles) {
        if (unit.values[role] !== sources[role].draft[unit.field])
          corrupted("来源元数据改变");
      }
      fields.add(unit.field);
      continue;
    }
    if (unit.kind === "root") {
      if (++roots !== 1 || unit.id !== "root") corrupted("根结构重复");
      for (const role of roles) {
        if (
          !equal(unit.values[role], writingMergeRootAttributes(sources[role]))
        )
          corrupted("来源根结构改变");
      }
      continue;
    }
    if (
      unit.kind !== "body" ||
      !Number.isSafeInteger(unit.start) ||
      !Number.isSafeInteger(unit.end) ||
      unit.start !== consumed.base ||
      unit.end < unit.start ||
      unit.end > sources.base.draft.editorState!.root.children.length ||
      unit.id !== `body:${unit.start}:${unit.end}`
    )
      corrupted("基线区间缺失、交叠或乱序");
    if (
      !Array.isArray(unit.values.base) ||
      unit.values.base.length !== unit.end - unit.start
    )
      corrupted("基线区间大小不符");
    if (roles.every((role) => unit.values[role].length === 0))
      corrupted("含无意义的空区间");
    for (const role of roles) {
      const values = unit.values[role];
      if (!Array.isArray(values)) corrupted("来源区间不是正文数组");
      const original = sources[role].draft.editorState!.root.children;
      if (consumed[role] + values.length > original.length)
        corrupted("来源正文被重复消费");
      for (let offset = 0; offset < values.length; offset++) {
        if (!equal(values[offset], original[consumed[role] + offset]))
          corrupted("来源正文丢失、改变或顺序不符");
      }
      consumed[role] += values.length;
    }
  }
  if (roots !== 1 || fields.size !== knownFields.length)
    corrupted("根结构或元数据遗漏");
  for (const role of roles) {
    if (
      consumed[role] !== sources[role].draft.editorState!.root.children.length
    )
      corrupted("尚有来源正文未被完整消费");
  }
  return consumed;
}

/** Check actual serialized output against each selection, not the composition loop's counters. */
export function verifyWritingMergeOutput(
  analysis: WritingMergeAnalysis,
  decisions: readonly WritingMergeDecision[],
  output: WritingBackup,
): void {
  const selected = new Map<string, WritingMergeChoice>();
  for (const decision of decisions) {
    if (
      selected.has(decision.unit) ||
      !analysis.units.some((unit) => unit.id === decision.unit) ||
      !["base", "current", "incoming"].includes(decision.choice)
    )
      corrupted("人工取舍重复或无效");
    selected.set(decision.unit, decision.choice);
  }
  const children = output.draft.editorState?.root.children;
  if (!children) corrupted("输出正文未初始化");
  const fields = new Set<string>();
  let cursor = 0,
    roots = 0;
  for (const unit of analysis.units) {
    const choice = selected.get(unit.id) ?? unit.recommended;
    if (!choice) corrupted("仍有未解决的人工取舍");
    if (unit.kind === "field") {
      if (
        fields.has(unit.field) ||
        output.draft[unit.field] !== unit.values[choice]
      )
        corrupted("输出元数据不符合取舍");
      fields.add(unit.field);
    } else if (unit.kind === "root") {
      if (
        ++roots !== 1 ||
        !equal(writingMergeRootAttributes(output), unit.values[choice])
      )
        corrupted("输出根结构不符合取舍");
    } else {
      const expected = unit.values[choice];
      if (cursor + expected.length > children.length)
        corrupted("输出正文少于人工取舍");
      for (const node of expected) {
        if (!equal(node, children[cursor]))
          corrupted("输出格式、正文或顺序不符合取舍");
        cursor++;
      }
    }
  }
  if (fields.size !== 4 || roots !== 1 || cursor !== children.length)
    corrupted("输出含遗漏或额外内容");
}
