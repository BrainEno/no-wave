import { collectionRows, collectionSourcesKey, selectedCollectionRows, type CollectionRow, type CollectionSource } from "./writing-collection-index.ts";
import { previewWritingReplacement, writingMatchAnchors, type WritingMatch, type WritingSearchScope } from "./writing-replace.ts";

export type CollectionSearch = { text: string; caseSensitive: boolean; scope: WritingSearchScope; source: "all" | "left" | "right" | "selected" };
export type CollectionSearchHit = { id: string; rowId: string; digest: string; match: WritingMatch };
export type CollectionSearchResult = {
  sourceKey: string; query: CollectionSearch; matches: CollectionSearchHit[]; total: number; scanned: number; remaining: number;
  limited: boolean; skipped: { rowId: string; reason: string }[];
};
export const DEFAULT_COLLECTION_SEARCH: CollectionSearch = { text: "", caseSensitive: true, scope: "all", source: "all" };
export const COLLECTION_SEARCH_LIMIT = 100;

export function validateCollectionSearch(query: CollectionSearch): CollectionSearch {
  if (typeof query.text !== "string" || query.text.length > 200 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\p{Cs}]/u.test(query.text) ||
      typeof query.caseSensitive !== "boolean" || !["all", "paragraphs", "headings", "quotes", "lists"].includes(query.scope) ||
      !["all", "left", "right", "selected"].includes(query.source)) throw new Error("正文检索条件无效，字面文字最多 200 字符。");
  return { ...query };
}
function abortSearch(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("正文检索已停止。", "AbortError");
}

/** Reuse the single-draft literal finder; the collection layer owns only scope, global budget and cancellation. */
export async function searchWritingCollection(sources: readonly CollectionSource[], selected: readonly string[], raw: CollectionSearch, signal?: AbortSignal,
  pause: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 0))): Promise<CollectionSearchResult> {
  const query = validateCollectionSearch(raw);
  if (!query.text) throw new Error("请输入正文检索文字；不会用空条件扫描全部正文。");
  const allRows = collectionRows(sources);
  const rows = query.source === "selected" ? selectedCollectionRows(allRows, selected) : allRows.filter(row => query.source === "all" || row.slot === query.source);
  if (!rows.length) throw new Error("指定检索范围没有文稿，请选择已校验来源或明确勾选文稿。");
  const result: CollectionSearchResult = { sourceKey: collectionSourcesKey(sources), query, matches: [], total: rows.length, scanned: 0, remaining: rows.length, limited: false, skipped: [] };
  for (const row of rows) {
    abortSearch(signal);
    await pause();
    abortSearch(signal);
    const preview = previewWritingReplacement(row.entry.backup.draft, query.text, "", query.caseSensitive, query.scope);
    result.scanned++;
    result.remaining--;
    if (preview.error) {
      result.skipped.push({ rowId: row.id, reason: preview.error });
      continue;
    }
    const capacity = COLLECTION_SEARCH_LIMIT - result.matches.length;
    for (const match of preview.matches.slice(0, capacity)) result.matches.push({ id: `${row.id}:${match.id}`, rowId: row.id, digest: row.entry.digest, match });
    result.limited ||= preview.more || preview.matches.length > capacity;
    if (result.matches.length === COLLECTION_SEARCH_LIMIT) {
      result.limited ||= result.remaining > 0;
      break;
    }
  }
  abortSearch(signal);
  result.limited ||= result.skipped.length > 0;
  return result;
}

/** A hit is a navigation witness, not an edit instruction. Changed input must be searched again. */
export function resolveCollectionSearchMatch(sources: readonly CollectionSource[], result: CollectionSearchResult, id: string): { row: CollectionRow; match: WritingMatch } {
  if (result.sourceKey !== collectionSourcesKey(sources)) throw new Error("检索来源文件已经变化，请重新检索。");
  const hit = result.matches.find(item => item.id === id);
  const row = hit ? collectionRows(sources).find(item => item.id === hit.rowId) : null;
  if (!hit || !row || row.entry.digest !== hit.digest || !writingMatchAnchors(row.entry.backup.draft, hit.match)) throw new Error("匹配位置已失效，未定位其他文稿。");
  return { row, match: hit.match };
}
