import { flushSync } from "react-dom";
import { bindCatalogueRecovery } from "@/lib/authoring-catalogue-recovery.ts";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "@/lib/framework/link.tsx";
import { ConfirmDialog } from "@/components/ui/confirm-dialog.tsx";
import { CATALOGUE_WORK_ACTION_LABEL, CatalogueController, type CatalogueState } from "@/lib/authoring-catalogue-controller.ts";
import { CATALOGUE_SELECTION_LIMIT, DEFAULT_CATALOGUE_FILTERS, catalogueEntryKey, catalogueFacetCounts, catalogueOpenHref, validateCatalogueFilters, type CatalogueFilters } from "@/lib/authoring-catalogue.ts";
import { getMessages } from "@/lib/content.ts";
import { workTypes } from "@/lib/work-types.ts";
import { catalogueSelectionFingerprint } from "@/lib/authoring-catalogue-review.ts";
import type { CatalogueExport } from "@/lib/authoring-catalogue-export.ts";
import { CatalogueExportPanel } from "./catalogue-export.tsx";
import { CatalogueSelection } from "./catalogue-selection.tsx";
import { CatalogueVersions, catalogueDate, catalogueLocaleLabel } from "./catalogue-versions.tsx";
import { WorkBatchImportPanel } from "./work-batch-import-panel.tsx";
import { WritingCollectionExportPanel } from "./writing-collection-export-panel.tsx";

export function AuthoringCatalogue() {
  const [controller] = useState(() => new CatalogueController());
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [activeTab, setActiveTab] = useState<"works" | "import">("works");
  const [form, setForm] = useState<CatalogueFilters>({ ...DEFAULT_CATALOGUE_FILTERS });
  const [downloadError, setDownloadError] = useState("");
  const [checkingExport, setCheckingExport] = useState(false);
  const [clock, setClock] = useState(0);
  const inspectionTrigger = useRef<HTMLButtonElement | null>(null);
  const outcome = useRef<HTMLDivElement | null>(null);
  const download = useRef<{ url: string; timeout: ReturnType<typeof setTimeout> } | null>(null);
  const labels = getMessages("zh-CN").workTypeLabels;
  const localeCounts = catalogueFacetCounts(state.page?.facets ?? [], "locale");
  const statusCounts = catalogueFacetCounts(state.page?.facets ?? [], "status");
  const typeCounts = catalogueFacetCounts(state.page?.facets ?? [], "workType");
  const remaining = Math.max(0, Math.ceil((state.retryAt - clock) / 1000));
  const writing = state.writing !== null;
  const unavailable = state.status !== "ready" || writing;
  const busy = state.status === "loading" || writing;
  const selected = new Set(state.selected.map(catalogueEntryKey));
  const formChanged = JSON.stringify(form) !== JSON.stringify(state.filters);

  useEffect(() => {
    void controller.connect();
    const release = bindCatalogueRecovery(controller, { window, document, visible: () => document.visibilityState === "visible", flush: flushSync,
      suspend: () => {
        controller.suspend();
        setForm({ ...DEFAULT_CATALOGUE_FILTERS });
        setDownloadError("");
        if (download.current) { clearTimeout(download.current.timeout); URL.revokeObjectURL(download.current.url); download.current = null; }
      },
    });
    return () => { release(); controller.disconnect(); };
  }, [controller]);
  useEffect(() => {
    if (!state.retryAt) return;
    const tick = () => setClock(Date.now());
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [state.retryAt]);
  useEffect(() => () => {
    if (download.current) { clearTimeout(download.current.timeout); URL.revokeObjectURL(download.current.url); }
  }, []);

  function change<K extends keyof CatalogueFilters>(key: K, value: CatalogueFilters[K]) {
    setForm(current => ({ ...current, [key]: value }));
  }
  async function exportSelection(report: CatalogueExport) {
    const snapshot = controller.getSnapshot();
    if (checkingExport || !snapshot.actor || snapshot.status !== "ready" || snapshot.writing !== null || snapshot.actor !== state.actor || formChanged || catalogueSelectionFingerprint(snapshot.selected) !== report.fingerprint) {
      setDownloadError("账户、选择或筛选已变化，旧预览没有触发下载；请重新核对当前选择。");
      return;
    }
    setCheckingExport(true);
    try {
      if (!await controller.authorizeExport(snapshot.actor, report.fingerprint)) throw new Error("账户核验未成功或选择已经变化，没有下载旧索引；请核对目录后再试。");
      const current = controller.getSnapshot();
      const csv = report.csv;
      if (download.current) { clearTimeout(download.current.timeout); URL.revokeObjectURL(download.current.url); }
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `no-wave-${current.filters.scope === "trash" ? "trash" : "catalogue"}-metadata.csv`;
      document.body.append(anchor); anchor.click(); anchor.remove();
      download.current = { url, timeout: setTimeout(() => { URL.revokeObjectURL(url); download.current = null; }, 1000) };
      setDownloadError("");
    } catch (error) { setDownloadError(error instanceof Error ? error.message : "无法生成 CSV，请重新选择。"); }
    finally { setCheckingExport(false); }
  }
  function submit() {
    try { const next = validateCatalogueFilters(form); setForm(next); setDownloadError(""); void controller.apply(next); }
    catch (error) { setDownloadError(error instanceof Error ? error.message : "筛选条件无效。"); }
  }
  function reset() { setForm({ ...DEFAULT_CATALOGUE_FILTERS }); void controller.apply({ ...DEFAULT_CATALOGUE_FILTERS }); }

  return <section className="nw-authoring nw-catalogue" aria-label="全量作品管理">
    <header className="nw-authoring-header">
      <p className="nw-kicker">作品管理 · 全部作品目录</p>
      <h1>作品管理</h1>
      <p>按语言版本浏览全部作品目录，不限最近 100 条；先检索元数据，需要编辑时才读取所选版本正文。亦可通过文档与已有数据接口批量导入作品。</p>
      <div className="nw-authoring-actions">
        <Link className="nw-btn" href="/write">返回写作台</Link>
        <Link className="nw-btn" href="/write">新建作品 +</Link>
        <Link className="nw-btn" href="/write/media">媒体库</Link>
      </div>
      <div className="nw-authoring-actions" style={{ marginTop: 16 }}>
        <button
          className={`nw-btn ${activeTab === "works" ? "nw-pri" : ""}`}
          type="button"
          onClick={() => setActiveTab("works")}
        >
          作品目录与草稿
        </button>
        <button
          className={`nw-btn ${activeTab === "import" ? "nw-pri" : ""}`}
          type="button"
          onClick={() => setActiveTab("import")}
        >
          批量导入与数据接入
        </button>
      </div>
    </header>

    {activeTab === "import" ? (
      <WorkBatchImportPanel onImportComplete={() => void controller.refresh()} />
    ) : (
      <>
    <form className="nw-catalogue-filters" aria-label="目录筛选" onSubmit={event => { event.preventDefault(); submit(); }}>
      <fieldset disabled={writing || checkingExport}>
        <legend>组合筛选</legend>
        <label>标题或摘要<input type="search" value={form.q} maxLength={120} autoComplete="off" spellCheck={false} placeholder="字面、区分大小写；不会写入网址或存储" onChange={event => change("q", event.target.value)} /></label>
        <div className="nw-catalogue-filter-grid">
          <label>目录范围<select value={form.scope} onChange={event => change("scope", event.target.value as CatalogueFilters["scope"])}><option value="active">在用作品</option><option value="trash">回收站</option></select></label>
          <label>语言<select value={form.locale} onChange={event => change("locale", event.target.value)}><option value="all">全部语言</option>{["zh-CN", "en", "zh-TW"].map(locale => <option key={locale} value={locale}>{catalogueLocaleLabel(locale)}（{localeCounts.get(locale) ?? 0}）</option>)}</select></label>
          <label>发布状态<select value={form.status} onChange={event => change("status", event.target.value as CatalogueFilters["status"])}><option value="all">全部状态</option><option value="draft">草稿（{statusCounts.get("draft") ?? 0}）</option><option value="published">已发布（{statusCounts.get("published") ?? 0}）</option></select></label>
          <label>作品类型<select value={form.workType} onChange={event => change("workType", event.target.value)}><option value="all">全部类型</option>{workTypes.map(type => <option key={type} value={type}>{labels[type]}（{typeCounts.get(type) ?? 0}）</option>)}</select></label>
          <label>排序 / 日期依据<select value={form.sort} onChange={event => change("sort", event.target.value as CatalogueFilters["sort"])}><option value="updated">{form.scope === "trash" ? "最近删除" : "版本最近更新"}</option><option value="created">版本最早创建</option></select></label>
          <label>起始日期（含）<input type="date" min="1000-01-01" max="9999-12-30" value={form.from} onChange={event => change("from", event.target.value)} /></label>
          <label>结束日期（含）<input type="date" min="1000-01-01" max="9999-12-30" value={form.until} onChange={event => change("until", event.target.value)} /></label>
          <label>每页版本数<select value={form.limit} onChange={event => change("limit", Number(event.target.value))}>{[10, 20, 50].map(limit => <option key={limit} value={limit}>{limit}</option>)}</select></label>
        </div>
        <p className="nw-m">日期按 UTC 自然日和所选排序字段过滤。分面数来自上次成功请求的范围、搜索与日期，不预先套用语言/状态/类型；提交后更新。</p>
        <div className="nw-authoring-actions"><button className="nw-btn" type="submit" disabled={remaining > 0}>检索目录</button><button className="nw-btn" type="button" onClick={reset} disabled={remaining > 0}>重置筛选</button></div>
      </fieldset>
    </form>
    {remaining > 0 ? <p role="status">请求受限，请等待 {remaining} 秒后手动重试；不会自动发送请求。</p> : null}
    {/* A whole-work action can remove the row whose button opened it, so the
        result, not the page's first link, is where focus lands afterwards. */}
    <div ref={outcome} tabIndex={-1} className="nw-authoring-outcome">
      {state.error ? <p className="nw-error" role="alert">{state.error}</p> : null}
      {state.notice ? <p role="status">{state.notice}</p> : null}
    </div>
    {downloadError ? <p role="alert">{downloadError}</p> : null}
    {checkingExport ? <p role="status">正在确认下载账户；核验成功且选择未改变时才生成本机文件……</p> : null}
    {state.status === "unauthenticated" ? <Link className="nw-btn" href="/sign-in?next=%2Fwrite%2Flibrary">登录后返回目录</Link> : null}
    {!state.actor && state.status !== "loading" ? <button className="nw-btn" type="button" disabled={remaining > 0} onClick={() => { void controller.connect(); }}>确认当前账户并重新载入</button> : null}
    {busy ? <p role="status">{state.writing ? `正在${CATALOGUE_WORK_ACTION_LABEL[state.writing]}整部作品，请勿重复提交……` : "正在读取目录元数据……"}</p> : null}
    {formChanged ? <p role="status">筛选已修改、尚未提交。下方仍是上次请求的结果，暂不能执行条目操作。</p> : null}
    <section aria-label="目录结果" aria-busy={busy}>
      {state.page ? <>
        <h2>{state.filters.scope === "trash" ? "回收站" : "在用作品"} · {state.page.total} 个语言版本 / {state.page.works} 部作品</h2>
        {state.filters.scope === "trash" ? <p>回收站沿用服务器的保留策略；已永久清除的作品不在这里，只有尚未清除的作品可还原。还原将影响同一作品的全部已有语言并设为草稿，不会自动重新发布。</p> : null}
        {state.status === "failed" ? <p>以下是保留的上次结果，不表示当前服务器状态；先刷新核对后再操作。</p> : null}
        <div className="nw-authoring-actions">
          <button className="nw-btn" type="button" disabled={busy || remaining > 0} onClick={() => { void controller.refresh(); }}>刷新当前页</button>
          <button className="nw-btn" type="button" disabled={busy || remaining > 0} onClick={() => { void controller.restart(); }}>重新开始翻页</button>
          <button className="nw-btn" type="button" disabled={unavailable || formChanged} onClick={() => controller.selectPage()}>选择本页</button>
          <button className="nw-btn" type="button" disabled={!state.selected.length || writing} onClick={() => controller.clearSelection()}>清除选择</button>
        </div>
        <p>已选 {state.selected.length} / {CATALOGUE_SELECTION_LIMIT} 个语言版本。翻页保留选择，已提交的筛选或账户变更会清空。下载的是所选条目上次读取的快照，可在下方明确发起只读核对。</p>
        {/* Restored after 179bac0 dropped it: the selected-body collection backup
            is the only way to hand catalogue editions to the local collection tool. */}
        <WritingCollectionExportPanel catalogue={controller} disabled={unavailable || formChanged || checkingExport} />
        <CatalogueExportPanel selected={state.selected} disabled={unavailable || formChanged || checkingExport} onDownload={report => { void exportSelection(report); }} />
        {state.actor ? <CatalogueSelection actor={state.actor} scope={state.filters.scope} selected={state.selected} visible={state.page.items} disabled={unavailable || formChanged} onRemove={key => controller.removeSelection(key)} onApply={(actor, fingerprint, entries) => controller.adoptReviewedSelection(actor, fingerprint, entries)} onAccountRefused={controller.refuseAccount} onRateLimited={controller.respectReadCooldown} /> : null}
        {state.page.items.length ? <ul className="nw-catalogue-list" aria-label="目录条目">{state.page.items.map(entry => <li key={catalogueEntryKey(entry)}>
          <div className="nw-catalogue-row-top"><label className="nw-writing-check"><input type="checkbox" checked={selected.has(catalogueEntryKey(entry))} disabled={unavailable || formChanged} onChange={() => controller.toggle(entry)} aria-label={`选择《${entry.title}》${catalogueLocaleLabel(entry.locale)}`} /><span>{catalogueLocaleLabel(entry.locale)}</span></label><span>{entry.status === "draft" ? "草稿" : "已发布"} · {labels[entry.workType]}</span></div>
          <h3>{entry.title}</h3><p className="nw-catalogue-summary">{entry.summary || "（没有摘要）"}</p>
          <dl className="nw-catalogue-dates"><div><dt>版本创建</dt><dd><time dateTime={entry.createdAt}>{catalogueDate(entry.createdAt)} UTC</time></dd></div><div><dt>版本更新</dt><dd><time dateTime={entry.updatedAt}>{catalogueDate(entry.updatedAt)} UTC</time></dd></div>{entry.deletedAt ? <div><dt>作品删除</dt><dd><time dateTime={entry.deletedAt}>{catalogueDate(entry.deletedAt)} UTC</time></dd></div> : null}</dl>
          <div className="nw-authoring-actions">
            {entry.deletedAt ? <button className="nw-btn" type="button" disabled={unavailable || formChanged || remaining > 0} onClick={() => controller.requestRestore(entry)}>还原《{entry.title}》</button> : !unavailable && !formChanged && state.actor ? <Link className="nw-btn" href={catalogueOpenHref(entry, state.actor)}>编辑《{entry.title}》</Link> : <span>核对成功后可编辑</span>}
            <button className="nw-btn" type="button" disabled={unavailable || formChanged || remaining > 0} onClick={event => { inspectionTrigger.current = event.currentTarget; void controller.inspect(entry); }}>查看语言版本</button>
            {/* Whole-work actions, so the author does not have to open the
                editor to take a work down. Both are asked first. */}
            {!entry.deletedAt && entry.status === "published" ? <button className="nw-btn" type="button" disabled={unavailable || formChanged || remaining > 0} onClick={() => controller.requestWithdraw(entry)}>撤销发布《{entry.title}》</button> : null}
            {!entry.deletedAt ? <button className="nw-btn" type="button" disabled={unavailable || formChanged || remaining > 0} onClick={() => controller.requestDelete(entry)}>删除《{entry.title}》</button> : null}
          </div>
        </li>)}</ul> : <p>没有符合条件的语言版本。可减少筛选或重新开始；空页不代表账户中没有其他作品。</p>}
        <nav className="nw-authoring-actions" aria-label="目录分页"><button className="nw-btn" type="button" disabled={busy || formChanged || remaining > 0 || !state.pageIndex} onClick={() => { void controller.previous(); }}>上一页</button><span>已浏览第 {state.pageIndex + 1} 页</span><button className="nw-btn" type="button" disabled={busy || formChanged || remaining > 0 || !state.page.nextCursor} onClick={() => { void controller.next(); }}>下一页</button></nav>
        <p className="nw-m">目录与计数随并发保存/删除变化，不是跨请求快照；需要核对时请重新开始。翻页不自动选择或读取正文。</p>
      </> : state.status === "failed" && state.actor ? <button className="nw-btn" type="button" disabled={remaining > 0} onClick={() => { void controller.refresh(); }}>重试读取目录</button> : null}
    </section>
      </>
    )}
    {state.inspection && state.actor ? <CatalogueVersions key={`${state.inspection.source.id}-${state.inspection.status}`} inspection={state.inspection} actor={state.actor} close={() => { controller.closeInspection(); inspectionTrigger.current?.focus(); }} /> : null}
    <ConfirmDialog {...workDialog(state.workIntent)} open={state.workIntent !== null} onCancel={() => controller.cancelWork()} onConfirm={() => { void controller.confirmWork().then(() => { if (outcome.current?.isConnected) outcome.current.focus({ preventScroll: false }); }); }} />
  </section>;
}

/**
 * One confirmation per whole-work action. Each names the edition the author
 * clicked and says that the action reaches every language, because a row is
 * one edition but status and deletion belong to the work.
 */
function workDialog(intent: CatalogueState["workIntent"]): { title: string; confirmLabel: string; description: string; tone: "default" | "danger" } {
  if (!intent) return { title: "", confirmLabel: "", description: "", tone: "default" };
  const chosen = `所选版本：《${intent.entry.title}》 · ${catalogueLocaleLabel(intent.entry.locale)}。`;
  if (intent.kind === "withdraw") return { title: "撤销发布这部作品？", confirmLabel: "撤销发布全部语言", tone: "default",
    description: `${chosen}\n整部作品的所有语言版本会转为草稿，读者立即不能再访问；标题、正文和地址都保留在写作台。\n之后重新发布即可恢复同一地址；此操作不会更改当前写作台编辑区。` };
  if (intent.kind === "delete") return { title: "删除这部作品？", confirmLabel: "删除全部语言", tone: "danger",
    description: `${chosen}\n作品的所有语言版本会立刻从写作台移除，已发布的页面也会立即不可访问。\n删除后可在回收站还原所有版本，但到期自动清除时，这篇作品下的评论会一起消失。` };
  return { title: "还原这部作品？", confirmLabel: "还原全部语言为草稿", tone: "default",
    description: `${chosen}\n这会还原同一作品的全部已有语言版本，并将整部作品设为草稿，不会自动重新发布。\n已永久清除的内容不能通过还原找回；此操作不会更改当前写作台编辑区。` };
}
