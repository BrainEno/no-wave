import { auditWritingReferences, type WritingReferenceIssue } from "./writing-references.ts";
import { collectionRows, collectionSourcesKey, selectedCollectionRows, type CollectionSource } from "./writing-collection-index.ts";
import type { WritingPath } from "./writing-document.ts";

export type CollectionReferenceGroup = { id: string; kind: "link" | "image"; url: string | null; host: string | null; external: boolean; issues: WritingReferenceIssue[];
  uses: { rowId: string; digest: string; path: WritingPath; label: string; caption: string }[] };
export type CollectionReferenceResult = { sourceKey: string; groups: CollectionReferenceGroup[]; total: number; scanned: number; documents: number; remaining: number; incomplete: string[]; limited: boolean };
export type CollectionReferenceFilters = { q: string; kind: "all" | "link" | "image"; slot: "all" | "left" | "right"; location: "all" | "relative" | "external" | "attention" };
export const DEFAULT_COLLECTION_REFERENCE_FILTERS: CollectionReferenceFilters = { q: "", kind: "all", slot: "all", location: "all" };

/** Addresses remain inert data; neither this layer nor the reused per-draft audit performs network I/O. */
export async function collectCollectionReferences(sources: readonly CollectionSource[], selected: readonly string[], scope: "all" | "selected", signal?: AbortSignal,
  pause: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 0))): Promise<CollectionReferenceResult> {
  if (scope !== "all" && scope !== "selected") throw new Error("请选择全部来源或明确选择的引用范围。");
  const rows = scope === "selected" ? selectedCollectionRows(collectionRows(sources), selected) : collectionRows(sources);
  if (!rows.length) throw new Error("没有可检查的引用来源。");
  const report: CollectionReferenceResult = { sourceKey: collectionSourcesKey(sources), groups: [], total: 0, scanned: 0, documents: rows.length, remaining: rows.length, incomplete: [], limited: false };
  const byAddress = new Map<string, CollectionReferenceGroup>();
  const byLabel = new Map<string, Set<CollectionReferenceGroup>>();
  const active = () => { if (signal?.aborted) throw new DOMException("引用清单已取消。", "AbortError"); };
  let exhausted = false;
  for (const row of rows) {
    if (report.total >= 1000 || report.groups.length >= 200) break;
    active(); await pause(); active();
    const audit = auditWritingReferences(row.entry.backup.draft);
    report.scanned++; report.remaining--;
    for (const item of audit.groups) {
      const key = JSON.stringify([item.kind, item.url ?? `${row.id}:${byAddress.size}`]);
      let group = byAddress.get(key);
      if (!group) {
        if (report.groups.length >= 200) { exhausted = true; break; }
        group = { id: `r${report.groups.length + 1}`, kind: item.kind, url: item.url, host: item.url && item.external ? new URL(item.url).host : null,
          external: item.external, issues: [], uses: [] };
        byAddress.set(key, group); report.groups.push(group);
      }
      group.issues = [...new Set([...group.issues, ...item.issues])];
      for (const occurrence of item.occurrences) {
        if (report.total >= 1000) { exhausted = true; break; }
        group.uses.push({ rowId: row.id, digest: row.entry.digest, path: [...occurrence.path], label: occurrence.label, caption: occurrence.caption });
        report.total++;
        if (item.kind === "link" && item.url && occurrence.label && !item.issues.includes("label-truncated")) {
          const label = occurrence.label.normalize("NFKC").replace(/\s+/gu, " ").toLocaleLowerCase();
          const uses = byLabel.get(label) ?? new Set<CollectionReferenceGroup>();
          uses.add(group); byLabel.set(label, uses);
        }
      }
      if (exhausted) break;
    }
    if (audit.limited || exhausted) report.incomplete.push(row.id);
    if (exhausted) break;
  }
  active();
  for (const groups of byLabel.values()) {
    if (groups.size < 2) continue;
    for (const group of groups) if (!group.issues.includes("ambiguous-label")) group.issues.push("ambiguous-label");
  }
  report.limited = report.remaining > 0 || report.incomplete.length > 0;
  return report;
}

export function filterCollectionReferences(report: CollectionReferenceResult, filters: CollectionReferenceFilters): CollectionReferenceGroup[] {
  if (typeof filters.q !== "string" || filters.q.length > 200 || /[\u0000-\u001f\u007f\p{Cs}]/u.test(filters.q) || !["all", "link", "image"].includes(filters.kind) ||
      !["all", "left", "right"].includes(filters.slot) || !["all", "relative", "external", "attention"].includes(filters.location)) throw new Error("引用清单筛选无效，字面文字最多 200 字符。");
  const query = filters.q.trim().toLocaleLowerCase();
  return report.groups.filter(group => (filters.kind === "all" || group.kind === filters.kind) &&
    (filters.slot === "all" || group.uses.some(use => use.rowId.startsWith(`${filters.slot}:`))) &&
    (filters.location === "all" || filters.location === "attention" && group.issues.length > 0 || filters.location === "external" && group.external || filters.location === "relative" && !group.external && group.url !== null) &&
    (!query || (group.url ?? "").toLocaleLowerCase().includes(query) || group.uses.some(use => `${use.label}\n${use.caption}`.toLocaleLowerCase().includes(query))));
}

export function resolveCollectionReference(sources: readonly CollectionSource[], report: CollectionReferenceResult, id: string, occurrence: number) {
  if (report.sourceKey !== collectionSourcesKey(sources)) throw new Error("引用来源已变化，请重新生成本机清单。");
  const group = report.groups.find(item => item.id === id);
  const use = Number.isSafeInteger(occurrence) && occurrence >= 0 ? group?.uses[occurrence] : null;
  const row = use ? collectionRows(sources).find(item => item.id === use.rowId) : null;
  if (!use || !row || row.entry.digest !== use.digest) throw new Error("引用使用处已失效，没有打开其他文稿。");
  return row;
}
