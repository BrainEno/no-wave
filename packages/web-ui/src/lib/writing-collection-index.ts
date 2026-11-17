import { createWritingBackup, exportWritingText, parseWritingBackup, writingDownloadName } from "./writing-backup.ts";
import { compareWritingDrafts, type WritingComparison } from "./writing-compare.ts";
import { writingDraftKey } from "./writing-session.ts";
import { parseWorkType } from "./work-types.ts";
import { COLLECTION_DOCUMENT_LIMIT, createWritingCollection, type CollectionEntry, type OpenedCollection, type PreparedCollection } from "./writing-collection.ts";

export type CollectionSlot = "left" | "right";
export type CollectionSource = { slot: CollectionSlot; name: string; opened: OpenedCollection };
export type CollectionRow = { id: string; slot: CollectionSlot; name: string; group: string; entry: CollectionEntry; position: number };
export type CollectionFilters = { q: string; locale: string; workType: string; slot: "all" | CollectionSlot; onlySelected: boolean; sort: "file" | "title" | "locale" };
export type CollectionPair = { left: string; right: string };
export type CollectionPairResult = { pair: CollectionPair; left: CollectionRow; right: CollectionRow; equivalent: boolean; comparison: WritingComparison };
export type CollectionArtifact = { text: string; name: string; mime: string };
export type CollectionSubsetPlan = { fingerprint: string; rows: CollectionRow[]; groups: number; equivalents: string[][] };
export type PreparedCollectionSubset = { plan: CollectionSubsetPlan; prepared: PreparedCollection };
export const DEFAULT_COLLECTION_FILTERS: CollectionFilters = { q: "", locale: "all", workType: "all", slot: "all", onlySelected: false, sort: "file" };
const titleOrder = new Intl.Collator("zh-Hans", { numeric: true, sensitivity: "variant" });
const SLOT_ORDER: CollectionSlot[] = ["left", "right"];

export function collectionRows(sources: readonly CollectionSource[]): CollectionRow[] {
  if (sources.length > 2 || new Set(sources.map(source => source.slot)).size !== sources.length || sources.some(source => !SLOT_ORDER.includes(source.slot))) throw new Error("集合来源重复或无效。");
  const rows: CollectionRow[] = [];
  for (const slot of SLOT_ORDER) {
    const source = sources.find(item => item.slot === slot);
    if (!source) continue;
    for (const entry of source.opened.prepared.collection.entries) {
      rows.push({ id: `${slot}:${entry.key}`, slot, name: source.name, group: `${slot}:${entry.group}`, entry, position: rows.length });
    }
  }
  return rows;
}

export function validateCollectionFilters(raw: CollectionFilters): CollectionFilters {
  const filters = { ...raw, q: raw.q.trim() };
  if (filters.q.length > 120 || /[\u0000-\u001f\u007f\p{Cs}]/u.test(filters.q) || !["all", "zh-CN", "zh-TW", "en"].includes(filters.locale) ||
      filters.workType !== "all" && !parseWorkType(filters.workType) || !["all", "left", "right"].includes(filters.slot) ||
      !["file", "title", "locale"].includes(filters.sort) || typeof filters.onlySelected !== "boolean") throw new Error("本机筛选条件无效，文字最多 120 字符。");
  return filters;
}
export function filterCollectionRows(rows: readonly CollectionRow[], raw: CollectionFilters, selected: readonly string[]): CollectionRow[] {
  const filters = validateCollectionFilters(raw);
  const chosen = new Set(selected);
  const result = rows.filter(row => {
    const draft = row.entry.backup.draft;
    return (!filters.q || draft.title.includes(filters.q) || draft.summary.includes(filters.q)) &&
      (filters.locale === "all" || draft.locale === filters.locale) && (filters.workType === "all" || draft.workType === filters.workType) &&
      (filters.slot === "all" || row.slot === filters.slot) && (!filters.onlySelected || chosen.has(row.id));
  });
  if (filters.sort !== "file") result.sort((left, right) => {
    const primary = filters.sort === "title" ? titleOrder.compare(left.entry.backup.draft.title, right.entry.backup.draft.title) : left.entry.backup.draft.locale.localeCompare(right.entry.backup.draft.locale);
    return primary || left.position - right.position;
  });
  return result;
}

/** A missing key invalidates the whole intent; never quietly export a smaller subset. */
export function selectedCollectionRows(rows: readonly CollectionRow[], keys: readonly string[]): CollectionRow[] {
  if (!keys.length || keys.length > COLLECTION_DOCUMENT_LIMIT || new Set(keys).size !== keys.length) throw new Error("请选择 1–20 篇不重复的文稿。");
  const allKeys = new Set(rows.map(row => row.id));
  if (keys.some(key => !allKeys.has(key))) throw new Error("所选来源已经变化，请重新选择；没有自动删除缺失条目。");
  const chosen = new Set(keys);
  return rows.filter(row => chosen.has(row.id));
}
export function collectionSourcesKey(sources: readonly CollectionSource[]): string {
  return JSON.stringify(SLOT_ORDER.map(slot => {
    const source = sources.find(item => item.slot === slot);
    return source ? [slot, source.opened.source, source.opened.prepared.collection.digest] : [slot, null];
  }));
}
export function planCollectionSubset(sources: readonly CollectionSource[], selected: readonly string[]): CollectionSubsetPlan {
  const rows = selectedCollectionRows(collectionRows(sources), selected);
  const sameDraft = new Map<string, string[]>();
  for (const row of rows) {
    const key = writingDraftKey(row.entry.backup.draft);
    const entries = sameDraft.get(key) ?? [];
    entries.push(row.id);
    sameDraft.set(key, entries);
  }
  const fingerprint = JSON.stringify([collectionSourcesKey(sources), rows.map(row => [row.id, row.entry.digest])]);
  return { fingerprint, rows, groups: new Set(rows.map(row => row.group)).size, equivalents: [...sameDraft.values()].filter(keys => keys.length > 1) };
}
export async function prepareCollectionSubset(sources: readonly CollectionSource[], selected: readonly string[], now = new Date(), signal?: AbortSignal): Promise<PreparedCollectionSubset> {
  const plan = planCollectionSubset(sources, selected);
  const prepared = await createWritingCollection(plan.rows.map(row => ({ group: row.group, backup: row.entry.backup })), now, signal);
  return { plan, prepared };
}

/** Validation remains the same as ordinary writing-tool restore; no identity or revision is exported. */
export function collectionSingleDownload(row: CollectionRow, format: "json" | "text" | "markdown"): CollectionArtifact {
  if (!["json", "text", "markdown"].includes(format)) throw new Error("不支持的单篇导出格式。");
  const backup = parseWritingBackup(JSON.stringify(row.entry.backup));
  const text = format === "json" ? createWritingBackup(backup.draft, new Date(backup.createdAt)) : exportWritingText(backup.draft, format);
  const extension = format === "json" ? "json" : format === "text" ? "txt" : "md";
  return { text, name: writingDownloadName(backup.draft.title, extension, new Date(backup.createdAt)), mime: format === "json" ? "application/json;charset=utf-8" : "text/plain;charset=utf-8" };
}

export function collectionPairKey(pair: CollectionPair): string { return `${pair.left}|${pair.right}`; }
export function validateCollectionPairs(rows: readonly CollectionRow[], pairs: readonly CollectionPair[]): void {
  if (!pairs.length || pairs.length > COLLECTION_DOCUMENT_LIMIT) throw new Error("请明确选择 1–20 对文稿进行比较。");
  const usedLeft = new Set<string>(), usedRight = new Set<string>();
  for (const pair of pairs) {
    if (!rows.some(row => row.slot === "left" && row.id === pair.left) || !rows.some(row => row.slot === "right" && row.id === pair.right) || usedLeft.has(pair.left) || usedRight.has(pair.right)) throw new Error("配对必须为两份当前文件中的左右各一篇，每篇只能使用一次。");
    usedLeft.add(pair.left); usedRight.add(pair.right);
  }
}
export function compareCollectionPair(rows: readonly CollectionRow[], pair: CollectionPair): CollectionPairResult {
  validateCollectionPairs(rows, [pair]);
  const left = rows.find(row => row.id === pair.left)!;
  const right = rows.find(row => row.id === pair.right)!;
  return { pair: { ...pair }, left, right, equivalent: writingDraftKey(left.entry.backup.draft) === writingDraftKey(right.entry.backup.draft),
    comparison: compareWritingDrafts(left.entry.backup.draft, right.entry.backup.draft) };
}
export function unpairedCollectionRows(rows: readonly CollectionRow[], pairs: readonly CollectionPair[]): CollectionRow[] {
  if (pairs.length) validateCollectionPairs(rows, pairs);
  const paired = new Set(pairs.flatMap(pair => [pair.left, pair.right]));
  return rows.filter(row => !paired.has(row.id));
}
