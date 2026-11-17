import type { WritingCollectionWorkbench, CollectionWorkbenchState } from "@/lib/writing-collection-controller.ts";
import type { CollectionRow } from "@/lib/writing-collection-index.ts";
import type { CollectionSearch, CollectionSearchResult } from "@/lib/writing-collection-search.ts";

export function WritingCollectionSearch({ controller, state, rows, locate }: { controller: WritingCollectionWorkbench; state: CollectionWorkbenchState; rows: CollectionRow[]; locate: (id: string, result: CollectionSearchResult) => void }) {
  function change<K extends keyof CollectionSearch>(key: K, value: CollectionSearch[K]) { controller.setSearch({ ...state.search, [key]: value }); }
  const result = state.searchResult;
  return <section className="nw-collection-search" aria-label="跨文稿正文检索">
    <h2>跨文稿正文检索</h2>
    <p>只在已校验文件中按字面文字查找，不搜索标题/摘要、代码、链接目标或图片描述，不上传查询、不替换。最多展示 100 处，达到总预算即停止后续文稿；未检查不能当作没有匹配。</p>
    <form className="nw-collection-filter-grid" onSubmit={event => { event.preventDefault(); void controller.runSearch(); }}>
      <label>正文检索文字<input type="search" autoComplete="off" maxLength={200} value={state.search.text} onChange={event => change("text", event.target.value)} /></label>
      <label>正文检索来源<select value={state.search.source} onChange={event => change("source", event.target.value as CollectionSearch["source"])}><option value="all">全部已载入文稿</option><option value="left">仅左侧来源</option><option value="right">仅右侧来源</option><option value="selected">仅明确勾选（含筛选隐藏项）</option></select></label>
      <label>正文检索块范围<select value={state.search.scope} onChange={event => change("scope", event.target.value as CollectionSearch["scope"])}><option value="all">所有可检索文字块</option><option value="paragraphs">仅段落</option><option value="headings">仅标题</option><option value="quotes">仅引用</option><option value="lists">仅列表</option></select></label>
      <label className="nw-writing-check"><input type="checkbox" checked={state.search.caseSensitive} onChange={event => change("caseSensitive", event.target.checked)} />正文检索区分大小写</label>
      <button className="nw-btn" type="submit" disabled={!state.search.text || state.searchStatus === "running"}>检索本机正文</button>
      {state.searchStatus === "running" ? <button className="nw-btn" type="button" onClick={() => controller.cancelSearch()}>停止正文检索</button> : null}
    </form>
    {state.searchStatus === "running" ? <p role="status">正在逐篇检索；换文件、改条件或改选会取消旧结果……</p> : null}
    {state.searchStatus === "cancelled" ? <p role="status">检索已停止，未将部分结果当作完整结果。</p> : null}
    {result ? <>
      <p role="status">找到 {result.matches.length} 处，已检查 {result.scanned} / {result.total} 篇；还有 {result.remaining} 篇未检查。{result.limited ? "达到检索预算或存在无法检查的文稿，结果不完整，请缩小来源/块范围后重试。" : "已完成指定范围内的检索。"}</p>
      {result.skipped.length ? <ul>{result.skipped.map(item => <li key={item.rowId}>{item.rowId} 未检查：{item.reason}</li>)}</ul> : null}
      <ol className="nw-collection-search-results" aria-label="跨文稿正文匹配">{result.matches.map((hit, index) => {
        const row = rows.find(item => item.id === hit.rowId);
        return <li key={hit.id}><p>{row?.slot === "left" ? "左侧" : "右侧"} · {row?.entry.backup.draft.title || "（无标题）"} · {hit.rowId}</p>
          <p className="nw-collection-search-context">{hit.match.before}<mark>{hit.match.text}</mark>{hit.match.after}</p>
          <button className="nw-btn" type="button" onClick={() => locate(hit.id, result)}>只读定位第 {index + 1} 处匹配</button>
        </li>;
      })}</ol>
    </> : null}
  </section>;
}
