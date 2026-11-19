import {
  createWritingBackup,
  MAX_WRITING_BACKUP_BYTES,
  parseWritingBackup,
  type WritingBackup,
} from "./writing-backup.ts";
import {
  collectionCanonicalJson,
  collectionChecksum,
  readCollectionJson,
} from "./writing-collection.ts";
import {
  inspectWriting,
  writingRecord,
  type WritingInspection,
  type WritingNode,
} from "./writing-document.ts";
import type { WritingDraft } from "./writing-session.ts";
import {
  verifyWritingMergeOutput,
  verifyWritingMergePartition,
  writingMergeRootAttributes,
} from "./writing-merge-integrity.ts";

export const MERGE_ROLES = ["base", "current", "incoming"] as const;
export const MERGE_CHOICES = ["base", "current", "incoming"] as const;
export const WRITING_MERGE_ALGORITHM = "exact-block-diff3-v1";
export type WritingMergeRole = (typeof MERGE_ROLES)[number];
export type WritingMergeChoice = (typeof MERGE_CHOICES)[number];
export type WritingMergeSources = Record<WritingMergeRole, WritingBackup>;
export type WritingMergeDecision = { unit: string; choice: WritingMergeChoice };
export type WritingMergeStatus =
  "same" | "current" | "incoming" | "agreed" | "conflict";
export type WritingMergeField = "title" | "summary" | "locale" | "workType";
type Alternatives<T> = Record<WritingMergeRole, T>;
type Unit<T> = {
  id: string;
  values: Alternatives<T>;
  status: WritingMergeStatus;
  recommended: WritingMergeChoice | null;
  reason: "exact" | "overlap" | "ambiguous-order";
};
export type WritingMergeUnit =
  | (Unit<string> & { kind: "field"; field: WritingMergeField })
  | (Unit<WritingNode> & { kind: "root" })
  | (Unit<WritingNode[]> & { kind: "body"; start: number; end: number });
export type WritingMergeAnalysis = {
  algorithm: typeof WRITING_MERGE_ALGORITHM;
  key: string;
  sources: Record<WritingMergeRole, string>;
  coverage: Record<WritingMergeRole, number>;
  units: WritingMergeUnit[];
};
export type PreparedWritingMerge = {
  analysisKey: string;
  decisionsKey: string;
  backup: WritingBackup;
  text: string;
  digest: string;
  bytes: number;
  inspection: WritingInspection;
};
type Hunk = {
  start: number;
  end: number;
  nodes: WritingNode[];
  side: "current" | "incoming";
};
const FIELDS: WritingMergeField[] = ["title", "summary", "locale", "workType"];

export function assertWritingMergeActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("本机合并已取消。", "AbortError");
}

/** The stricter collection scanner rejects duplicate/escaped keys before native parsing loses them. */
export function parseWritingMergeSource(text: string): WritingBackup {
  if (
    !text.length ||
    text.length > MAX_WRITING_BACKUP_BYTES ||
    new TextEncoder().encode(text).byteLength > MAX_WRITING_BACKUP_BYTES
  ) {
    throw new Error("每份合并来源须大于 0 且不超过 2 MiB。");
  }
  readCollectionJson(text);
  return parseWritingBackup(text);
}

function classify<T>(
  values: Alternatives<T>,
): Pick<Unit<T>, "status" | "recommended" | "reason"> {
  const base = collectionCanonicalJson(values.base);
  const current = collectionCanonicalJson(values.current);
  const incoming = collectionCanonicalJson(values.incoming);
  if (base === current && base === incoming)
    return { status: "same", recommended: "base", reason: "exact" };
  if (current === incoming)
    return { status: "agreed", recommended: "current", reason: "exact" };
  if (base === incoming)
    return { status: "current", recommended: "current", reason: "exact" };
  if (base === current)
    return { status: "incoming", recommended: "incoming", reason: "exact" };
  return { status: "conflict", recommended: null, reason: "overlap" };
}

function reordered(base: string[], side: string[]): boolean {
  const positions = new Map(base.map((key, index) => [key, index]));
  let previous = -1;
  for (const key of side) {
    const index = positions.get(key);
    if (index === undefined) continue;
    if (index <= previous) return true;
    previous = index;
  }
  return false;
}

/** No changed-block similarity or move matching: only complete, unique, exact anchors. */
function changes(
  base: WritingNode[],
  side: WritingNode[],
  sideName: Hunk["side"],
): Hunk[] {
  const a = base.map(collectionCanonicalJson),
    b = side.map(collectionCanonicalJson);
  const width = b.length + 1;
  const table = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? 1 + table[(i + 1) * width + j + 1]!
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const anchors: [number, number][] = [];
  let i = 0,
    j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      anchors.push([i++, j++]);
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) i++;
    else j++;
  }
  anchors.push([base.length, side.length]);
  const hunks: Hunk[] = [];
  let fromBase = 0,
    fromSide = 0;
  for (const [toBase, toSide] of anchors) {
    if (toBase > fromBase || toSide > fromSide) {
      hunks.push({
        start: fromBase,
        end: toBase,
        nodes: side.slice(fromSide, toSide),
        side: sideName,
      });
    }
    fromBase = toBase + 1;
    fromSide = toSide + 1;
  }
  return hunks;
}

function touches(a: Hunk, b: Hunk): boolean {
  if (a.start === a.end) return a.start >= b.start && a.start <= b.end;
  if (b.start === b.end) return b.start >= a.start && b.start <= a.end;
  return a.start < b.end && b.start < a.end;
}

/** At most 400 bounded intervals. Transitive overlaps must be resolved together. */
function overlappingGroups(hunks: Hunk[]): Hunk[][] {
  const parents = hunks.map((_, index) => index);
  const find = (index: number): number => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]!]!;
      index = parents[index]!;
    }
    return index;
  };
  for (let i = 0; i < hunks.length; i++) {
    for (let j = i + 1; j < hunks.length; j++) {
      if (touches(hunks[i]!, hunks[j]!)) parents[find(j)] = find(i);
    }
  }
  const groups = new Map<number, Hunk[]>();
  hunks.forEach((hunk, index) => {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(hunk);
    groups.set(root, group);
  });
  return [...groups.values()].sort(
    (a, b) =>
      Math.min(...a.map((hunk) => hunk.start)) -
      Math.min(...b.map((hunk) => hunk.start)),
  );
}

function project(
  base: WritingNode[],
  group: Hunk[],
  side: Hunk["side"],
  start: number,
  end: number,
): WritingNode[] {
  const nodes: WritingNode[] = [];
  let cursor = start;
  for (const hunk of group
    .filter((hunk) => hunk.side === side)
    .sort((a, b) => a.start - b.start)) {
    if (hunk.start < cursor)
      throw new Error("合并区间内部重叠，未生成猜测结果。");
    nodes.push(...base.slice(cursor, hunk.start), ...hunk.nodes);
    cursor = hunk.end;
  }
  nodes.push(...base.slice(cursor, end));
  return nodes;
}

function bodyUnits(sources: WritingMergeSources): WritingMergeUnit[] {
  const values = Object.fromEntries(
    MERGE_ROLES.map((role) => [
      role,
      sources[role].draft.editorState!.root.children,
    ]),
  ) as Alternatives<WritingNode[]>;
  const entire = classify(values);
  const count = values.base.length;
  if (entire.status !== "conflict") {
    return [
      {
        id: `body:0:${count}`,
        kind: "body",
        start: 0,
        end: count,
        values,
        ...entire,
      },
    ];
  }
  const keys = MERGE_ROLES.map((role) =>
    values[role].map(collectionCanonicalJson),
  );
  const ambiguous =
    keys.some((items) => new Set(items).size !== items.length) ||
    reordered(keys[0]!, keys[1]!) ||
    reordered(keys[0]!, keys[2]!);
  if (ambiguous) {
    return [
      {
        id: `body:0:${count}`,
        kind: "body",
        start: 0,
        end: count,
        values,
        ...entire,
        reason: "ambiguous-order",
      },
    ];
  }
  const hunks = [
    ...changes(values.base, values.current, "current"),
    ...changes(values.base, values.incoming, "incoming"),
  ];
  const units: WritingMergeUnit[] = [];
  let cursor = 0;
  for (const group of overlappingGroups(hunks)) {
    const start = Math.min(...group.map((hunk) => hunk.start));
    const end = Math.max(...group.map((hunk) => hunk.end));
    if (start < cursor) throw new Error("合并组顺序无效，未跳过任何正文。");
    if (cursor < start) {
      const unchanged = values.base.slice(cursor, start);
      const same = { base: unchanged, current: unchanged, incoming: unchanged };
      units.push({
        id: `body:${cursor}:${start}`,
        kind: "body",
        start: cursor,
        end: start,
        values: same,
        ...classify(same),
      });
    }
    const alternatives = {
      base: values.base.slice(start, end),
      current: project(values.base, group, "current", start, end),
      incoming: project(values.base, group, "incoming", start, end),
    };
    units.push({
      id: `body:${start}:${end}`,
      kind: "body",
      start,
      end,
      values: alternatives,
      ...classify(alternatives),
    });
    cursor = end;
  }
  if (cursor < count) {
    const remaining = values.base.slice(cursor);
    const same = { base: remaining, current: remaining, incoming: remaining };
    units.push({
      id: `body:${cursor}:${count}`,
      kind: "body",
      start: cursor,
      end: count,
      values: same,
      ...classify(same),
    });
  }
  return units;
}

/** Detaches every source, binds its full envelope and role, and returns no partial analysis. */
export async function analyzeWritingMerge(
  input: WritingMergeSources,
  signal?: AbortSignal,
  pause: () => Promise<void> = () => Promise.resolve(),
): Promise<WritingMergeAnalysis> {
  assertWritingMergeActive(signal);
  const sources = {} as WritingMergeSources;
  const digests = {} as Record<WritingMergeRole, string>;
  for (const role of MERGE_ROLES) {
    await pause();
    assertWritingMergeActive(signal);
    sources[role] = parseWritingMergeSource(JSON.stringify(input[role]));
    digests[role] = await collectionChecksum(sources[role], signal);
  }
  const units: WritingMergeUnit[] = [];
  for (const field of FIELDS) {
    const values = {
      base: sources.base.draft[field],
      current: sources.current.draft[field],
      incoming: sources.incoming.draft[field],
    };
    units.push({
      id: `field:${field}`,
      kind: "field",
      field,
      values,
      ...classify(values),
    });
  }
  const roots = {
    base: writingMergeRootAttributes(sources.base),
    current: writingMergeRootAttributes(sources.current),
    incoming: writingMergeRootAttributes(sources.incoming),
  };
  units.push({ id: "root", kind: "root", values: roots, ...classify(roots) });
  await pause();
  assertWritingMergeActive(signal);
  units.push(...bodyUnits(sources));
  const coverage = verifyWritingMergePartition(sources, units);
  const key = await collectionChecksum(
    { algorithm: WRITING_MERGE_ALGORITHM, sources: digests },
    signal,
  );
  assertWritingMergeActive(signal);
  return {
    algorithm: WRITING_MERGE_ALGORITHM,
    key,
    sources: digests,
    coverage,
    units,
  };
}

/** Decisions contain references and closed-set choices, never user-supplied output nodes. */
export function validateWritingMergeDecisions(
  analysis: WritingMergeAnalysis,
  raw: unknown,
): WritingMergeDecision[] {
  if (!Array.isArray(raw) || raw.length > analysis.units.length)
    throw new Error("合并取舍数量无效。");
  const known = new Set(analysis.units.map((unit) => unit.id));
  const byUnit = new Map<string, WritingMergeChoice>();
  for (const item of raw) {
    const record = writingRecord(item);
    if (
      !record ||
      Object.keys(record).length !== 2 ||
      !Object.hasOwn(record, "unit") ||
      !Object.hasOwn(record, "choice")
    )
      throw new Error("合并取舍字段或结构无效。");
    if (
      typeof record.unit !== "string" ||
      !known.has(record.unit) ||
      !MERGE_CHOICES.includes(record.choice as WritingMergeChoice)
    )
      throw new Error("合并取舍引用了无效条目或选项。");
    if (byUnit.has(record.unit)) throw new Error("合并取舍包含重复条目。");
    byUnit.set(record.unit, record.choice as WritingMergeChoice);
  }
  return analysis.units.flatMap((unit) =>
    byUnit.has(unit.id)
      ? [{ unit: unit.id, choice: byUnit.get(unit.id)! }]
      : [],
  );
}

export function writingMergeDecisionsKey(
  analysis: WritingMergeAnalysis,
  decisions: unknown,
): string {
  return JSON.stringify(validateWritingMergeDecisions(analysis, decisions));
}

export function writingMergeProgress(
  analysis: WritingMergeAnalysis,
  decisions: readonly WritingMergeDecision[],
) {
  const selected = new Set(
    validateWritingMergeDecisions(analysis, decisions).map((item) => item.unit),
  );
  let conflicts = 0,
    unresolved = 0,
    changed = 0;
  for (const unit of analysis.units) {
    if (unit.status !== "same") changed++;
    if (unit.status === "conflict") {
      conflicts++;
      if (!selected.has(unit.id)) unresolved++;
    }
  }
  return {
    total: analysis.units.length,
    conflicts,
    unresolved,
    changed,
    manual: selected.size,
  };
}

/** Rebuild only from the validated alternatives, then enforce the ENTIRE existing backup contract. */
export async function prepareWritingMerge(
  analysis: WritingMergeAnalysis,
  raw: readonly WritingMergeDecision[],
  now = new Date(),
  signal?: AbortSignal,
): Promise<PreparedWritingMerge> {
  assertWritingMergeActive(signal);
  const decisions = validateWritingMergeDecisions(analysis, raw);
  const choices = new Map(decisions.map((item) => [item.unit, item.choice]));
  const draft: WritingDraft = {
    title: "",
    summary: "",
    locale: "",
    workType: "other",
    editorState: null,
  };
  let root: WritingNode | null = null;
  const children: WritingNode[] = [];
  for (const unit of analysis.units) {
    const choice = choices.get(unit.id) ?? unit.recommended;
    if (!choice) throw new Error("仍有未明确取舍的冲突，未生成可下载文稿。");
    const value = structuredClone(unit.values[choice]);
    if (unit.kind === "body") children.push(...(value as WritingNode[]));
    else if (unit.kind === "root") root = value as WritingNode;
    else Object.assign(draft, { [unit.field]: value });
  }
  if (!root) throw new Error("合并结果缺少正文根结构。");
  draft.editorState = { root: { ...root, children } };
  const text = createWritingBackup(draft, now);
  const backup = parseWritingMergeSource(text);
  verifyWritingMergeOutput(analysis, decisions, backup);
  const digest = await collectionChecksum(backup, signal);
  assertWritingMergeActive(signal);
  return {
    analysisKey: analysis.key,
    decisionsKey: writingMergeDecisionsKey(analysis, decisions),
    backup,
    text,
    digest,
    bytes: new TextEncoder().encode(text).byteLength,
    inspection: inspectWriting(backup.draft),
  };
}

/** Display only: no HTML, editor import, media element or navigable link is produced. */
export function writingMergeCandidateText(
  unit: WritingMergeUnit,
  role: WritingMergeRole,
): string {
  if (unit.kind === "field") return unit.values[role];
  if (unit.kind === "root") return collectionCanonicalJson(unit.values[role]);
  const parts: string[] = [];
  for (const node of unit.values[role]) {
    if (node.type === "image") {
      parts.push(
        `[图片] ${String(node.alt ?? "")}\n${String(node.caption ?? "")}\n${String(node.src ?? "")}`,
      );
    } else {
      const draft: WritingDraft = {
        title: "预览",
        summary: "",
        locale: "zh-CN",
        workType: "other",
        editorState: { root: { type: "root", version: 1, children: [node] } },
      };
      parts.push(
        inspectWriting(draft)
          .blocks.map((block) => block.text)
          .join("\n"),
      );
    }
  }
  return parts.join("\n\n");
}
