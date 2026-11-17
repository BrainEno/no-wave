import { useState } from "react";
import type { WritingTextDifference } from "@/lib/writing-compare.ts";
import { collectionPairKey, type CollectionPairResult, type CollectionPair, type CollectionRow } from "@/lib/writing-collection-index.ts";

const FIELDS = { title: "标题", summary: "摘要", locale: "语言", workType: "类型" };
const CHANGES = { same: "相同", changed: "文本或属性变化", added: "仅右侧有", removed: "仅左侧有", moved: "位置变化" };
function Span({ difference }: { difference: WritingTextDifference }) {
  return <span className="nw-writing-difference">{difference.prefix}{difference.removed ? <del aria-label="左侧内容">{difference.removed}</del> : null}{difference.inserted ? <ins aria-label="右侧内容">{difference.inserted}</ins> : null}{difference.suffix}{difference.truncated ? <small>（片段达到字素安全上限，可能另有变化，请检查完整文件）</small> : null}</span>;
}
function PairResult({ result }: { result: CollectionPairResult }) {
  const [showSame, setShowSame] = useState(false);
  const rows = result.comparison.rows.filter(row => showSame || row.kind !== "same");
  const counts = result.comparison.counts;
  return <section aria-label={`配对差异：${result.left.entry.backup.draft.title}与${result.right.entry.backup.draft.title}`}>
    <h3>左：《{result.left.entry.backup.draft.title}》 / 右：《{result.right.entry.backup.draft.title}》</h3>
    <p>{result.equivalent ? "按现有文稿语义等价；备份时间不同不算正文变化。" : "存在字段、正文或格式差异。"}不推测哪个更新，不自动合并。</p>
    {result.comparison.fields.length ? <dl>{result.comparison.fields.map(item => <div key={item.field}><dt>{FIELDS[item.field]}</dt><dd><Span difference={item.difference} /></dd></div>)}</dl> : <p>标题、摘要、语言、类型相同。</p>}
    {result.comparison.limited ? <p role="alert">正文超过差异计算预算，不能把未展示部分读作相同。</p> : <>
      <p>正文：{counts.same} 块相同，{counts.changed} 块变化，{counts.added} 块仅右侧，{counts.removed} 块仅左侧，{counts.moved} 块位置变化。</p>
      <label className="nw-writing-check"><input type="checkbox" checked={showSame} onChange={event => setShowSame(event.target.checked)} />显示此配对中的相同内容块</label>
      <ol className="nw-writing-block-diff" aria-label="离线配对正文差异">{rows.map((row, index) => <li key={`${row.currentIndex}-${row.backupIndex}-${index}`}>
        <p>{CHANGES[row.kind]} · 左 {row.currentIndex === null ? "无" : row.currentIndex + 1} / 右 {row.backupIndex === null ? "无" : row.backupIndex + 1}</p>
        {row.formatChanged ? <p>文字相同，但格式、链接、图片地址或其他块属性不同。</p> : null}
        <Span difference={row.difference} />
      </li>)}</ol>
      {!rows.length ? <p>没有不同的正文块。</p> : null}
    </>}
  </section>;
}

function PairCard({ result }: { result: CollectionPairResult }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary>《{result.left.entry.backup.draft.title}》 / 《{result.right.entry.backup.draft.title}》 · {result.equivalent ? "文稿语义等价" : "有差异"}</summary>{open ? <PairResult result={result} /> : null}</details>;
}

export function WritingCollectionComparison({ rows, pairs, results, status, witness, add, remove, run, cancel }: {
  rows: CollectionRow[]; pairs: CollectionPair[]; results: CollectionPairResult[]; status: "idle" | "running" | "cancelled" | "complete"; witness: string;
  add(left: string, right: string, witness: string): void; remove(key: string): void; run(): void; cancel(): void;
}) {
  const [left, setLeft] = useState("");
  const [right, setRight] = useState("");
  const [onlyChanged, setOnlyChanged] = useState(false);
  const unpaired = rows.filter(row => !pairs.some(pair => pair.left === row.id || pair.right === row.id));
  const shown = results.filter(result => !onlyChanged || !result.equivalent || result.comparison.limited);
  return <section className="nw-collection-comparison" aria-label="两份备份明确配对核对">
    <h2>两份备份的只读配对核对</h2>
    <p>组号、标题和排列都不是作品身份证明。请明确选择左右各一篇；没有配对的项目只叫“未配对”，不能据此认定新增或删除。配对不会改变文件或服务器作品。</p>
    <form className="nw-collection-pair-form" onSubmit={event => { event.preventDefault(); add(left, right, witness); }}>
      <label>左侧文稿<select value={rows.some(row => row.slot === "left" && row.id === left) ? left : ""} onChange={event => setLeft(event.target.value)}><option value="">请选择左侧</option>{rows.filter(row => row.slot === "left").map(row => <option key={row.id} value={row.id}>{row.entry.backup.draft.title || "（无标题）"} · {row.entry.backup.draft.locale} · {row.entry.key}</option>)}</select></label>
      <label>右侧文稿<select value={rows.some(row => row.slot === "right" && row.id === right) ? right : ""} onChange={event => setRight(event.target.value)}><option value="">请选择右侧</option>{rows.filter(row => row.slot === "right").map(row => <option key={row.id} value={row.id}>{row.entry.backup.draft.title || "（无标题）"} · {row.entry.backup.draft.locale} · {row.entry.key}</option>)}</select></label>
      <button className="nw-btn" type="submit" disabled={!left || !right || status === "running" || pairs.length >= 20}>加入明确配对</button>
    </form>
    <ol>{pairs.map(pair => <li key={collectionPairKey(pair)}>左《{rows.find(row => row.id === pair.left)?.entry.backup.draft.title}》 ↔ 右《{rows.find(row => row.id === pair.right)?.entry.backup.draft.title}》<button className="nw-btn" type="button" onClick={() => remove(collectionPairKey(pair))}>移除此配对</button></li>)}</ol>
    <p>已有 {pairs.length} 对；左侧未配对 {unpaired.filter(row => row.slot === "left").length} 篇，右侧未配对 {unpaired.filter(row => row.slot === "right").length} 篇。</p>
    <div className="nw-authoring-actions"><button className="nw-btn" type="button" disabled={!pairs.length || status === "running"} onClick={run}>运行只读差异核对</button>{status === "running" ? <button className="nw-btn" type="button" onClick={cancel}>停止差异核对</button> : null}</div>
    {status !== "idle" ? <p role="status">已核对 {results.length} / {pairs.length} 对。{status === "running" ? "处理中……" : status === "complete" ? "全部明确配对已核对完成。" : "已停止，当前片段不是完整核对结果。"}</p> : null}
    {results.length ? <><label className="nw-writing-check"><input type="checkbox" checked={onlyChanged} onChange={event => setOnlyChanged(event.target.checked)} />仅显示存在差异或检查不完整的配对</label><ol>{shown.map(result => <li key={collectionPairKey(result.pair)}><PairCard result={result} /></li>)}</ol>{!shown.length ? <p>没有符合当前显示条件的已核对配对。</p> : null}</> : null}
  </section>;
}
