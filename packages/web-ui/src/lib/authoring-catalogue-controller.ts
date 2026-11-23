import { catalogueSelectionFingerprint } from "./authoring-catalogue-review.ts";
import { readCatalogueEditions, type CatalogueInspection } from "./authoring-catalogue-versions.ts";
import { AUTHORING_EXPECTED_ACTOR_HEADER, isRecord, parseRetryAfterSeconds } from "@bot-thk/web-http";
import { apiErrorCode } from "./api-error.ts";
import { CatalogueDocumentReader, CatalogueReadError } from "./authoring-catalogue-open.ts";
import { CATALOGUE_SELECTION_LIMIT, DEFAULT_CATALOGUE_FILTERS, catalogueEntryKey, catalogueFilterKey, catalogueRequestPath, readCataloguePage, readCatalogueEntry, validateCatalogueFilters,
  type CatalogueEntry, type CatalogueFilters, type CataloguePage } from "./authoring-catalogue.ts";

type CatalogueFetch = (url: string, init?: RequestInit) => Promise<Response>;
/**
 * The three whole-work writes a catalogue row can start. Each affects every
 * edition of the work, so each is asked first (`workIntent`) and, once
 * confirmed, holds the one write lock (`writing`) until it is settled.
 */
export type CatalogueWorkAction = "restore" | "withdraw" | "delete";
export const CATALOGUE_WORK_ACTION_LABEL: Record<CatalogueWorkAction, string> = { restore: "还原", withdraw: "撤销发布", delete: "删除" };
type WorkIntent = { kind: CatalogueWorkAction; entry: CatalogueEntry; actor: string; version: number };
/** A whole-work action that stopped before its write was sent: nothing changed, so it is not "unconfirmed". */
class WorkNotSent extends Error {}
export type CatalogueState = {
  status: "idle" | "loading" | "ready" | "failed" | "unauthenticated" | "account-changed";
  actor: string | null; filters: CatalogueFilters; page: CataloguePage | null; pageIndex: number;
  selected: CatalogueEntry[]; error: string; notice: string; retryAt: number;
  writing: CatalogueWorkAction | null; workIntent: WorkIntent | null; inspection: CatalogueInspection | null;
};

/** One memory-only private view. Cancellation invalidates intent even if fetch ignores AbortSignal. */
export class CatalogueController {
  private state: CatalogueState = { status: "idle", actor: null, filters: { ...DEFAULT_CATALOGUE_FILTERS }, page: null,
    pageIndex: 0, selected: [], error: "", notice: "", retryAt: 0, writing: null, workIntent: null, inspection: null };
  private listeners = new Set<() => void>();
  private generation = 0;
  private abort: AbortController | null = null;
  private trail: (string | null)[] = [null];
  private pageFilters = "";
  private identityVersion = 0;
  private identityAbort: AbortController | null = null;
  private fetcher: CatalogueFetch;
  private now: () => number;

  constructor(fetcher: CatalogueFetch = (url, init) => fetch(url, init), now: () => number = Date.now) {
    this.fetcher = fetcher;
    this.now = now;
  }
  getSnapshot = (): CatalogueState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private publish(patch: Partial<CatalogueState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private begin(): { version: number; signal: AbortSignal } {
    this.abort?.abort();
    this.abort = new AbortController();
    return { version: ++this.generation, signal: this.abort.signal };
  }
  disconnect() {
    this.generation++; this.abort?.abort();
    this.identityVersion++;
    this.identityAbort?.abort();
    this.identityAbort = null;
  }
  suspend() {
    const uncertain = this.state.writing;
    this.disconnect();
    this.trail = [null];
    this.pageFilters = "";
    this.publish({ status: "idle", actor: null, page: null, selected: [], pageIndex: 0, filters: { ...DEFAULT_CATALOGUE_FILTERS },
      writing: null, workIntent: null, inspection: null, error: "",
      notice: uncertain ? `离开页面时${CATALOGUE_WORK_ACTION_LABEL[uncertain]}尚未确认；不会重放请求，返回后请重新核对目录。` : "离开页面后已清除私有目录与选择，请重新确认账户。" });
  }
  async verifyAccount(): Promise<void> {
    const actor = this.state.actor;
    if (!actor || this.state.writing || this.identityAbort || this.now() < this.state.retryAt) return;
    const version = ++this.identityVersion;
    this.identityAbort = new AbortController();
    const current = () => version === this.identityVersion && this.state.actor === actor;
    try {
      const response = await this.fetcher("/api/authoring/session", { credentials: "same-origin", cache: "no-store", signal: this.identityAbort.signal });
      if (!current()) return;
      const payload: unknown = await response.json().catch(() => null);
      if (!current()) return;
      if (response.status === 401) { this.refuseAccount("unauthenticated"); return; }
      const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
      if (response.ok && typeof data?.id === "string" && data.id !== actor) { this.refuseAccount("account-changed"); return; }
      if (response.ok && data?.id === actor) return;
      if (response.status === 429) this.respectReadCooldown(this.now() + (parseRetryAfterSeconds(response.headers.get("retry-after"), this.now()) ?? 1) * 1000);
      if (this.state.writing) return;
      this.begin();
      this.publish({ status: "failed", page: null, selected: [], workIntent: null, inspection: null, error: "暂时无法重新核验账户，旧目录已隐藏；请手动刷新核对，未修改作品。" });
    } catch {
      if (current() && !this.state.writing) {
        this.begin();
        this.publish({ status: "failed", page: null, selected: [], workIntent: null, inspection: null, error: "账户核验连接失败，旧目录已隐藏；请手动重试。" });
      }
    } finally {
      if (version === this.identityVersion) this.identityAbort = null;
    }
  }
  private headers(actor: string): HeadersInit { return { accept: "application/json", [AUTHORING_EXPECTED_ACTOR_HEADER]: encodeURIComponent(actor) }; }
  private forget(status: "unauthenticated" | "account-changed") {
    this.identityVersion++;
    this.identityAbort?.abort();
    this.identityAbort = null;
    this.trail = [null];
    this.pageFilters = "";
    this.publish({ status, actor: null, page: null, pageIndex: 0, selected: [], workIntent: null, writing: null, inspection: null,
      error: status === "account-changed" ? "登录账户已改变，原账户目录已清除。请确认当前账户后重新载入。" : "登录状态已失效，请先登录后重新载入目录。" });
  }
  private async refused(response: Response, version: number, writing: CatalogueWorkAction | null = null): Promise<void> {
    const payload: unknown = await response.json().catch(() => null);
    if (version !== this.generation) return;
    if (response.status === 401) { this.forget("unauthenticated"); return; }
    if (apiErrorCode(payload) === "ACCOUNT_CHANGED") { this.forget("account-changed"); return; }
    const seconds = response.status === 429 ? parseRetryAfterSeconds(response.headers.get("retry-after"), this.now()) ?? 1 : 0;
    this.publish({ status: "failed", writing: null, workIntent: null,
      retryAt: seconds ? Math.max(this.state.retryAt, this.now() + seconds * 1000) : this.state.retryAt,
      error: writing === "withdraw" && response.status === 409 ? "作品在核对之后又被修改过，没有撤销发布；请刷新目录，核对后再试。" :
        writing ? `${CATALOGUE_WORK_ACTION_LABEL[writing]}请求未获成功确认，请刷新目录核对；没有自动重试，也没有移除原选择。` : response.status === 429 ? "请求过于频繁，请等待后手动重试；没有自动重复请求。" : response.status === 400 ? "筛选或分页位置已失效，请重新开始检索。" : "目录暂时无法载入。保留的上次结果不是当前确认结果，请刷新核对。" });
  }
  private coolingDown(): boolean {
    if (this.now() >= this.state.retryAt) return false;
    this.publish({ notice: "仍在 Retry-After 等待期内；没有发送新请求。" });
    return true;
  }

  async connect(): Promise<void> {
    if (this.state.writing || this.coolingDown()) return;
    this.identityVersion++;
    this.identityAbort?.abort();
    this.identityAbort = null;
    const task = this.begin();
    this.publish({ status: "loading", page: null, selected: [], workIntent: null, inspection: null, error: "", notice: "" });
    try {
      const response = await this.fetcher("/api/authoring/session", { credentials: "same-origin", cache: "no-store", signal: task.signal });
      if (task.version !== this.generation) return;
      if (!response.ok) { await this.refused(response, task.version); return; }
      const payload: unknown = await response.json();
      if (task.version !== this.generation) return;
      const data = isRecord(payload) ? payload.data : null;
      const actor = isRecord(data) ? data.id : null;
      if (typeof actor !== "string" || !actor || actor.length > 300 || actor.trim() !== actor || /[\u0000-\u001f\u007f]/u.test(actor)) throw new Error("无法确认当前账户，未读取作品目录。");
      this.trail = [null];
      this.publish({ actor, pageIndex: 0 });
      await this.loadPage(null, 0, [null]);
    } catch (error) {
      if (task.version === this.generation) this.publish({ status: "failed", error: error instanceof Error ? error.message : "无法验证账户，请重试。" });
    }
  }

  private async loadPage(cursor: string | null, pageIndex: number, trail: (string | null)[]): Promise<void> {
    const actor = this.state.actor;
    if (!actor || this.state.writing || this.coolingDown()) return;
    const filters = { ...this.state.filters };
    const task = this.begin();
    this.publish({ status: "loading", error: "", notice: "", workIntent: null, inspection: null });
    try {
      const response = await this.fetcher(catalogueRequestPath(filters, cursor), {
        credentials: "same-origin", cache: "no-store", headers: this.headers(actor), signal: task.signal,
      });
      if (task.version !== this.generation) return;
      if (!response.ok) { await this.refused(response, task.version); return; }
      const payload: unknown = await response.json();
      if (task.version !== this.generation || this.state.actor !== actor) return;
      const page = readCataloguePage(isRecord(payload) ? payload.data : null);
      if (page.items.some(entry => (entry.deletedAt !== null) !== (filters.scope === "trash") ||
          filters.locale !== "all" && entry.locale !== filters.locale || filters.status !== "all" && entry.status !== filters.status ||
          filters.workType !== "all" && entry.workType !== filters.workType)) throw new Error("目录返回了不符合筛选范围的条目，请重新检索。");
      this.trail = trail;
      this.pageFilters = catalogueFilterKey(filters);
      const current = new Map(page.items.map(entry => [catalogueEntryKey(entry), entry]));
      this.publish({ status: "ready", page, pageIndex, selected: this.state.selected.map(entry => current.get(catalogueEntryKey(entry)) ?? entry) });
    } catch (error) {
      if (task.version === this.generation) this.publish({ status: "failed", error: error instanceof Error ? error.message : "读取目录失败，请刷新核对。" });
    }
  }

  async apply(raw: CatalogueFilters): Promise<void> {
    if (this.state.writing) return;
    let filters: CatalogueFilters;
    try { filters = validateCatalogueFilters(raw); }
    catch (error) { this.publish({ error: error instanceof Error ? error.message : "筛选条件无效。" }); return; }
    if (catalogueFilterKey(filters) !== catalogueFilterKey(this.state.filters)) {
      this.begin();
      this.trail = [null];
      this.pageFilters = "";
      this.publish({ filters, page: null, pageIndex: 0, selected: [], workIntent: null, inspection: null });
    }
    await this.loadPage(null, 0, [null]);
  }
  async refresh(): Promise<void> {
    if (!this.state.actor) { await this.connect(); return; }
    await this.loadPage(this.trail[this.state.pageIndex] ?? null, this.state.pageIndex, [...this.trail]);
  }
  async restart(): Promise<void> { await this.loadPage(null, 0, [null]); }
  async next(): Promise<void> {
    if (!this.state.page?.nextCursor || this.pageFilters !== catalogueFilterKey(this.state.filters)) return;
    const index = this.state.pageIndex + 1;
    await this.loadPage(this.state.page.nextCursor, index, [...this.trail.slice(0, index), this.state.page.nextCursor]);
  }
  async previous(): Promise<void> {
    if (!this.state.pageIndex || this.pageFilters !== catalogueFilterKey(this.state.filters)) return;
    const index = this.state.pageIndex - 1;
    await this.loadPage(this.trail[index] ?? null, index, this.trail.slice(0, index + 1));
  }
  toggle(entry: CatalogueEntry) {
    if (this.state.status !== "ready" || this.state.writing || !this.state.page?.items.some(row => catalogueEntryKey(row) === catalogueEntryKey(entry))) return;
    const selected = this.state.selected;
    const key = catalogueEntryKey(entry);
    if (selected.some(row => catalogueEntryKey(row) === key)) this.publish({ selected: selected.filter(row => catalogueEntryKey(row) !== key) });
    else if (selected.length < CATALOGUE_SELECTION_LIMIT) {
      const current = this.state.page.items.find(row => catalogueEntryKey(row) === key)!;
      this.publish({ selected: [...selected, current], notice: "" });
    } else this.publish({ notice: "最多选择 100 个语言版本；请先导出或取消部分选择。" });
  }
  selectPage() {
    if (this.state.status !== "ready" || this.state.writing || !this.state.page) return;
    const selected = new Map(this.state.selected.map(entry => [catalogueEntryKey(entry), entry]));
    for (const entry of this.state.page.items) selected.set(catalogueEntryKey(entry), entry);
    if (selected.size > CATALOGUE_SELECTION_LIMIT) { this.publish({ notice: "整页选择将超过 100 个版本，未改变选择。" }); return; }
    this.publish({ selected: [...selected.values()], notice: "" });
  }
  clearSelection() { this.publish({ selected: [] }); }
  removeSelection(key: string) {
    if (this.state.writing) return;
    this.publish({ selected: this.state.selected.filter(entry => catalogueEntryKey(entry) !== key) });
  }
  adoptReviewedSelection(actor: string, fingerprint: string, reviewed: readonly CatalogueEntry[]): boolean {
    if (this.state.status !== "ready" || this.state.writing || this.state.actor !== actor ||
        catalogueSelectionFingerprint(this.state.selected) !== fingerprint || reviewed.length !== this.state.selected.length) return false;
    let entries: CatalogueEntry[];
    try { entries = reviewed.map(readCatalogueEntry); } catch { return false; }
    const keys = new Set(this.state.selected.map(catalogueEntryKey));
    if (new Set(entries.map(catalogueEntryKey)).size !== keys.size || entries.some(entry => !keys.has(catalogueEntryKey(entry)) ||
        (entry.deletedAt !== null) !== (this.state.filters.scope === "trash"))) return false;
    const byKey = new Map(entries.map(entry => [catalogueEntryKey(entry), entry]));
    this.publish({ selected: this.state.selected.map(entry => byKey.get(catalogueEntryKey(entry))!), notice: "已用成功核对的元数据更新所选索引；没有修改服务器作品或自动加入其他语言。" });
    return true;
  }
  refuseAccount = (status: "unauthenticated" | "account-changed") => {
    this.begin();
    this.forget(status);
  };
  respectReadCooldown = (deadline: number) => {
    if (Number.isFinite(deadline) && deadline > this.state.retryAt) this.publish({ retryAt: deadline, notice: "只读核对遇到限流，目录读取也将等待后再手动继续。" });
  };

  async authorizeExport(actor: string, fingerprint: string): Promise<boolean> {
    const selected = this.state.selected;
    const version = this.generation;
    if (this.state.status !== "ready" || this.state.writing || this.state.actor !== actor || this.identityAbort ||
        this.now() < this.state.retryAt || catalogueSelectionFingerprint(selected) !== fingerprint) return false;
    await this.verifyAccount();
    return version === this.generation && this.state.status === "ready" && this.state.actor === actor &&
      !this.state.writing && this.state.selected === selected && catalogueSelectionFingerprint(this.state.selected) === fingerprint;
  }

  /** Ask first: the dialog names the row as it is on the current, reviewed page. */
  private requestWork(kind: CatalogueWorkAction, entry: CatalogueEntry) {
    if (this.state.status !== "ready" || this.state.writing || !this.state.actor) return;
    if (this.state.filters.scope !== (kind === "restore" ? "trash" : "active")) return;
    const current = this.state.page?.items.find(row => catalogueEntryKey(row) === catalogueEntryKey(entry));
    if (!current || kind === "withdraw" && current.status !== "published") return;
    this.publish({ workIntent: { kind, entry: current, actor: this.state.actor, version: this.generation } });
  }
  requestRestore(entry: CatalogueEntry) { this.requestWork("restore", entry); }
  /** 撤销发布: the work becomes a draft in every language; its text and address are kept. */
  requestWithdraw(entry: CatalogueEntry) { this.requestWork("withdraw", entry); }
  /** 删除: every edition moves to the recycle bin, where it can be restored until purged. */
  requestDelete(entry: CatalogueEntry) { this.requestWork("delete", entry); }
  cancelWork() { this.publish({ workIntent: null }); }

  closeInspection() {
    if (!this.state.inspection) return;
    this.begin();
    this.publish({ inspection: null, workIntent: null });
  }
  async inspect(entry: CatalogueEntry): Promise<void> {
    const actor = this.state.actor;
    const source = this.state.page?.items.find(row => catalogueEntryKey(row) === catalogueEntryKey(entry));
    if (this.state.status !== "ready" || this.state.writing || !actor || !source || this.coolingDown()) return;
    const scope = this.state.filters.scope;
    const task = this.begin();
    this.publish({ inspection: { source, status: "loading", editions: [], error: "" }, workIntent: null });
    try {
      const response = await this.fetcher(`/api/authoring/catalogue/${encodeURIComponent(source.id)}/editions?scope=${scope}`, {
        credentials: "same-origin", cache: "no-store", headers: this.headers(actor), signal: task.signal,
      });
      if (task.version !== this.generation) return;
      if (!response.ok) {
        if (response.status !== 404) await this.refused(response, task.version);
        if (task.version === this.generation && this.state.actor === actor) this.publish({ inspection: { source, status: "failed", editions: [], error: "此作品的版本暂时无法确认，可能已移动或删除。请刷新目录核对。" } });
        return;
      }
      const payload: unknown = await response.json();
      if (task.version !== this.generation || this.state.actor !== actor) return;
      const editions = readCatalogueEditions(isRecord(payload) ? payload.data : null, source.id, scope);
      this.publish({ inspection: { source, editions, status: "ready", error: "" } });
    } catch (error) {
      if (task.version === this.generation) this.publish({ inspection: { source, editions: [], status: "failed", error: error instanceof Error ? error.message : "读取语言版本失败。" } });
    }
  }

  /** Run the confirmed intent, if it still belongs to this account and this page. */
  async confirmWork(): Promise<void> {
    const intent = this.state.workIntent;
    if (!intent || this.state.writing || intent.actor !== this.state.actor || intent.version !== this.generation || this.state.status !== "ready" || this.coolingDown()) return;
    const task = this.begin();
    this.publish({ writing: intent.kind, workIntent: null, inspection: null, notice: "", error: "" });
    try {
      const settled = intent.kind === "restore" ? await this.restore(intent, task)
        : intent.kind === "withdraw" ? await this.withdraw(intent, task) : await this.remove(intent, task);
      if (settled === null) return;
      // A restored or deleted work leaves this scope; a withdrawn one stays and
      // its selected rows are refreshed by the reload below.
      this.publish({ writing: null, selected: intent.kind === "withdraw" ? this.state.selected : this.state.selected.filter(entry => entry.id !== intent.entry.id) });
      await this.loadPage(null, 0, [null]);
      if (this.state.actor === intent.actor) this.publish({ notice: this.state.status === "ready" ? `${settled}当前筛选已从第一页重新核对。` : `${settled}但目录未刷新成功，请手动核对。` });
    } catch (error) {
      if (task.version !== this.generation) return;
      if (error instanceof CatalogueReadError && (error.kind === "account-changed" || error.kind === "unauthenticated")) { this.forget(error.kind); return; }
      if (error instanceof CatalogueReadError && error.kind === "limited") this.publish({ retryAt: Math.max(this.state.retryAt, error.retryAt) });
      const label = CATALOGUE_WORK_ACTION_LABEL[intent.kind];
      this.publish({ status: "failed", writing: null, error: error instanceof CatalogueReadError || error instanceof WorkNotSent
        ? `没有${label}：${error.message}`
        : `${label}结果尚未确认，请刷新目录核对；不会自动重试，也没有更改编辑区。` });
    }
  }

  /** Returns the notice for a settled write, or null when a newer task took over (or the refusal is already shown). */
  private async restore(intent: WorkIntent, task: { version: number; signal: AbortSignal }): Promise<string | null> {
    const response = await this.fetcher(`/api/authoring/catalogue/${encodeURIComponent(intent.entry.id)}/restore?locale=${encodeURIComponent(intent.entry.locale)}`, {
      method: "POST", credentials: "same-origin", cache: "no-store", headers: this.headers(intent.actor), signal: task.signal,
    });
    if (task.version !== this.generation) return null;
    if (!response.ok) { await this.refused(response, task.version, "restore"); return null; }
    const payload: unknown = await response.json();
    if (task.version !== this.generation) return null;
    const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
    if (!data || data.id !== intent.entry.id || data.locale !== intent.entry.locale || data.status !== "draft") throw new Error("还原响应无法确认。");
    return `《${intent.entry.title}》已还原为草稿；`;
  }

  /**
   * 撤销发布 is the desk's 「保存草稿」 of the edition exactly as stored: the
   * catalogue row carries no body, so the edition is read first and written
   * back unchanged with `publish: false` and the revision it was read at. A
   * write made in between — another tab, an import — is refused (409) instead
   * of overwritten, and status is per work, so every language goes dark.
   */
  private async withdraw(intent: WorkIntent, task: { version: number; signal: AbortSignal }): Promise<string | null> {
    let article;
    try {
      article = await new CatalogueDocumentReader(this.fetcher).read({ id: intent.entry.id, locale: intent.entry.locale, actor: intent.actor }, () => task.version === this.generation);
    } catch (error) {
      if (error instanceof CatalogueReadError) throw error;
      throw new WorkNotSent(error instanceof Error ? error.message : "作品详情无法确认。");
    }
    if (!article || task.version !== this.generation) return null;
    if (article.status !== "published") return `《${article.title}》已经是草稿，没有修改；`;
    const response = await this.fetcher(`/api/authoring/articles/${encodeURIComponent(article.id)}`, {
      method: "PUT", credentials: "same-origin", cache: "no-store", signal: task.signal,
      headers: { ...this.headers(intent.actor), "content-type": "application/json" },
      body: JSON.stringify({ slug: article.slug, expectedRevision: article.revision, title: article.title, summary: article.summary,
        locale: article.locale, workType: article.workType, contentBlocks: article.contentBlocks, contentBlocksVersion: article.contentBlocksVersion, publish: false }),
    });
    if (task.version !== this.generation) return null;
    if (!response.ok) { await this.refused(response, task.version, "withdraw"); return null; }
    const payload: unknown = await response.json();
    if (task.version !== this.generation) return null;
    const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
    if (!data || data.id !== article.id || data.status !== "draft") throw new Error("撤销发布响应无法确认。");
    return `《${article.title}》已撤销发布：全部语言版本转为草稿，读者不能再访问；内容保留，重新发布即恢复同一地址。`;
  }

  /** 删除 moves every edition to the recycle bin; the API keeps it restorable until the purge. */
  private async remove(intent: WorkIntent, task: { version: number; signal: AbortSignal }): Promise<string | null> {
    const response = await this.fetcher(`/api/authoring/articles/${encodeURIComponent(intent.entry.id)}`, {
      method: "DELETE", credentials: "same-origin", cache: "no-store", headers: this.headers(intent.actor), signal: task.signal,
    });
    if (task.version !== this.generation) return null;
    if (!response.ok) { await this.refused(response, task.version, "delete"); return null; }
    return `《${intent.entry.title}》已删除（全部语言版本），可在回收站还原；`;
  }
}
