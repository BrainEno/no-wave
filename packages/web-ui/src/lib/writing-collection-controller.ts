import { COLLECTION_BYTE_LIMIT, openWritingCollection, type OpenedCollection } from "./writing-collection.ts";
import { readCollectionFile } from "./writing-collection-browser.ts";
import { COLLECTION_DOCUMENT_LIMIT } from "./writing-collection.ts";
import { collectionPairKey, collectionRows, collectionSingleDownload, collectionSourcesKey, compareCollectionPair, DEFAULT_COLLECTION_FILTERS, filterCollectionRows, planCollectionSubset, prepareCollectionSubset, validateCollectionFilters, validateCollectionPairs,
  type CollectionArtifact, type CollectionFilters, type CollectionPair, type CollectionPairResult, type CollectionSlot, type CollectionSource, type PreparedCollectionSubset } from "./writing-collection-index.ts";

import { DEFAULT_COLLECTION_SEARCH, resolveCollectionSearchMatch, searchWritingCollection, validateCollectionSearch, type CollectionSearch, type CollectionSearchResult } from "./writing-collection-search.ts";
import { buildCollectionReviewReport, COLLECTION_REVIEW_PLAN_BYTES, collectionReviewReportDownload, createCollectionReviewPlan, previewCollectionReviewPlan, type CollectionReviewPreview } from "./writing-collection-review.ts";

import { collectCollectionReferences, resolveCollectionReference, type CollectionReferenceResult } from "./writing-collection-references.ts";

type SlotState = { status: "idle" | "reading" | "checking" | "ready" | "failed"; name: string; percent: number; opened: OpenedCollection | null; error: string };
export type CollectionWorkbenchState = {
  slots: Record<CollectionSlot, SlotState>; filters: CollectionFilters; selected: string[]; pairs: CollectionPair[];
  comparisons: CollectionPairResult[]; comparisonStatus: "idle" | "running" | "cancelled" | "complete";
  preparing: boolean; prepared: PreparedCollectionSubset | null; error: string;
  search: CollectionSearch; searchStatus: "idle" | "running" | "complete" | "cancelled"; searchResult: CollectionSearchResult | null;
  reviewLoading: boolean; reviewPreview: CollectionReviewPreview | null;
  referenceScope: "all" | "selected"; referenceStatus: "idle" | "running" | "cancelled" | "complete"; references: CollectionReferenceResult | null;
};
type WorkbenchOptions = {
  read?: (file: File, signal: AbortSignal, progress: (percent: number) => void) => Promise<string>;
  open?: (text: string, signal: AbortSignal) => Promise<OpenedCollection>;
  pause?: () => Promise<void>; now?: () => Date;
};
const emptySlot = (): SlotState => ({ status: "idle", name: "", percent: 0, opened: null, error: "" });
const SLOTS: CollectionSlot[] = ["left", "right"];

/** The only stateful owner of local files; every asynchronous action has an independently fenced intent. */
export class WritingCollectionWorkbench {
  private state: CollectionWorkbenchState = { slots: { left: emptySlot(), right: emptySlot() }, filters: { ...DEFAULT_COLLECTION_FILTERS }, selected: [], pairs: [], comparisons: [], comparisonStatus: "idle", preparing: false, prepared: null, error: "", search: { ...DEFAULT_COLLECTION_SEARCH }, searchStatus: "idle", searchResult: null, reviewLoading: false, reviewPreview: null, referenceScope: "all", referenceStatus: "idle", references: null };
  private listeners = new Set<() => void>();
  private reads: Record<CollectionSlot, AbortController | null> = { left: null, right: null };
  private prepareAbort: AbortController | null = null;
  private comparisonVersion = 0;
  private searchAbort: AbortController | null = null;
  private reviewAbort: AbortController | null = null;
  private reviewVersion = 0;
  private referenceAbort: AbortController | null = null;
  private options: Required<WorkbenchOptions>;
  constructor(options: WorkbenchOptions = {}) {
    this.options = { read: options.read ?? readCollectionFile, open: options.open ?? openWritingCollection, pause: options.pause ?? (() => new Promise(resolve => setTimeout(resolve, 0))), now: options.now ?? (() => new Date()) };
  }
  getSnapshot = (): CollectionWorkbenchState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private publish(patch: Partial<CollectionWorkbenchState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private updateSlot(slot: CollectionSlot, patch: Partial<SlotState>) {
    this.publish({ slots: { ...this.state.slots, [slot]: { ...this.state.slots[slot], ...patch } } });
  }
  getSources(): CollectionSource[] {
    return SLOTS.flatMap(slot => {
      const source = this.state.slots[slot];
      return source.status === "ready" && source.opened ? [{ slot, name: source.name, opened: source.opened }] : [];
    });
  }
  getVisibleRows() { return filterCollectionRows(collectionRows(this.getSources()), this.state.filters, this.state.selected); }
  private invalidatePrepared() {
    this.prepareAbort?.abort(); this.prepareAbort = null;
    this.publish({ prepared: null, preparing: false });
  }
  private invalidateComparison() {
    this.comparisonVersion++;
    this.publish({ comparisons: [], comparisonStatus: "idle" });
  }
  clear(slot?: CollectionSlot) {
    this.invalidatePrepared(); this.invalidateComparison(); this.invalidateSearch(); this.invalidateReferences(); this.invalidateReview();
    const targets = slot ? [slot] : SLOTS;
    const slots = { ...this.state.slots };
    for (const target of targets) { this.reads[target]?.abort(); this.reads[target] = null; slots[target] = emptySlot(); }
    this.publish({ slots, selected: slot ? this.state.selected.filter(key => !key.startsWith(`${slot}:`)) : [],
      pairs: slot ? this.state.pairs.filter(pair => !pair.left.startsWith(`${slot}:`) && !pair.right.startsWith(`${slot}:`)) : [],
      filters: slot ? this.state.filters : { ...DEFAULT_COLLECTION_FILTERS }, search: slot ? this.state.search : { ...DEFAULT_COLLECTION_SEARCH }, referenceScope: slot ? this.state.referenceScope : "all", error: "" });
  }
  async load(slot: CollectionSlot, file: File): Promise<void> {
    if (!SLOTS.includes(slot)) return;
    this.clear(slot);
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > COLLECTION_BYTE_LIMIT) {
      this.updateSlot(slot, { status: "failed", error: "文件须大于 0 且不超过 16 MiB，未读取文件。" }); return;
    }
    const abort = new AbortController(); this.reads[slot] = abort;
    const current = () => this.reads[slot] === abort && !abort.signal.aborted;
    const name = file.name.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 240);
    this.updateSlot(slot, { status: "reading", name, error: "" });
    try {
      const text = await this.options.read(file, abort.signal, percent => { if (current()) this.updateSlot(slot, { percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0 }); });
      if (!current()) return;
      this.updateSlot(slot, { status: "checking", percent: 100 });
      const opened = await this.options.open(text, abort.signal);
      if (!current()) return;
      // Loading the other slot may have completed while SHA-256 was running.
      this.invalidatePrepared(); this.invalidateComparison(); this.invalidateSearch(); this.invalidateReferences(); this.invalidateReview();
      this.updateSlot(slot, { status: "ready", opened, error: "" });
    } catch (error) {
      if (current()) this.updateSlot(slot, { status: "failed", opened: null, error: error instanceof Error ? error.message : "文件校验失败，没有载入部分结果。" });
    }
  }
  setFilters(raw: CollectionFilters) {
    try { this.publish({ filters: validateCollectionFilters(raw), error: "" }); }
    catch (error) { this.publish({ error: error instanceof Error ? error.message : "筛选无效。" }); }
  }
  toggleSelection(id: string) {
    if (!collectionRows(this.getSources()).some(row => row.id === id)) { this.publish({ error: "所选文稿已变化，请重新选择。" }); return; }
    const selected = this.state.selected.includes(id) ? this.state.selected.filter(key => key !== id) : [...this.state.selected, id];
    if (selected.length > COLLECTION_DOCUMENT_LIMIT) { this.publish({ error: "最多选择 20 篇；没有部分改变原选择。" }); return; }
    this.invalidatePrepared(); this.invalidateSearch(); this.invalidateReferences(); this.invalidateReview(); this.publish({ selected, error: "" });
  }
  selectVisible() {
    const selected = [...new Set([...this.state.selected, ...this.getVisibleRows().map(row => row.id)])];
    if (selected.length > COLLECTION_DOCUMENT_LIMIT) { this.publish({ error: "显示项合并后超过 20 篇；原选择未改变。" }); return; }
    this.invalidatePrepared(); this.invalidateSearch(); this.invalidateReferences(); this.invalidateReview(); this.publish({ selected, error: "" });
  }
  clearSelection() { this.invalidatePrepared(); this.invalidateSearch(); this.invalidateReferences(); this.invalidateReview(); this.publish({ selected: [], error: "" }); }
  cancelPreparation() { this.invalidatePrepared(); }
  async prepareSubset(): Promise<void> {
    this.invalidatePrepared();
    const abort = new AbortController(); this.prepareAbort = abort;
    const sources = this.getSources(), selected = [...this.state.selected];
    const current = () => this.prepareAbort === abort && !abort.signal.aborted;
    this.publish({ preparing: true, error: "" });
    try {
      const result = await prepareCollectionSubset(sources, selected, this.options.now(), abort.signal);
      if (!current()) return;
      if (result.plan.fingerprint !== planCollectionSubset(this.getSources(), this.state.selected).fingerprint) throw new Error("输入或选择已变化，旧准备结果没有替换当前结果。");
      this.publish({ prepared: result, preparing: false });
    } catch (error) {
      if (current()) this.publish({ preparing: false, prepared: null, error: error instanceof Error ? error.message : "准备子集失败。" });
    }
  }
  subsetDownload(): CollectionArtifact {
    const report = this.state.prepared;
    if (!report || this.state.preparing || report.plan.fingerprint !== planCollectionSubset(this.getSources(), this.state.selected).fingerprint) throw new Error("下载预检已过期，请重新准备当前选择。");
    return { text: report.prepared.text, name: `no-wave-collection-${report.prepared.collection.createdAt.slice(0, 10)}.json`, mime: "application/json;charset=utf-8" };
  }
  singleDownload(id: string, format: "json" | "text" | "markdown"): CollectionArtifact {
    const row = collectionRows(this.getSources()).find(item => item.id === id);
    if (!row) throw new Error("来源文件已变化，未导出旧文稿。");
    return collectionSingleDownload(row, format);
  }
  addPair(left: string, right: string, witness: string) {
    try {
      if (witness !== collectionSourcesKey(this.getSources())) throw new Error("来源文件已经变化，请重新选择左右文稿。");
      const pairs = [...this.state.pairs, { left, right }];
      validateCollectionPairs(collectionRows(this.getSources()), pairs);
      this.invalidateComparison(); this.invalidateReview(); this.publish({ pairs, error: "" });
    } catch (error) { this.publish({ error: error instanceof Error ? error.message : "配对无效。" }); }
  }
  removePair(key: string) {
    this.invalidateComparison(); this.invalidateReview(); this.publish({ pairs: this.state.pairs.filter(pair => collectionPairKey(pair) !== key), error: "" });
  }
  cancelComparison() {
    this.comparisonVersion++;
    this.publish({ comparisonStatus: "cancelled" });
  }
  async compare(): Promise<void> {
    const version = ++this.comparisonVersion;
    const sources = this.getSources(), rows = collectionRows(sources), pairs = this.state.pairs.map(pair => ({ ...pair }));
    const witness = JSON.stringify([collectionSourcesKey(sources), pairs]);
    const current = () => version === this.comparisonVersion && witness === JSON.stringify([collectionSourcesKey(this.getSources()), this.state.pairs]);
    try {
      validateCollectionPairs(rows, pairs);
      this.publish({ comparisons: [], comparisonStatus: "running", error: "" });
      for (const pair of pairs) {
        await this.options.pause();
        if (!current()) return;
        const comparison = compareCollectionPair(rows, pair);
        this.publish({ comparisons: [...this.state.comparisons, comparison] });
      }
      if (current()) this.publish({ comparisonStatus: "complete" });
    } catch (error) {
      if (current()) this.publish({ comparisonStatus: "cancelled", error: error instanceof Error ? error.message : "比较失败，文稿没有被更改。" });
    }
  }
  private invalidateSearch() {
    this.searchAbort?.abort(); this.searchAbort = null;
    this.publish({ searchResult: null, searchStatus: "idle" });
  }
  setSearch(raw: CollectionSearch) {
    try {
      const search = validateCollectionSearch(raw);
      this.invalidateSearch(); this.publish({ search, error: "" });
    } catch (error) { this.publish({ error: error instanceof Error ? error.message : "正文检索条件无效。" }); }
  }
  cancelSearch() {
    this.searchAbort?.abort(); this.searchAbort = null;
    this.publish({ searchResult: null, searchStatus: "cancelled" });
  }
  async runSearch(): Promise<void> {
    this.invalidateSearch();
    const abort = new AbortController(); this.searchAbort = abort;
    const current = () => this.searchAbort === abort && !abort.signal.aborted;
    this.publish({ searchStatus: "running", error: "" });
    try {
      const result = await searchWritingCollection(this.getSources(), this.state.selected, this.state.search, abort.signal, this.options.pause);
      if (current()) this.publish({ searchResult: result, searchStatus: "complete" });
    } catch (error) {
      if (current()) this.publish({ searchResult: null, searchStatus: "cancelled", error: error instanceof Error ? error.message : "正文检索失败，未更改文件。" });
    }
  }
  searchMatch(id: string, expected: CollectionSearchResult | null) {
    if (this.state.searchStatus !== "complete" || !this.state.searchResult || this.state.searchResult !== expected) throw new Error("正文检索已变化，请重新检索后定位。");
    return resolveCollectionSearchMatch(this.getSources(), this.state.searchResult, id);
  }
  private invalidateReview() {
    this.reviewVersion++;
    this.reviewAbort?.abort(); this.reviewAbort = null;
    this.publish({ reviewLoading: false, reviewPreview: null });
  }
  async loadReviewPlan(file: File): Promise<void> {
    this.invalidateReview();
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > COLLECTION_REVIEW_PLAN_BYTES) {
      this.publish({ error: "核对计划须大于 0 且不超过 64 KiB，未读取文件。" }); return;
    }
    const abort = new AbortController(); this.reviewAbort = abort;
    const current = () => this.reviewAbort === abort && !abort.signal.aborted;
    const sources = this.getSources();
    this.publish({ reviewLoading: true, error: "" });
    try {
      const text = await this.options.read(file, abort.signal, () => {});
      if (!current()) return;
      const reviewPreview = await previewCollectionReviewPlan(text, sources, abort.signal);
      if (current()) this.publish({ reviewPreview, reviewLoading: false });
    } catch (error) {
      if (current()) this.publish({ reviewLoading: false, reviewPreview: null, error: error instanceof Error ? error.message : "核对计划未通过校验。" });
    }
  }
  cancelReviewPlan() { this.invalidateReview(); }
  applyReviewPlan(expected: CollectionReviewPreview | null) {
    const preview = this.state.reviewPreview;
    if (!preview || preview !== expected || preview.sourceKey !== collectionSourcesKey(this.getSources())) throw new Error("核对计划预览已失效，请重新读取；没有改变选择或配对。");
    const selected = [...preview.plan.selected], pairs = preview.plan.pairs.map(pair => ({ ...pair }));
    this.invalidatePrepared(); this.invalidateComparison(); this.invalidateSearch(); this.invalidateReferences(); this.invalidateReview();
    this.publish({ selected, pairs, error: "" });
  }
  async reviewPlanDownload(): Promise<CollectionArtifact> {
    const sources = this.getSources(), sourceKey = collectionSourcesKey(sources), version = this.reviewVersion;
    const prepared = await createCollectionReviewPlan(sources, this.state.selected, this.state.pairs, this.options.now());
    if (version !== this.reviewVersion || sourceKey !== collectionSourcesKey(this.getSources())) throw new Error("来源或本机选择/配对已经变化，旧核对计划已取消下载。");
    return { text: prepared.text, name: `no-wave-review-plan-${prepared.plan.createdAt.slice(0, 10)}.json`, mime: "application/json;charset=utf-8" };
  }
  reviewReportDownload(format: "json" | "csv", includeLabels: boolean): CollectionArtifact {
    const report = buildCollectionReviewReport(this.getSources(), this.state.pairs, this.state.comparisons, this.state.comparisonStatus, includeLabels, this.options.now());
    return collectionReviewReportDownload(report, format);
  }

  private invalidateReferences() {
    this.referenceAbort?.abort(); this.referenceAbort = null;
    this.publish({ referenceStatus: "idle", references: null });
  }
  setReferenceScope(scope: "all" | "selected") {
    if (scope !== "all" && scope !== "selected") { this.publish({ error: "引用范围无效。" }); return; }
    this.invalidateReferences(); this.publish({ referenceScope: scope, error: "" });
  }
  cancelReferences() {
    this.referenceAbort?.abort(); this.referenceAbort = null;
    this.publish({ referenceStatus: "cancelled", references: null });
  }
  async inspectReferences(): Promise<void> {
    this.invalidateReferences();
    const abort = new AbortController(); this.referenceAbort = abort;
    const current = () => this.referenceAbort === abort && !abort.signal.aborted;
    this.publish({ referenceStatus: "running", error: "" });
    try {
      const references = await collectCollectionReferences(this.getSources(), this.state.selected, this.state.referenceScope, abort.signal, this.options.pause);
      if (current()) this.publish({ references, referenceStatus: "complete" });
    } catch (error) {
      if (current()) this.publish({ referenceStatus: "cancelled", error: error instanceof Error ? error.message : "本机引用检查失败。" });
    }
  }
  referenceDocument(id: string, occurrence: number, expected: CollectionReferenceResult | null) {
    if (this.state.referenceStatus !== "complete" || !this.state.references || this.state.references !== expected) throw new Error("本机引用清单已过期，请重新检查。");
    return resolveCollectionReference(this.getSources(), this.state.references, id, occurrence);
  }

}
