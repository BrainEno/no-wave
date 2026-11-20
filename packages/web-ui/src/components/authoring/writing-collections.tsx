import { flushSync } from "react-dom";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "@/lib/framework/link.tsx";
import { getMessages } from "@/lib/content.ts";
import { workTypes } from "@/lib/work-types.ts";
import { bindCollectionPrivacy, CollectionDownloadLease } from "@/lib/writing-collection-browser.ts";
import { WritingCollectionWorkbench } from "@/lib/writing-collection-controller.ts";
import { collectionRows, collectionSourcesKey, DEFAULT_COLLECTION_FILTERS, type CollectionFilters, type CollectionSlot } from "@/lib/writing-collection-index.ts";
import { WritingCollectionDocument } from "./writing-collection-document.tsx";
import type { CollectionSearchResult } from "@/lib/writing-collection-search.ts";
import type { CollectionReferenceResult } from "@/lib/writing-collection-references.ts";
import type { WritingMatch } from "@/lib/writing-replace.ts";
import { WritingCollectionSearch } from "./writing-collection-search.tsx";
import { WritingCollectionReferences } from "./writing-collection-references.tsx";
import { WritingCollectionReview } from "./writing-collection-review.tsx";
import { WritingCollectionComparison } from "./writing-collection-comparison.tsx";
import { catalogueDate, catalogueLocaleLabel } from "./catalogue-versions.tsx";

export function WritingCollections() {
  const [controller] = useState(() => new WritingCollectionWorkbench());
  const [download] = useState(() => new CollectionDownloadLease());
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [downloadMessage, setDownloadMessage] = useState("");
  const [downloadError, setDownloadError] = useState("");
  const [format, setFormat] = useState<"json" | "text" | "markdown">("json");
  const [focused, setFocused] = useState<{ id: string; witness: string; match?: WritingMatch } | null>(null);
  const inspection = useRef<HTMLDivElement | null>(null);
  const sources = controller.getSources();
  const rows = collectionRows(sources);
  const visible = controller.getVisibleRows();
  const witness = collectionSourcesKey(sources);
  const selected = new Set(state.selected);
  const currentDocument = focused?.witness === witness ? rows.find(row => row.id === focused.id) ?? null : null;
  const hiddenSelected = state.selected.filter(key => !visible.some(row => row.id === key)).length;
  const labels = getMessages("zh-CN").workTypeLabels;
  useEffect(() => {
    const clear = () => { controller.clear(); download.release(); setFocused(null); setDownloadError(""); setDownloadMessage(""); };
    const release = bindCollectionPrivacy(window, clear, flushSync);
    return () => { release(); controller.clear(); download.release(); };
  }, [controller, download]);
  useEffect(() => {
    if (focused && !focused.match && inspection.current) { inspection.current.focus(); inspection.current.scrollIntoView({ block: "start" }); }
  }, [focused]);
  function change<K extends keyof CollectionFilters>(key: K, value: CollectionFilters[K]) { controller.setFilters({ ...state.filters, [key]: value }); }
  function choose(slot: CollectionSlot, files: FileList | null) {
    download.release(); setDownloadError(""); setDownloadMessage("");
    if (!files?.length) return;
    if (files.length !== 1) { setDownloadError("每个来源一次只读一份文件，请将另一份放入另一个槽位。"); return; }
    setFocused(null);
    void controller.load(slot, files[0]!);
  }
  function saveSingle(id: string) {
    const snapshot = controller.getSnapshot();
    setDownloadError(""); setDownloadMessage("");
    try {
      if (snapshot.slots !== state.slots) throw new Error("来源文件已变化，请重新选择单篇下载。");
      const artifact = controller.singleDownload(id, format);
      download.download(artifact, () => controller.getSnapshot() === snapshot);
      setDownloadMessage(format === "json" ? "单篇 JSON 已交给浏览器，可在写作工具中重新预览恢复；没有保存或发布。" : "交换格式已交给浏览器，格式或元数据可能丢失，完整恢复仍需 JSON。");
    } catch (error) { setDownloadError(error instanceof Error ? error.message : "单篇下载失败。"); }
  }
  function saveSubset() {
    setDownloadError(""); setDownloadMessage("");
    const prepared = controller.getSnapshot().prepared;
    try {
      const artifact = controller.subsetDownload();
      download.download(artifact, () => prepared !== null && controller.getSnapshot().prepared === prepared);
      setDownloadMessage("所选子集合已交给浏览器。文件含私密正文且未加密，请妥善保管。");
    } catch (error) { setDownloadError(error instanceof Error ? error.message : "子集合下载失败。"); }
  }
  function locateSearch(id: string, result: CollectionSearchResult) {
    setDownloadError("");
    try {
      const hit = controller.searchMatch(id, result);
      setFocused({ id: hit.row.id, witness: collectionSourcesKey(controller.getSources()), match: hit.match });
    } catch (error) { setDownloadError(error instanceof Error ? error.message : "检索位置已过期。"); }
  }
  function inspectReference(id: string, occurrence: number, report: CollectionReferenceResult) {
    setDownloadError("");
    try {
      const row = controller.referenceDocument(id, occurrence, report);
      setFocused({ id: row.id, witness: collectionSourcesKey(controller.getSources()) });
    } catch (error) { setDownloadError(error instanceof Error ? error.message : "引用清单已过期。"); }
  }
  function clearAll() { controller.clear(); download.release(); setFocused(null); setDownloadMessage(""); setDownloadError(""); }

  return <section className="nw-authoring nw-collections" aria-label="本机文稿集合工具">
    <header className="nw-authoring-header"><p className="nw-kicker">LOCAL / 离线文稿</p><h1>本机文稿集合</h1><p>检查、拆分与核对您明确选择的本机备份。无需上传文件，不读取服务器正文，不写作品，也不自动存到浏览器。</p><div className="nw-authoring-actions"><Link className="nw-btn" href="/write/library">返回作品目录</Link><Link className="nw-btn" href="/write">返回写作台</Link><Link className="nw-btn" href="/write/overlap">本机段落审阅</Link><Link className="nw-btn" href="/write/terms">本机术语审阅</Link><Link className="nw-btn" href="/write/cadence">本机标点与节奏</Link><Link className="nw-btn" href="/write/merge">本机三方合并</Link><Link className="nw-btn" href="/write/vault">本机加密备份</Link><button className="nw-btn" type="button" onClick={clearAll}>清除全部本机内容</button></div></header>
    <p>可同时打开两份 UTF-8 JSON，每份最多 16 MiB / 20 篇；也支持现有单篇文稿 JSON。SHA-256 只能检测意外损坏，不能证明作者、来源或媒体权限。组号只在各自文件内有效。</p>
    <p>页面加载后可离线使用。文件未经加密，正文和链接可能私密；请勿在共用设备上留置。离开/挂起页面会清除内容，浏览器返回不会自动重读。集合不包含图片字节，不装载其中的图片或链接。</p>
    <div className="nw-collection-slots">{(["left", "right"] as const).map(slot => {
      const source = state.slots[slot];
      const label = slot === "left" ? "左侧" : "右侧";
      return <section className="nw-collection-slot" key={slot} aria-label={`${label}集合来源`}>
        <h2>{label}文件</h2>
        <label className="nw-writing-file">{label}本机备份文件<input type="file" accept=".json,application/json" onChange={event => { choose(slot, event.currentTarget.files); event.currentTarget.value = ""; }} /></label>
        <button className="nw-btn" type="button" disabled={source.status === "idle"} onClick={() => { controller.clear(slot); download.release(); setFocused(null); setDownloadMessage(""); setDownloadError(""); }}>清除{label}文件</button>
        {source.name ? <p className="nw-collection-filename">本机文件：{source.name}</p> : null}
        {source.status === "reading" || source.status === "checking" ? <p role="status">{source.status === "reading" ? `正在读取 ${source.percent}%` : "正在严格检查结构与 SHA-256，尚未接纳任何条目……"}</p> : null}
        {source.error ? <p role="alert">{source.error}</p> : null}
        {source.opened ? <><p role="status">{source.opened.prepared.collection.entries.length} 篇 / {new Set(source.opened.prepared.collection.entries.map(entry => entry.group)).size} 组。{source.opened.source === "collection" ? "集合结构与所附 SHA-256 均已校验。" : "旧单篇格式仅通过结构校验；原文件没有集合摘要，本机生成的新摘要不证明原文件完整性。"}</p><p>集合时间 {catalogueDate(source.opened.prepared.collection.createdAt)} UTC</p><details><summary>{label}集合摘要</summary><code className="nw-collection-digest">{source.opened.prepared.collection.digest}</code></details></> : null}
      </section>;
    })}</div>
    {state.error ? <p role="alert">{state.error}</p> : null}
    {downloadError ? <p role="alert">{downloadError}</p> : null}
    {downloadMessage ? <p role="status">{downloadMessage}</p> : null}
    {rows.length ? <>
      <section aria-label="本机文稿筛选">
        <h2>文件内文稿清单</h2>
        <form className="nw-collection-filter-grid" onSubmit={event => event.preventDefault()}>
          <label>本机标题或摘要<input type="search" value={state.filters.q} maxLength={120} autoComplete="off" onChange={event => change("q", event.target.value)} /></label>
          <label>来源文件<select value={state.filters.slot} onChange={event => change("slot", event.target.value as CollectionFilters["slot"])}><option value="all">两份文件</option><option value="left">仅左侧</option><option value="right">仅右侧</option></select></label>
          <label>本机文稿语言<select value={state.filters.locale} onChange={event => change("locale", event.target.value)}><option value="all">全部语言</option>{["zh-CN", "en", "zh-TW"].map(locale => <option key={locale} value={locale}>{catalogueLocaleLabel(locale)}</option>)}</select></label>
          <label>本机作品类型<select value={state.filters.workType} onChange={event => change("workType", event.target.value)}><option value="all">全部类型</option>{workTypes.map(type => <option key={type} value={type}>{labels[type]}</option>)}</select></label>
          <label>清单排序<select value={state.filters.sort} onChange={event => change("sort", event.target.value as CollectionFilters["sort"])}><option value="file">左/右来源与原文件顺序</option><option value="title">标题自然排序</option><option value="locale">语言排序</option></select></label>
          <label className="nw-writing-check"><input type="checkbox" checked={state.filters.onlySelected} onChange={event => change("onlySelected", event.target.checked)} />只看已明确选择</label>
        </form>
        <div className="nw-authoring-actions"><button className="nw-btn" type="button" onClick={() => controller.setFilters({ ...DEFAULT_COLLECTION_FILTERS })}>清除本机筛选</button><button className="nw-btn" type="button" disabled={!visible.length} onClick={() => controller.selectVisible()}>选择当前显示文稿</button><button className="nw-btn" type="button" disabled={!state.selected.length} onClick={() => controller.clearSelection()}>清空子集合选择</button></div>
        <p>显示 {visible.length} / {rows.length} 篇；子集合已选 {state.selected.length} / 20 篇，其中 {hiddenSelected} 篇被当前筛选隐藏。筛选不会自动勾选、取消或改变导出顺序。</p>
        <label className="nw-collection-format">单篇下载格式<select value={format} onChange={event => setFormat(event.target.value as typeof format)}><option value="json">原单篇 JSON（供现有工具预览恢复）</option><option value="text">纯文本（丢失格式/元数据）</option><option value="markdown">Markdown（有损交换，不保证再导入）</option></select></label>
        <ol className="nw-collection-rows" aria-label="本机文稿条目">{visible.map(row => <li key={row.id}>
          <label className="nw-writing-check"><input type="checkbox" checked={selected.has(row.id)} onChange={() => controller.toggleSelection(row.id)} aria-label={`选择${row.slot === "left" ? "左侧" : "右侧"}《${row.entry.backup.draft.title}》${row.entry.key}`} />{row.slot === "left" ? "左侧" : "右侧"} · {row.entry.key} · {row.entry.group}</label>
          <h3>{row.entry.backup.draft.title || "（无标题）"}</h3><p>{catalogueLocaleLabel(row.entry.backup.draft.locale)} · {labels[row.entry.backup.draft.workType]}</p><p>{row.entry.backup.draft.summary || "（没有摘要）"}</p>
          <div className="nw-authoring-actions"><button className="nw-btn" type="button" onClick={() => setFocused({ id: row.id, witness })}>只读查看《{row.entry.backup.draft.title}》{row.slot === "left" ? "左侧" : "右侧"}</button><button className="nw-btn" type="button" onClick={() => saveSingle(row.id)}>导出单篇《{row.entry.backup.draft.title}》{row.slot === "left" ? "左侧" : "右侧"}</button></div>
        </li>)}</ol>
        {!visible.length ? <p>没有符合本机筛选的文稿，文件和原有明确选择仍保留。</p> : null}
      </section>
      <WritingCollectionSearch controller={controller} state={state} rows={rows} locate={locateSearch} />
      {currentDocument ? <div tabIndex={-1} ref={inspection} className="nw-collection-inspection"><button className="nw-btn" type="button" onClick={() => setFocused(null)}>关闭只读文稿</button><WritingCollectionDocument key={`${currentDocument.id}:${currentDocument.entry.digest}`} row={currentDocument} target={focused?.match} /></div> : null}
      <section className="nw-collection-subset" aria-label="本机子集合准备">
        <h2>准备所选子集合</h2><p>仅打包明确勾选的文稿，保持左侧来源在前、每份文件内的顺序与分组；不同来源即使组号相同也不会混为一组。不会静默去重、覆盖、上传或更改服务器作品。</p>
        <div className="nw-authoring-actions"><button className="nw-btn" type="button" disabled={!state.selected.length || state.preparing} onClick={() => { download.release(); setDownloadMessage(""); void controller.prepareSubset(); }}>校验并准备所选子集合</button>{state.preparing ? <button className="nw-btn" type="button" onClick={() => controller.cancelPreparation()}>停止子集合准备</button> : null}<button className="nw-btn" type="button" disabled={!state.prepared || state.preparing} onClick={saveSubset}>下载所选子集合</button></div>
        {state.preparing ? <p role="status">正在生成本机子集合与摘要；改选或换文件会废弃旧结果……</p> : null}
        {state.prepared ? <><p role="status">准备完成：{state.prepared.prepared.collection.entries.length} 篇 / {state.prepared.plan.groups} 组，实际 {new Intl.NumberFormat("zh-CN").format(state.prepared.prepared.bytes)} 字节。</p><p>{state.prepared.plan.equivalents.length ? `有 ${state.prepared.plan.equivalents.length} 组文稿按现有语义相同（忽略备份时间），未自动删除任何一篇。可返回清单自行取消选择。` : "未发现完全等价的所选文稿；不代表没有局部重复。"}</p><code className="nw-collection-digest">{state.prepared.prepared.collection.digest}</code></> : null}
      </section>
      <WritingCollectionComparison key={witness} rows={rows} pairs={state.pairs} results={state.comparisons} status={state.comparisonStatus} witness={witness} add={(left, right, key) => controller.addPair(left, right, key)} remove={key => controller.removePair(key)} run={() => { void controller.compare(); }} cancel={() => controller.cancelComparison()} />
      <WritingCollectionReferences key={`references:${witness}`} controller={controller} state={state} rows={rows} inspect={inspectReference} />
      <WritingCollectionReview key={`review:${witness}`} controller={controller} state={state} rows={rows} />
    </> : <p>请选择一份本机备份开始。没有读取您的磁盘目录，也不会因为链接参数自动载入文件。</p>}
  </section>;
}
