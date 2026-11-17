import { useEffect, useMemo, useRef, useState } from "react";
import { inspectWriting } from "@/lib/writing-document.ts";
import { auditWritingReferences } from "@/lib/writing-references.ts";
import type { WritingMatch } from "@/lib/writing-replace.ts";
import type { CollectionRow } from "@/lib/writing-collection-index.ts";
import { catalogueDate, catalogueLocaleLabel } from "./catalogue-versions.tsx";

function excerpt(text: string): string {
  const characters = Array.from(text);
  return characters.length > 1600 ? characters.slice(0, 1600).join("") + "…（仅截断屏幕预览，下载保留完整正文）" : text || "（空）";
}
export function WritingCollectionDocument({ row, target }: { row: CollectionRow; target?: WritingMatch }) {
  const inspection = useMemo(() => inspectWriting(row.entry.backup.draft), [row.entry.backup]);
  const [referencesOpen, setReferencesOpen] = useState(false);
  const references = useMemo(() => referencesOpen ? auditWritingReferences(row.entry.backup.draft) : null, [referencesOpen, row.entry.backup]);
  const [path, setPath] = useState("");
  const blocks = useRef(new Map<string, HTMLLIElement>());
  useEffect(() => {
    const block = blocks.current.get(path);
    if (block) { block.focus(); block.scrollIntoView({ block: "nearest" }); }
  }, [path]);
  useEffect(() => {
    const block = target ? blocks.current.get(target.path.join(".")) : null;
    if (block) { block.focus(); block.scrollIntoView({ block: "nearest" }); }
  }, [target]);
  return <section className="nw-collection-document" aria-label={`只读文稿《${row.entry.backup.draft.title}》`}>
    <h3>{row.entry.backup.draft.title || "（无标题）"}</h3>
    <p>{row.entry.backup.draft.summary || "（没有摘要）"}</p>
    <p>{catalogueLocaleLabel(row.entry.backup.draft.locale)} · 文件内 {row.entry.group} · 备份时间 {catalogueDate(row.entry.backup.createdAt)} UTC</p>
    <dl className="nw-collection-statistics"><div><dt>文字字符</dt><dd>{inspection.statistics.characters}</dd></div><div><dt>正文块</dt><dd>{inspection.statistics.blocks}</dd></div><div><dt>图片地址</dt><dd>{inspection.statistics.images}</dd></div><div><dt>链接</dt><dd>{inspection.statistics.links}</dd></div></dl>
    <p>仅显示纯文本，不装载图片、不打开链接、不调用编辑器或写入 API。代码与图片描述不计入文字统计；不能据此确认图片仍可访问或归属当前账户。</p>
    {inspection.limited ? <p role="alert">检查达到预算，以下视图不完整；请使用原始备份核对。</p> : null}
    {inspection.outline.length ? <nav aria-label="本机文稿大纲"><ol>{inspection.outline.map(item => <li key={item.path.join(".")}><button className="nw-btn" type="button" onClick={() => setPath(item.path.join("."))}>{"· ".repeat(Math.max(0, item.level - 2))}{item.title}</button></li>)}</ol></nav> : null}
    <ol className="nw-collection-blocks" aria-label="文稿正文文本">{inspection.blocks.map(block => <li key={block.path.join(".")} tabIndex={-1} ref={element => { if (element) blocks.current.set(block.path.join("."), element); else blocks.current.delete(block.path.join(".")); }}>
      <p className="nw-m">{block.kind} · 节点 {block.path.map(index => index + 1).join(".")}</p>
      {target?.path.join(".") === block.path.join(".") ? <p aria-label="正文检索定位上下文">{target.start > 300 ? "…" : ""}{block.text.slice(Math.max(0, target.start - 300), target.start)}<mark>{target.text}</mark>{block.text.slice(target.end, target.end + 300)}{target.end + 300 < block.text.length ? "…" : ""}</p> : block.kind === "code" ? <pre>{excerpt(block.text)}</pre> : <p>{excerpt(block.text)}</p>}
    </li>)}</ol>
    {inspection.issues.length ? <details><summary>本机文稿检查提示（{inspection.issues.length}）</summary><ul>{inspection.issues.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.message}{issue.path ? <button className="nw-btn" type="button" onClick={() => setPath(issue.path!.join("."))}>定位提示所在块</button> : null}</li>)}</ul></details> : null}
    <details onToggle={event => setReferencesOpen(event.currentTarget.open)}><summary>离线链接与图片地址清单</summary>
      <p>地址仅作为文字显示，不发 HEAD/GET 请求；图片字节不在集合文件中，私密或临时链接可能失效，请勿随意分享。</p>
      {references ? <><p>已检查 {references.total} 处引用，按地址合并 {references.groups.length} 组。{references.limited ? "达到扫描上限，结果不完整。" : ""}</p><ul className="nw-collection-references">{references.groups.map((group, index) => <li key={`${group.kind}-${index}`}><strong>{group.kind === "image" ? "图片" : "链接"}</strong><code>{group.url ?? "危险地址已隐藏"}</code><p>{group.labels.join(" / ") || "（没有描述）"}</p><p>{group.issues.length ? `需核对：${group.issues.join("、")}` : "仅通过地址格式检查，不代表可达或拥有权限"}</p></li>)}</ul></> : null}
    </details>
  </section>;
}
