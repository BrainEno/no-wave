import { prepareCatalogueCsvValue } from "./authoring-catalogue.ts";
import { inspectWriting } from "./writing-document.ts";
import { collectionChecksum, readCollectionJson } from "./writing-collection.ts";
import { collectionPairKey, collectionRows, collectionSourcesKey, selectedCollectionRows, unpairedCollectionRows, validateCollectionPairs,
  type CollectionArtifact, type CollectionPair, type CollectionPairResult, type CollectionSlot, type CollectionSource } from "./writing-collection-index.ts";

type ReviewSource = { slot: CollectionSlot; source: "single" | "collection"; digest: string };
export type CollectionReviewPlan = { format: "no-wave-collection-review-plan"; version: 1; createdAt: string; sources: ReviewSource[]; selected: string[]; pairs: CollectionPair[]; digest: string };
export type CollectionReviewPreview = { plan: CollectionReviewPlan; sourceKey: string };
export type PreparedCollectionReview = { plan: CollectionReviewPlan; text: string; bytes: number };
export type CollectionComparisonStatus = "idle" | "running" | "cancelled" | "complete";
export type CollectionReviewReport = {
  format: "no-wave-collection-review-report"; version: 1; createdAt: string; labelsIncluded: boolean; status: "not-started" | "partial" | "complete";
  sources: (ReviewSource & { entries: number; filename?: string })[];
  coverage: { documents: number; pairs: number; checkedPairs: number; uncheckedPairs: number; unpairedDocuments: number; limitedDocuments: number; limitedPairs: number };
  documents: { id: string; slot: CollectionSlot; group: string; digest: string; locale: string; workType: string; title?: string;
    statistics: ReturnType<typeof inspectWriting>["statistics"]; limited: boolean; issues: Record<string, number> }[];
  pairs: { left: string; right: string; state: "unchecked" | "equivalent" | "different"; limited: boolean | null;
    counts: CollectionPairResult["comparison"]["counts"] | null; fields: string[];
    changes: { kind: string; leftBlock: number | null; rightBlock: number | null; formatChanged: boolean; truncated: boolean }[] }[];
  unpaired: string[];
};
export const COLLECTION_REVIEW_PLAN_BYTES = 64 * 1024;
const PLAN_FORMAT = "no-wave-collection-review-plan";
const REVIEW_ID = /^(?:left|right):d(?:[1-9]|1\d|20)$/;
const REVIEW_DIGEST = /^[a-f0-9]{64}$/;

function reviewSources(sources: readonly CollectionSource[]): ReviewSource[] {
  collectionRows(sources);
  if (!sources.length) throw new Error("请先载入已校验的本机来源文件。");
  return (["left", "right"] as const).flatMap(slot => {
    const source = sources.find(item => item.slot === slot);
    return source ? [{ slot, source: source.opened.source, digest: source.opened.prepared.collection.digest }] : [];
  });
}
function reviewDate(date: unknown): string {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString() !== date) throw new Error("核对计划时间无效。");
  return date;
}
function reviewRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) throw new Error("核对计划字段缺失、未知或结构无效。");
  return value as Record<string, unknown>;
}
function reviewChoices(sources: readonly CollectionSource[], selected: readonly string[], pairs: readonly CollectionPair[]): void {
  const rows = collectionRows(sources);
  if (!selected.length && !pairs.length) throw new Error("核对计划至少需要一篇明确选择或一对明确配对。");
  if (selected.length) selectedCollectionRows(rows, selected);
  if (pairs.length) validateCollectionPairs(rows, pairs);
}
function reviewPlanBytes(text: string): number {
  if (!text.length || text.length > COLLECTION_REVIEW_PLAN_BYTES) throw new Error("核对计划须大于 0 且不超过 64 KiB。");
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > COLLECTION_REVIEW_PLAN_BYTES) throw new Error("核对计划 UTF-8 超过 64 KiB。");
  return bytes;
}

/** A local convenience file, deliberately not a signed import or an identity/ownership assertion. */
export async function createCollectionReviewPlan(sources: readonly CollectionSource[], selected: readonly string[], pairs: readonly CollectionPair[], now = new Date(), signal?: AbortSignal): Promise<PreparedCollectionReview> {
  const identities = reviewSources(sources);
  reviewChoices(sources, selected, pairs);
  const payload = { format: PLAN_FORMAT as CollectionReviewPlan["format"], version: 1 as const, createdAt: reviewDate(now.toISOString()), sources: identities,
    selected: [...selected], pairs: pairs.map(pair => ({ left: pair.left, right: pair.right })) };
  const plan = { ...payload, digest: await collectionChecksum(payload, signal) };
  const text = JSON.stringify(plan) + "\n";
  return { plan, text, bytes: reviewPlanBytes(text) };
}

export async function previewCollectionReviewPlan(text: string, sources: readonly CollectionSource[], signal?: AbortSignal): Promise<CollectionReviewPreview> {
  reviewPlanBytes(text);
  const value = readCollectionJson(text);
  const record = reviewRecord(value, ["format", "version", "createdAt", "sources", "selected", "pairs", "digest"]);
  if (record.format !== PLAN_FORMAT || record.version !== 1 || typeof record.digest !== "string" || !REVIEW_DIGEST.test(record.digest)) throw new Error("核对计划版本或摘要无效。");
  const createdAt = reviewDate(record.createdAt);
  if (!Array.isArray(record.sources) || record.sources.length < 1 || record.sources.length > 2) throw new Error("核对计划来源数量无效。");
  const identities = record.sources.map(item => {
    const source = reviewRecord(item, ["slot", "source", "digest"]);
    if (source.slot !== "left" && source.slot !== "right" || source.source !== "single" && source.source !== "collection" || typeof source.digest !== "string" || !REVIEW_DIGEST.test(source.digest)) throw new Error("核对计划来源格式无效。");
    return { slot: source.slot, source: source.source, digest: source.digest };
  });
  if (JSON.stringify(identities) !== JSON.stringify(reviewSources(sources))) throw new Error("核对计划与当前左右来源文件不匹配；请手动读取原文件，不会自动加载任何地址。");
  if (!Array.isArray(record.selected) || record.selected.length > 20 || record.selected.some(id => typeof id !== "string" || !REVIEW_ID.test(id)) || !Array.isArray(record.pairs) || record.pairs.length > 20) throw new Error("核对计划选择或配对数量/格式无效。");
  const selected: string[] = record.selected;
  const pairs = record.pairs.map(item => {
    const pair = reviewRecord(item, ["left", "right"]);
    if (typeof pair.left !== "string" || typeof pair.right !== "string" || !REVIEW_ID.test(pair.left) || !REVIEW_ID.test(pair.right)) throw new Error("核对计划配对标识无效。");
    return { left: pair.left, right: pair.right };
  });
  reviewChoices(sources, selected, pairs);
  const payload = { format: PLAN_FORMAT as CollectionReviewPlan["format"], version: 1 as const, createdAt, sources: reviewSources(sources), selected, pairs };
  if (await collectionChecksum(payload, signal) !== record.digest) throw new Error("核对计划摘要不匹配，没有应用任何选择或配对。");
  return { sourceKey: collectionSourcesKey(sources), plan: { ...payload, digest: record.digest } };
}

/** Only content-free facts are copied into the report. Never serialize the result/draft/inspection objects wholesale. */
export function buildCollectionReviewReport(sources: readonly CollectionSource[], pairs: readonly CollectionPair[], results: readonly CollectionPairResult[], status: CollectionComparisonStatus, includeLabels = false, now = new Date()): CollectionReviewReport {
  if (status === "running") throw new Error("比较仍在运行，请先完成或停止，再生成稳定核对报告。");
  if (!["idle", "cancelled", "complete"].includes(status) || typeof includeLabels !== "boolean") throw new Error("核对报告选项无效。");
  const identities = reviewSources(sources), rows = collectionRows(sources);
  if (pairs.length) validateCollectionPairs(rows, pairs);
  if (status === "complete" && results.length !== pairs.length || status === "idle" && results.length) throw new Error("配对比较完成状态与完整结果不匹配，请重新比较。");
  const checked = new Map<string, CollectionPairResult>();
  for (const result of results) {
    const key = collectionPairKey(result.pair);
    const left = rows.find(row => row.id === result.pair.left), right = rows.find(row => row.id === result.pair.right);
    if (checked.has(key) || !pairs.some(pair => collectionPairKey(pair) === key) || !left || !right ||
        result.left.id !== left.id || result.right.id !== right.id || result.left.entry.digest !== left.entry.digest || result.right.entry.digest !== right.entry.digest) throw new Error("比较来源或配对已经变化，未将旧结果写入报告。");
    checked.set(key, result);
  }
  const documents = rows.map(row => {
    const inspection = inspectWriting(row.entry.backup.draft);
    const issues: Record<string, number> = {};
    for (const issue of inspection.issues) issues[issue.code] = (issues[issue.code] ?? 0) + 1;
    return { id: row.id, slot: row.slot, group: row.entry.group, digest: row.entry.digest, locale: row.entry.backup.draft.locale, workType: row.entry.backup.draft.workType,
      ...(includeLabels ? { title: row.entry.backup.draft.title } : {}), statistics: { ...inspection.statistics }, limited: inspection.limited, issues };
  });
  const pairReports = pairs.map(pair => {
    const result = checked.get(collectionPairKey(pair));
    const limited = result ? result.comparison.limited || result.comparison.rows.some(row => row.difference.truncated) || result.comparison.fields.some(field => field.difference.truncated) : null;
    const changes = result ? result.comparison.rows.filter(row => row.kind !== "same").map(row => ({ kind: row.kind,
      leftBlock: row.currentIndex === null ? null : row.currentIndex + 1, rightBlock: row.backupIndex === null ? null : row.backupIndex + 1,
      formatChanged: row.formatChanged, truncated: row.difference.truncated })) : [];
    return { left: pair.left, right: pair.right, state: !result ? "unchecked" as const : result.equivalent ? "equivalent" as const : "different" as const,
      limited, counts: result ? { ...result.comparison.counts } : null, fields: result ? result.comparison.fields.map(field => field.field) : [], changes };
  });
  const unpaired = unpairedCollectionRows(rows, pairs).map(row => row.id);
  const coverage = { documents: documents.length, pairs: pairs.length, checkedPairs: checked.size, uncheckedPairs: pairs.length - checked.size,
    unpairedDocuments: unpaired.length, limitedDocuments: documents.filter(document => document.limited).length, limitedPairs: pairReports.filter(pair => pair.limited).length };
  return { format: "no-wave-collection-review-report", version: 1, createdAt: reviewDate(now.toISOString()), labelsIncluded: includeLabels,
    status: status === "complete" ? "complete" : status === "idle" ? "not-started" : "partial",
    sources: identities.map(identity => ({ ...identity, entries: sources.find(source => source.slot === identity.slot)!.opened.prepared.collection.entries.length,
      ...(includeLabels ? { filename: sources.find(source => source.slot === identity.slot)!.name } : {}) })),
    coverage, documents, pairs: pairReports, unpaired };
}

/** CSV reuses the catalogue's irreversible formula/control protections, including optional private labels. */
export function collectionReviewReportDownload(report: CollectionReviewReport, format: "json" | "csv"): CollectionArtifact {
  if (!["json", "csv"].includes(format)) throw new Error("请选择 JSON 或 CSV 核对报告。");
  const name = `no-wave-review-report-${report.createdAt.slice(0, 10)}.${format}`;
  if (format === "json") return { text: JSON.stringify(report, null, 2) + "\n", name, mime: "application/json;charset=utf-8" };
  const columns = ["section", "id", "slot", "group", "source", "digest", "locale", "workType", ...(report.labelsIncluded ? ["title", "filename"] : []),
    "format", "version", "labelsIncluded", "entries", "characters", "words", "minutes", "blocks", "images", "links", "codeBlocks", "limited", "left", "right", "state",
    "same", "added", "removed", "changed", "moved", "fields", "leftBlock", "rightBlock", "formatChanged", "issue", "occurrences",
    "documents", "pairs", "checkedPairs", "uncheckedPairs", "unpairedDocuments", "limitedDocuments", "limitedPairs"];
  const records: Record<string, string | number | boolean>[] = [{ section: "report", id: report.createdAt, state: report.status,
    format: report.format, version: report.version, labelsIncluded: report.labelsIncluded }, { section: "coverage", ...report.coverage }];
  for (const source of report.sources) records.push({ section: "source", id: source.slot, slot: source.slot, source: source.source, digest: source.digest, entries: source.entries,
    ...(source.filename === undefined ? {} : { filename: source.filename }) });
  for (const document of report.documents) {
    records.push({ section: "document", id: document.id, slot: document.slot, group: document.group, digest: document.digest, locale: document.locale, workType: document.workType,
      ...(document.title === undefined ? {} : { title: document.title }), characters: document.statistics.characters, words: document.statistics.words, minutes: document.statistics.minutes,
      blocks: document.statistics.blocks, images: document.statistics.images, links: document.statistics.links, codeBlocks: document.statistics.codeBlocks, limited: document.limited });
    for (const code of Object.keys(document.issues).sort()) records.push({ section: "issue", id: document.id, issue: code, occurrences: document.issues[code]!, limited: document.limited });
  }
  for (const pair of report.pairs) {
    records.push({ section: "pair", left: pair.left, right: pair.right, state: pair.state, limited: pair.limited ?? "unchecked", ...(pair.counts ?? {}), fields: pair.fields.join(";") });
    for (const change of pair.changes) records.push({ section: "block", left: pair.left, right: pair.right, state: change.kind, leftBlock: change.leftBlock ?? "absent", rightBlock: change.rightBlock ?? "absent",
      formatChanged: change.formatChanged, limited: change.truncated });
  }
  for (const id of report.unpaired) records.push({ section: "unpaired", id, state: "unpaired-not-deleted" });
  const cell = (value: unknown) => `"${prepareCatalogueCsvValue(String(value)).value.replace(/"/g, '""')}"`;
  const csv = "\ufeff" + [columns.map(cell).join(","), ...records.map(record => columns.map(column => cell(record[column] ?? "")).join(","))].join("\r\n") + "\r\n";
  return { text: csv, name, mime: "text/csv;charset=utf-8" };
}
