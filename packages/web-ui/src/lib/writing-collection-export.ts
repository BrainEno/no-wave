import { CatalogueDocumentReader, CatalogueReadError } from "./authoring-catalogue-open.ts";
import { catalogueEntryKey, type CatalogueEntry } from "./authoring-catalogue.ts";
import { planCatalogueReview, CATALOGUE_REVIEW_FIELDS } from "./authoring-catalogue-review.ts";
import { articleBlocksToLexicalEditorState } from "./lexical-article-state.ts";
import { createWritingBackup, parseWritingBackup } from "./writing-backup.ts";
import { COLLECTION_DOCUMENT_LIMIT, createWritingCollection, type CollectionDocument, type PreparedCollection } from "./writing-collection.ts";
import type { CollectionArtifact } from "./writing-collection-index.ts";

export type CollectionExportSource = { actor: string | null; ready: boolean; scope: "active" | "trash"; selected: readonly CatalogueEntry[] };
type ExportPlan = { actor: string; sourceSelection: readonly CatalogueEntry[]; selected: readonly CatalogueEntry[]; fingerprint: string; selectionFingerprint: string };
export type CollectionReadProgress = { key: string; title: string; locale: string; changedFields: string[] };
export type CollectionExportState = {
  status: "idle" | "running" | "complete" | "failed" | "cancelled" | "limited" | "refused";
  plan: ExportPlan | null; completed: number; progress: CollectionReadProgress[];
  prepared: PreparedCollection | null; downloading: boolean; retryAt: number; error: string;
};
type ExportOptions = {
  current(): CollectionExportSource; authorize(actor: string, fingerprint: string): Promise<boolean>;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>; now?: () => Date;
  onRefused?: (reason: "account-changed" | "unauthenticated") => void; onLimited?: (deadline: number) => void;
};
export type AuthorizedCollectionArtifact = CollectionArtifact & { current(): boolean };

function planSource(source: CollectionExportSource): ExportPlan {
  if (!source.ready || !source.actor || source.scope !== "active") throw new Error("请先确认在用目录账户；回收站与未确认结果不能读取正文。");
  if (source.selected.length > COLLECTION_DOCUMENT_LIMIT) throw new Error("正文集合最多 20 个语言版本，请减少选择；CSV 索引仍支持 100 个。");
  const plan = planCatalogueReview({ actor: source.actor, scope: source.scope, selected: source.selected });
  return { actor: plan.actor, sourceSelection: source.selected, selected: plan.selected, selectionFingerprint: plan.fingerprint,
    fingerprint: JSON.stringify([plan.actor, plan.scope, plan.fingerprint, plan.selected.map(catalogueEntryKey)]) };
}

/** Sequential read-only export. Neither a partial queue nor a stale session may release a file. */
export class CollectionExportController {
  private state: CollectionExportState = { status: "idle", plan: null, completed: 0, progress: [], prepared: null, downloading: false, retryAt: 0, error: "" };
  private listeners = new Set<() => void>();
  private version = 0;
  private abort: AbortController | null = null;
  private reader: CatalogueDocumentReader;
  private options: ExportOptions;
  constructor(options: ExportOptions) {
    this.options = options;
    this.reader = new CatalogueDocumentReader(options.fetcher);
  }
  getSnapshot = (): CollectionExportState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private publish(patch: Partial<CollectionExportState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private matches(plan: ExportPlan): boolean {
    try { const current = planSource(this.options.current()); return current.sourceSelection === plan.sourceSelection && current.fingerprint === plan.fingerprint; } catch { return false; }
  }
  private stop() { this.version++; this.reader.cancel(); this.abort?.abort(); }
  invalidate() {
    this.stop();
    this.publish({ status: "idle", plan: null, completed: 0, progress: [], prepared: null, downloading: false, error: "" });
  }
  cancel() {
    this.stop();
    this.publish({ status: "cancelled", prepared: null, downloading: false, error: "已停止正文读取；部分进度不是完整备份，没有自动重试。" });
  }
  async start(): Promise<void> {
    if (this.state.status === "running" || this.state.downloading) return;
    if (Date.now() < this.state.retryAt) { this.publish({ status: "limited", error: "仍在 Retry-After 等待期内，没有请求正文。" }); return; }
    let plan: ExportPlan;
    try { plan = planSource(this.options.current()); }
    catch (error) { this.invalidate(); this.publish({ status: "failed", error: error instanceof Error ? error.message : "选择无效。" }); return; }
    this.stop(); this.abort = new AbortController();
    const version = this.version, signal = this.abort.signal;
    const current = () => version === this.version && !signal.aborted && this.matches(plan);
    const stale = () => { if (version === this.version && !this.matches(plan)) this.invalidate(); };
    const documents: CollectionDocument[] = [];
    this.publish({ status: "running", plan, completed: 0, progress: [], prepared: null, error: "" });
    try {
      for (const selected of plan.selected) {
        if (!current()) { stale(); return; }
        const article = await this.reader.read({ actor: plan.actor, id: selected.id, locale: selected.locale }, current);
        if (!current() || !article) { stale(); return; }
        if (article.contentBlocksVersion !== 0 && article.contentBlocksVersion !== 1) throw new Error("正文版本尚不支持无损转换，没有略过或降级此文稿。");
        const now = this.options.now?.() ?? new Date();
        const backup = parseWritingBackup(createWritingBackup({ title: article.title, summary: article.summary, locale: article.locale, workType: article.workType,
          editorState: articleBlocksToLexicalEditorState(article.contentBlocks) }, now));
        documents.push({ group: selected.id, backup });
        const changedFields = CATALOGUE_REVIEW_FIELDS.filter(field => field !== "deletedAt" && selected[field] !== article[field]);
        this.publish({ completed: documents.length, progress: [...this.state.progress, { key: catalogueEntryKey(selected), title: article.title, locale: article.locale, changedFields }] });
      }
      const prepared = await createWritingCollection(documents, this.options.now?.() ?? new Date(), signal);
      if (!current()) { stale(); return; }
      this.publish({ status: "complete", prepared, error: "" });
    } catch (error) {
      if (!current()) { stale(); return; }
      if (error instanceof CatalogueReadError && (error.kind === "account-changed" || error.kind === "unauthenticated")) {
        this.stop();
        this.publish({ status: "refused", plan: null, prepared: null, completed: 0, progress: [], error: "账户或登录状态已变化，已清除本次私有正文及进度，请回目录确认。" });
        this.options.onRefused?.(error.kind); return;
      }
      if (error instanceof CatalogueReadError && error.kind === "limited") {
        const retryAt = Math.max(this.state.retryAt, error.retryAt);
        this.publish({ status: "limited", retryAt, prepared: null, error: "正文请求受限，已停止剩余队列；等待后需手动重新读取，没有自动重试。" });
        this.options.onLimited?.(retryAt); return;
      }
      this.publish({ status: "failed", prepared: null, error: error instanceof Error ? `集合未完成：${error.message}` : "集合未完成；没有略过失败文稿或生成不完整文件。" });
    } finally { documents.length = 0; }
  }
  async authorizedDownload(): Promise<AuthorizedCollectionArtifact | null> {
    const { plan, prepared } = this.state;
    if (this.state.status !== "complete" || this.state.downloading || !plan || !prepared) return null;
    if (!this.matches(plan)) { this.invalidate(); return null; }
    const version = this.version;
    const current = () => version === this.version && this.state.prepared === prepared && this.state.status === "complete" && this.matches(plan);
    this.publish({ downloading: true, error: "" });
    try {
      const allowed = await this.options.authorize(plan.actor, plan.selectionFingerprint);
      if (!current()) { if (version === this.version) this.invalidate(); return null; }
      if (!allowed) { this.publish({ error: "下载账户尚未核验成功；没有生成旧正文文件，请重新确认目录后手动再试。" }); return null; }
      return { text: prepared.text, name: `no-wave-collection-${prepared.collection.createdAt.slice(0, 10)}.json`, mime: "application/json;charset=utf-8", current };
    } catch {
      if (current()) this.publish({ error: "下载账户核验连接失败，没有释放旧正文；请手动核对。" });
      return null;
    } finally { if (version === this.version) this.publish({ downloading: false }); }
  }
}
