import { useMemo, useState } from "react";
import { auditWritingReferences, type WritingReferenceIssue } from "@/lib/writing-references.ts";
import type { WritingDraft } from "@/lib/writing-session.ts";
import type { WritingPath } from "@/lib/writing-document.ts";

const ISSUES: Record<WritingReferenceIssue, string> = {
  "unsafe-url": "地址无效或不安全，已隐藏原地址，请重新插入。",
  "empty-label": "缺少链接文字或图片替代文本。",
  "insecure-http": "使用 HTTP 地址，HTTPS 页面可能无法安全载入图片；建议核对。",
  "ambiguous-label": "相同链接文字指向不同地址，请确认没有错贴。",
  "label-truncated": "描述过长，此处只显示前 180 字符。",
};

export function WritingReferencesPanel({ draft, navigate }: { draft: WritingDraft; navigate(path: WritingPath): void }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"all" | "link" | "image">("all");
  const [warningsOnly, setWarningsOnly] = useState(false);
  const audit = useMemo(() => open ? auditWritingReferences(draft) : null, [draft, open]);
  const groups = (audit?.groups ?? []).filter(group => (kind === "all" || group.kind === kind) && (!warningsOnly || group.issues.length > 0));
  return <details className="nw-writing-references" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>链接与图片核对清单</summary>
    {audit ? <>
      <p>纳入清单 {audit.total} 处引用，按地址合并为 {audit.groups.length} 组。只显示地址，不会打开链接或探测图片，也不能据此确认媒体归属或链接可用性。</p>
      <label className="nw-writing-file">引用类型<select value={kind} onChange={event => setKind(event.target.value as "all" | "link" | "image")}>
        <option value="all">链接与图片</option><option value="link">只看链接</option><option value="image">只看图片</option>
      </select></label>
      <label className="nw-writing-check"><input type="checkbox" checked={warningsOnly} onChange={event => setWarningsOnly(event.target.checked)} />只看需要核对的引用</label>
      {audit.limited ? <p role="alert">核对清单达到检查上限（最多 200 组、1000 处引用），此处不是完整结果。</p> : null}
      <ol aria-label="链接与图片核对清单">{groups.map((group, index) => <li key={`${group.kind}-${group.url}-${index}`}>
        <h4>{group.kind === "link" ? "链接" : "图片"} · {group.external ? "外部地址" : "站内地址"} · {group.occurrences.length} 处</h4>
        <p><code>{group.url ?? "（无效地址，原值已隐藏）"}</code></p>
        <p>文字：{group.labels.join(" / ") || "（空）"}</p>
        {group.issues.length ? <ul>{group.issues.map(issue => <li key={issue}>{ISSUES[issue]}</li>)}</ul> : null}
        <div className="nw-authoring-actions">{group.occurrences.slice(0, 50).map((occurrence, occurrenceIndex) => <button className="nw-btn" type="button" key={occurrence.path.join(".")} onClick={() => navigate(occurrence.path)}>
          定位第 {index + 1} 组第 {occurrenceIndex + 1} 处引用{occurrence.caption ? `：${occurrence.caption}` : ""}
        </button>)}</div>
        {group.occurrences.length > 50 ? <p>此组只显示前 50 处定位入口；重复引用均已计入总数。</p> : null}
      </li>)}</ol>
      {!groups.length ? <p>当前筛选条件下没有引用。</p> : null}
    </> : null}
  </details>;
}
