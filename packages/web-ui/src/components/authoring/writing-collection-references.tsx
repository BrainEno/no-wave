import { useState } from "react";
import { DEFAULT_COLLECTION_REFERENCE_FILTERS, filterCollectionReferences, type CollectionReferenceFilters, type CollectionReferenceResult } from "@/lib/writing-collection-references.ts";
import type { CollectionRow } from "@/lib/writing-collection-index.ts";
import type { CollectionWorkbenchState, WritingCollectionWorkbench } from "@/lib/writing-collection-controller.ts";

const issueLabels = { "unsafe-url": "不安全地址（已隐藏）", "empty-label": "缺少描述", "insecure-http": "未加密 HTTP", "ambiguous-label": "相同可见链接文字指向不同地址", "label-truncated": "描述仅显示节选" };
export function WritingCollectionReferences({ controller, state, rows, inspect }: { controller: WritingCollectionWorkbench; state: CollectionWorkbenchState; rows: CollectionRow[]; inspect: (id: string, occurrence: number, report: CollectionReferenceResult) => void }) {
  const [filters, setFilters] = useState({ ...DEFAULT_COLLECTION_REFERENCE_FILTERS });
  const [error, setError] = useState("");
  const report = state.references;
  const groups = report ? filterCollectionReferences(report, filters) : [];
  function change<K extends keyof CollectionReferenceFilters>(key: K, value: CollectionReferenceFilters[K]) {
    const next = { ...filters, [key]: value };
    try { if (report) filterCollectionReferences(report, next); setFilters(next); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "引用筛选无效。"); }
  }
  return <section className="nw-collection-reference-inventory" aria-label="集合图片与链接依赖">
    <h2>集合图片与链接依赖</h2>
    <p>集合只保存地址，不保存图片字节。此清单按类型/地址合并跨文稿使用处，只在本机扫描，不发送 HEAD/GET，不打开链接；不能证明资源可达、永久有效或归您所有。地址和描述可能私密，清单不写入无正文报告。</p>
    <div className="nw-authoring-actions"><label>引用清单范围<select value={state.referenceScope} onChange={event => controller.setReferenceScope(event.target.value as "all" | "selected")}><option value="all">全部已载入文稿</option><option value="selected">仅明确勾选文稿</option></select></label>
      <button className="nw-btn" type="button" disabled={state.referenceStatus === "running"} onClick={() => { void controller.inspectReferences(); }}>生成本机引用依赖清单</button>
      {state.referenceStatus === "running" ? <button className="nw-btn" type="button" onClick={() => controller.cancelReferences()}>停止引用检查</button> : null}
    </div>
    {state.referenceStatus === "running" ? <p role="status">逐篇生成引用清单；换文件或改选会废弃旧结果……</p> : null}
    {state.referenceStatus === "cancelled" ? <p role="status">引用检查已停止，没有接纳部分清单。</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {report ? <>
      <p role="status">已列出 {report.total} 处 / {report.groups.length} 个地址组，检查 {report.scanned} / {report.documents} 篇，另有 {report.remaining} 篇未检查。{report.limited ? "达到 200 组 / 1000 处或单篇预算，结果不完整；请缩小明确选择范围。" : "指定范围扫描完成；这不是联网可用性验证。"}</p>
      {report.incomplete.length ? <p>仅部分检查的条目：{report.incomplete.join("、")}</p> : null}
      <form className="nw-collection-filter-grid" onSubmit={event => event.preventDefault()}>
        <label>地址或描述字面筛选<input type="search" maxLength={200} autoComplete="off" value={filters.q} onChange={event => change("q", event.target.value)} /></label>
        <label>引用类型<select value={filters.kind} onChange={event => change("kind", event.target.value as CollectionReferenceFilters["kind"])}><option value="all">全部引用</option><option value="image">仅图片</option><option value="link">仅链接</option></select></label>
        <label>引用所在文件<select value={filters.slot} onChange={event => change("slot", event.target.value as CollectionReferenceFilters["slot"])}><option value="all">左右来源</option><option value="left">包含左侧使用处</option><option value="right">包含右侧使用处</option></select></label>
        <label>引用地址范围<select value={filters.location} onChange={event => change("location", event.target.value as CollectionReferenceFilters["location"])}><option value="all">全部地址</option><option value="relative">仅站内相对地址</option><option value="external">仅外部地址</option><option value="attention">仅有核对提示</option></select></label>
      </form>
      <p>当前显示 {groups.length} / {report.groups.length} 个地址组。只筛显示，不重扫、不改变选择；来源筛选仍保留同地址的全部使用处。</p>
      <ol className="nw-collection-references" aria-label="集合引用地址组">{groups.map(group => <li key={group.id}>
        <h3>{group.kind === "image" ? "图片" : "链接"} · {group.uses.length} 处 / {new Set(group.uses.map(use => use.rowId)).size} 篇</h3>
        <code>{group.url ?? "危险地址已隐藏"}</code><p>{group.host ? `外部主机：${group.host}` : "站内地址或已隐藏地址"}</p>
        <p>{group.issues.length ? group.issues.map(issue => issueLabels[issue]).join("；") : "未发现格式提示，不表示可达或拥有权限"}</p>
        <details><summary>只读查看使用处（{group.uses.length}）</summary><ul>{group.uses.map((use, index) => <li key={`${use.rowId}:${index}`}>
          <p>{use.rowId} · {rows.find(row => row.id === use.rowId)?.entry.backup.draft.title || "（无标题）"} · 节点 {use.path.map(part => part + 1).join(".")}</p>
          <p>{use.label || "（没有描述）"}{use.caption ? ` / ${use.caption}` : ""}</p>
          <button className="nw-btn" type="button" onClick={() => inspect(group.id, index, report)}>只读查看引用所在文稿 {use.rowId}</button>
        </li>)}</ul></details>
      </li>)}</ol>
    </> : null}
  </section>;
}
