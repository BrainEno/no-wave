import { useMemo, useState } from "react";
import { compareWritingDrafts, type WritingTextDifference, type WritingBlockDifference } from "@/lib/writing-compare.ts";
import type { WritingRestore } from "@/lib/writing-backup.ts";
import type { WritingDraft } from "@/lib/writing-session.ts";

const LABELS = { title: "标题", summary: "摘要", locale: "作品语言", workType: "作品类型" };
const CHANGE_LABELS: Record<WritingBlockDifference["kind"], string> = { same: "相同", changed: "内容变化", added: "备份独有", removed: "仅当前有", moved: "位置变化" };

function DifferenceText({ difference }: { difference: WritingTextDifference }) {
  return <span className="nw-writing-difference">
    {difference.prefix}
    {difference.removed ? <del aria-label="当前内容">{difference.removed}</del> : null}
    {difference.inserted ? <ins aria-label="备份内容">{difference.inserted}</ins> : null}
    {difference.suffix}
    {difference.truncated ? <small>（片段达到 1200 字符上限，可能另有变化，请核对原稿和文件）</small> : null}
  </span>;
}

export function WritingRestorePreview({ current, preview, mode, onMode, blocks, onBlocks, disabled }: {
  current: WritingDraft;
  preview: WritingRestore;
  mode: "replace" | "append";
  onMode(value: "replace" | "append"): void;
  blocks: number[];
  onBlocks(value: number[]): void;
  disabled: boolean;
}) {
  const [showSame, setShowSame] = useState(false);
  const comparison = useMemo(() => compareWritingDrafts(current, preview.backup.draft), [current, preview]);
  const rows = comparison.rows.filter(row => showSame || row.kind !== "same");
  const changedBackup = comparison.rows.filter(row => row.kind !== "same" && row.backupIndex !== null).map(row => row.backupIndex!);
  function toggleBlock(index: number, checked: boolean) {
    onBlocks(checked ? [...blocks.filter(value => value !== index), index] : blocks.filter(value => value !== index));
  }
  function selectChanged() {
    onBlocks([...new Set(changedBackup)].sort((a, b) => a - b));
  }
  return <section aria-label="备份差异与正文恢复方式">
    {comparison.fields.length ? <dl className="nw-writing-field-diff">{comparison.fields.map(item => <div key={item.field}>
      <dt>{LABELS[item.field]}</dt><dd><DifferenceText difference={item.difference} /></dd>
    </div>)}</dl> : <p>标题、摘要、语言与类型均相同。</p>}
    <p className="nw-m">删除线表示当前编辑内容，下划线表示备份内容。此差异只供核对，不推测版本新旧，不会自动合并。</p>
    {comparison.limited ? <p role="alert">文稿超出差异检查范围，无法生成完整块对比；请缩小文稿或先导出人工核对。</p> : <>
      <p>正文：{comparison.counts.same} 块相同 · {comparison.counts.changed} 块变化 · {comparison.counts.added} 块备份独有 · {comparison.counts.removed} 块仅当前有 · {comparison.counts.moved} 块位置变化</p>
      <label className="nw-writing-check"><input type="checkbox" checked={showSame} onChange={event => setShowSame(event.target.checked)} />显示相同内容块</label>
      <label className="nw-writing-file">正文恢复方式
        <select aria-label="正文恢复方式" value={mode} disabled={disabled} onChange={event => { onMode(event.target.value === "append" ? "append" : "replace"); onBlocks([]); }}>
          <option value="replace">用备份正文替换全文</option>
          <option value="append">保留当前正文，追加勾选的备份块</option>
        </select>
      </label>
      {mode === "append" ? <div className="nw-authoring-actions">
        <button className="nw-btn" type="button" disabled={disabled || !changedBackup.length} onClick={selectChanged}>选择所有变化的备份块</button>
        <button className="nw-btn" type="button" disabled={disabled || !blocks.length} onClick={() => onBlocks([])}>清空备份块选择</button>
        <p>仅按备份顺序追加所选 {blocks.length} 块，不删除当前内容；相同块也可显式勾选，可能形成重复段落。</p>
      </div> : null}
      <ol className="nw-writing-block-diff" aria-label="正文块差异">{rows.map((row, index) => <li key={`${row.currentIndex}-${row.backupIndex}-${index}`}>
        <p>{CHANGE_LABELS[row.kind]} · {row.blockType} · 当前{row.currentIndex === null ? "无" : `第 ${row.currentIndex + 1} 块`} / 备份{row.backupIndex === null ? "无" : `第 ${row.backupIndex + 1} 块`}</p>
        {mode === "append" && row.backupIndex !== null ? <label className="nw-writing-check">
          <input type="checkbox" aria-label={`追加备份第 ${row.backupIndex + 1} 块`} checked={blocks.includes(row.backupIndex)} disabled={disabled} onChange={event => toggleBlock(row.backupIndex!, event.target.checked)} />追加备份第 {row.backupIndex + 1} 块
        </label> : null}
        {row.formatChanged ? <p>文字相同，但格式、链接、图片地址或块属性有变化。</p> : null}
        <DifferenceText difference={row.difference} />
      </li>)}</ol>
      {!rows.length ? <p>没有不同的正文块。</p> : null}
    </>}
  </section>;
}
