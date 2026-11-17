import { useEffect, useRef, useState } from "react";
import { CollectionDownloadLease } from "@/lib/writing-collection-browser.ts";
import type { WritingCollectionWorkbench, CollectionWorkbenchState } from "@/lib/writing-collection-controller.ts";
import type { CollectionRow } from "@/lib/writing-collection-index.ts";

export function WritingCollectionReview({ controller, state, rows }: { controller: WritingCollectionWorkbench; state: CollectionWorkbenchState; rows: CollectionRow[] }) {
  const [includeLabels, setIncludeLabels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [download] = useState(() => new CollectionDownloadLease());
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; download.release(); }, [download]);
  const preview = state.reviewPreview;
  const label = (id: string) => `${id} · ${rows.find(row => row.id === id)?.entry.backup.draft.title || "（无标题）"}`;
  async function savePlan() {
    const ticket = ++generation.current, snapshot = controller.getSnapshot();
    setSaving(true); setMessage(""); setError("");
    try {
      const artifact = await controller.reviewPlanDownload();
      if (ticket !== generation.current) return;
      download.download(artifact, () => {
        const current = controller.getSnapshot();
        return ticket === generation.current && current.slots === snapshot.slots && current.selected === snapshot.selected && current.pairs === snapshot.pairs;
      });
      setMessage("本机核对计划已交给浏览器；仅含文件摘要与局部选择/配对，不含文稿或文件名。");
    } catch (cause) { if (ticket === generation.current) setError(cause instanceof Error ? cause.message : "核对计划下载失败。"); }
    finally { if (ticket === generation.current) setSaving(false); }
  }
  function saveReport(format: "json" | "csv") {
    const snapshot = controller.getSnapshot();
    setMessage(""); setError("");
    try {
      download.download(controller.reviewReportDownload(format, includeLabels), () => controller.getSnapshot() === snapshot);
      setMessage(`无正文 ${format.toUpperCase()} 核对报告已交给浏览器。${includeLabels ? "已按明确勾选包含标题和文件名，请作为私密文件保管。" : "没有包含标题或文件名。"}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "核对报告下载失败。"); }
  }
  function applyPlan() {
    setMessage(""); setError(""); download.release();
    try { controller.applyReviewPlan(preview); setMessage("已按预览恢复本机明确选择与配对；未运行比较、未恢复正文、未向服务器写入。"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "核对计划预览已过期。"); }
  }
  return <section className="nw-collection-review" aria-label="本机核对计划与报告">
    <h2>保存核对进度与无正文报告</h2>
    <p>计划仅保存当前两份文件的 SHA-256 与明确选择/配对，不含标题、文件名或正文；重新使用须手动打开完全相同的左右文件，再校验预览并明确应用。它不加载文件、恢复正文或自动比较，也不是签名导入或账户凭据。</p>
    <div className="nw-authoring-actions"><button className="nw-btn" type="button" disabled={saving || !state.selected.length && !state.pairs.length} onClick={() => { void savePlan(); }}>下载当前核对计划</button>
      <label className="nw-writing-file">读取本机核对计划<input type="file" accept=".json,application/json" onChange={event => {
        const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
        setMessage(""); setError(""); download.release();
        if (file) void controller.loadReviewPlan(file);
      }} /></label>
      {state.reviewLoading || preview ? <button className="nw-btn" type="button" onClick={() => controller.cancelReviewPlan()}>取消核对计划预览</button> : null}
    </div>
    {state.reviewLoading ? <p role="status">正在校验核对计划，尚未改变任何选择或配对……</p> : null}
    {preview ? <div className="nw-collection-plan-preview" aria-label="核对计划应用预览">
      <h3>将覆盖当前本机选择/配对</h3><p>选择 {preview.plan.selected.length} 篇，配对 {preview.plan.pairs.length} 对；原文件摘要已匹配。预览后改选/改配对/换文件会使本预览失效。不会改正文或服务器作品。</p>
      <ul aria-label="计划中的明确选择">{preview.plan.selected.map(id => <li key={id}>{label(id)}</li>)}</ul>
      <ul aria-label="计划中的明确配对">{preview.plan.pairs.map(pair => <li key={`${pair.left}|${pair.right}`}>{label(pair.left)} ↔ {label(pair.right)}</li>)}</ul>
      <button className="nw-btn nw-btn--primary" type="button" onClick={applyPlan}>明确应用预览中的选择与配对</button>
    </div> : null}
    <h3>无正文核对报告</h3><p>只记录已载入文件/条目摘要、有限统计和实际核对状态；未配对不是删除，未核对不是相同，受限不代表完整。报告不含正文、摘要文字、链接地址、检索词/片段、账户或保存凭据，也不证明作者身份、媒体权限或服务器现状。</p>
    <label className="nw-writing-check"><input type="checkbox" checked={includeLabels} onChange={event => { setIncludeLabels(event.target.checked); download.release(); setMessage(""); }} />报告明确包含私密标题与文件名（默认不含）</label>
    <div className="nw-authoring-actions"><button className="nw-btn" type="button" disabled={state.comparisonStatus === "running"} onClick={() => saveReport("json")}>下载无正文 JSON 报告</button><button className="nw-btn" type="button" disabled={state.comparisonStatus === "running"} onClick={() => saveReport("csv")}>下载无正文 CSV 报告</button></div>
    <p>CSV 始终清理控制字符并保护公式起始内容；安全转义可能改变电子表格中的显示，报告不能用于恢复文稿。</p>
    {message ? <p role="status">{message}</p> : null}{error ? <p role="alert">{error}</p> : null}
  </section>;
}
