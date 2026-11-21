import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@/lib/framework/link.tsx";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createNodeSelection, $createRangeSelection, $getRoot, $isElementNode, $isTextNode, $setSelection, HISTORY_PUSH_TAG, type LexicalNode } from "lexical";
import type { LexicalEditorStateJson } from "@/lib/lexical-article-state.ts";
import { inspectWriting, writingSectionStatistics, type WritingInspection, type WritingPath } from "@/lib/writing-document.ts";
import { applyWritingReplacement, previewWritingReplacement, writingMatchAnchors, type WritingMatch, type WritingSearchScope, type WritingReplacement } from "@/lib/writing-replace.ts";
import { createWritingBackup, exportWritingText, MAX_WRITING_BACKUP_BYTES, parseWritingBackup, previewWritingRestore, WRITING_FIELDS, writingDownloadName, type WritingField, type WritingRestore } from "@/lib/writing-backup.ts";
import { writingSnapshotKey, type WritingDraft } from "@/lib/writing-session.ts";
import { restoreWritingSelection } from "@/lib/writing-restore.ts";
import { WritingRestorePreview } from "./writing-restore-preview.tsx";
import { WritingReferencesPanel } from "./writing-references-panel.tsx";
import { WritingRecovery, type WritingRecoveryOwner } from "./writing-recovery.tsx";

const FIELD_LABELS: Record<WritingField, string> = { title: "标题", summary: "摘要", locale: "作品语言", workType: "作品类型", editorState: "正文（含格式）" };
type ToolsProps = { draft: WritingDraft; getDraft(): WritingDraft; onChange(draft: WritingDraft): void; locked: boolean; recovery: WritingRecoveryOwner };
type ActionProps = { draft: WritingDraft; read(): WritingDraft; apply(draft: WritingDraft): void; locked: boolean };

function InspectionPanel({ inspection, draft, navigate }: { inspection: WritingInspection; draft: WritingDraft; navigate(path: WritingPath): void }) {
  const { statistics } = inspection;
  const sections = useMemo(() => writingSectionStatistics(draft, inspection), [draft, inspection]);
  return <section aria-label="文稿检查与大纲">
    <p className="nw-m">{statistics.characters.toLocaleString()} 个非空白字符 · {statistics.words.toLocaleString()} 个词组 · 预计阅读 {statistics.minutes} 分钟</p>
    <p className="nw-m">{statistics.blocks} 个内容块 · {statistics.images} 张图片 · {statistics.links} 处链接 · {statistics.codeBlocks} 个代码块。阅读统计不含代码和图片描述，仅供参考。</p>
    {inspection.limited ? <p role="alert">检查达到范围上限，仅显示部分结果；查找替换在完整检查前不可用。</p> : null}
    <h3>文稿大纲</h3>
    {sections.length ? <ol className="nw-writing-outline" aria-label="文稿大纲">{sections.map(item => <li key={item.path.join(".")} data-level={item.level}>
      <button type="button" onClick={() => navigate(item.path)}><span className="nw-m">H{item.level}</span> {item.title}</button><small>本节 {item.characters} 字符 · {item.words} 词组 · {item.minutes} 分钟 · {item.images} 张图片（含下级标题）</small>
    </li>)}</ol> : <p>正文还没有二至四级标题，可用格式工具栏添加。</p>}
    <WritingReferencesPanel draft={draft} navigate={navigate} />
    <h3>发布前检查（{inspection.issues.length}）</h3>
    <p className="nw-m">这些是结构提示，不评价文风，也不会代替服务端校验或阻止您继续写作。</p>
    {inspection.issues.length ? <ul className="nw-writing-issues">{inspection.issues.map((issue, index) => <li key={`${issue.code}-${index}`}>
      <span>{issue.severity === "error" ? "需处理：" : "建议："}{issue.message}</span>
      {issue.path ? <button className="nw-btn" type="button" onClick={() => navigate(issue.path!)} aria-label={`定位：${issue.message}`}>定位</button> : null}
    </li>)}</ul> : <p>未发现上述结构问题；发布前仍请通读全文。</p>}
  </section>;
}

function ReplacementPanel({ draft, read, apply, locked, navigate }: ActionProps & { navigate(match: WritingMatch, source: string): void }) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(true);
  const [scope, setScope] = useState<WritingSearchScope>("all");
  const [active, setActive] = useState(-1);
  const [preview, setPreview] = useState<WritingReplacement | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [message, setMessage] = useState("");
  const stale = preview !== null && preview.source !== writingSnapshotKey(draft);
  const invalidate = () => { setPreview(null); setSelected([]); setActive(-1); setMessage(""); };
  function makePreview() {
    const next = previewWritingReplacement(read(), query, replacement, caseSensitive, scope);
    setPreview(next);
    setSelected([]);
    setActive(-1);
    setMessage(next.error ?? (next.matches.length ? "请勾选要替换的匹配项，再应用。" : "未找到匹配文字。"));
  }
  function locate(index: number) {
    if (!preview || stale || index < 0 || index >= preview.matches.length) return;
    try {
      navigate(preview.matches[index]!, preview.source);
      setActive(index);
      setMessage(`已定位第 ${index + 1} / ${preview.matches.length} 处；仅选择正文，没有替换。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "定位失败，请重新预览。"); }
  }
  function move(direction: -1 | 1) {
    if (!preview?.matches.length) return;
    const count = preview.matches.length;
    locate(active < 0 ? direction === 1 ? 0 : count - 1 : (active + direction + count) % count);
  }
  function replace() {
    if (!preview || locked) return;
    try {
      apply(applyWritingReplacement(read(), preview, selected));
      setMessage(`已替换 ${selected.length} 处，仅修改编辑区；正文可用“撤销”恢复，尚未保存。`);
      setPreview(null);
      setSelected([]);
    } catch (error) { setMessage(error instanceof Error ? error.message : "替换失败，未修改正文。"); }
  }
  return <section aria-label="正文查找替换">
    <p className="nw-m">字面查找，不使用正则表达式；可跨行内格式与链接文字，不跨段落、列表项或显式换行，不改链接地址、图片和代码块。替换文字采用匹配起点的格式。</p>
    <div className="nw-writing-inputs">
      <label>查找文字<input value={query} maxLength={200} onChange={event => { setQuery(event.target.value); invalidate(); }} /></label>
      <label>替换为<input value={replacement} maxLength={1000} placeholder="留空表示删除匹配文字" onChange={event => { setReplacement(event.target.value); invalidate(); }} /></label>
    </div>
    <label className="nw-writing-file">查找范围<select value={scope} onChange={event => { setScope(event.target.value as WritingSearchScope); invalidate(); }}>
      <option value="all">全部可替换正文</option><option value="paragraphs">仅段落</option><option value="headings">仅标题</option><option value="quotes">仅引用</option><option value="lists">仅列表项</option>
    </select></label>
    <label className="nw-writing-check"><input type="checkbox" checked={caseSensitive} onChange={event => { setCaseSensitive(event.target.checked); invalidate(); }} />区分大小写</label>
    <button className="nw-btn" type="button" onClick={makePreview}>预览替换</button>
    {preview && !preview.error && preview.matches.length ? <>
      {preview.more ? <p role="alert">仅预览前 200 处匹配；未显示的匹配不会被替换。可缩小查询范围或分批操作。</p> : null}
      <div className="nw-authoring-actions">
        <button className="nw-btn" type="button" disabled={stale} onClick={() => move(-1)}>上一处匹配</button>
        <button className="nw-btn" type="button" disabled={stale} onClick={() => move(1)}>下一处匹配</button>
        <button className="nw-btn" type="button" disabled={stale} onClick={() => setSelected(preview.matches.map(match => match.id))}>选择全部预览项</button>
        <button className="nw-btn" type="button" onClick={() => setSelected([])}>清空选择</button>
      </div>
      <ol className="nw-writing-matches" aria-label="替换预览">{preview.matches.map(match => <li key={match.id} aria-current={active === match.id ? "true" : undefined}>
        <label className="nw-writing-check"><input type="checkbox" aria-label={`替换第 ${match.id + 1} 处`} checked={selected.includes(match.id)} disabled={stale} onChange={event => { const checked = event.target.checked; setSelected(values => checked ? [...values.filter(id => id !== match.id), match.id] : values.filter(id => id !== match.id)); }} />
          <span>{match.before}<mark>{match.text}</mark>{match.after}<span className="nw-writing-result"> → {replacement || "（删除）"}</span></span>
        </label>
        <button className="nw-btn" type="button" disabled={stale} onClick={() => locate(match.id)} aria-label={`定位正文：第 ${match.id + 1} 处匹配`}>定位正文</button>
      </li>)}</ol>
      <button className="nw-btn nw-pri" type="button" disabled={locked || stale || !selected.length} onClick={replace}>替换所选（{selected.length}）</button>
    </> : null}
    {stale ? <p role="alert">预览已过期，文稿内容或字段已改变；请重新预览。</p> : null}
    {locked ? <p>上次创建请求尚未确认，暂不能应用替换；原请求和当前输入均保留。</p> : null}
    {message ? <p role="status">{message}</p> : null}
  </section>;
}

function BackupPanel({ draft, read, apply, locked }: ActionProps) {
  const [preview, setPreview] = useState<WritingRestore | null>(null);
  const [selected, setSelected] = useState<WritingField[]>([]);
  const [reading, setReading] = useState(false);
  const [allowRemote, setAllowRemote] = useState(false);
  const [bodyMode, setBodyMode] = useState<"replace" | "append">("replace");
  const [bodyBlocks, setBodyBlocks] = useState<number[]>([]);
  const [message, setMessage] = useState("");
  const epoch = useRef({ value: 0 });
  const reader = useRef<FileReader | null>(null);
  const downloads = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const urls = downloads.current;
    const generation = epoch.current;
    return () => {
      generation.value++;
      reader.current?.abort();
      for (const [url, timer] of urls) { clearTimeout(timer); URL.revokeObjectURL(url); }
      urls.clear();
    };
  }, []);
  const stale = preview !== null && preview.source !== writingSnapshotKey(draft);
  const restoredInspection = useMemo(() => preview ? inspectWriting(preview.backup.draft) : null, [preview]);

  function download(format: "json" | "text" | "markdown") {
    try {
      const current = read();
      const text = format === "json" ? createWritingBackup(current) : exportWritingText(current, format);
      const type = format === "json" ? "application/json" : format === "markdown" ? "text/markdown" : "text/plain";
      const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
      const link = document.createElement("a");
      link.href = url;
      link.download = writingDownloadName(current.title, format === "json" ? "json" : format === "text" ? "txt" : "md");
      downloads.current.set(url, setTimeout(() => { URL.revokeObjectURL(url); downloads.current.delete(url); }, 30_000));
      document.body.append(link);
      try { link.click(); } finally { link.remove(); }
      setMessage("已生成当前编辑内容的下载文件；请确认浏览器已保存。此操作没有保存或发布服务器作品。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "无法生成下载文件。"); }
  }

  function cancelRead() {
    epoch.current.value++;
    reader.current?.abort();
    reader.current = null;
    setReading(false);
    setPreview(null);
    setSelected([]);
    setAllowRemote(false);
    setBodyMode("replace");
    setBodyBlocks([]);
  }

  function chooseFile(file: File | undefined) {
    cancelRead();
    setMessage("");
    if (!file) return;
    if (file.size < 1 || file.size > MAX_WRITING_BACKUP_BYTES) { setMessage("请选择大于 0 且不超过 2 MiB 的 JSON 文稿备份。"); return; }
    const ticket = epoch.current.value;
    const source = read();
    const witness = writingSnapshotKey(source);
    const input = new FileReader();
    reader.current = input;
    setReading(true);
    input.onload = () => {
      if (epoch.current.value !== ticket) return;
      setReading(false);
      try {
        if (writingSnapshotKey(read()) !== witness) throw new Error("读取期间文稿已变化，请重新选择备份文件。");
        if (typeof input.result !== "string") throw new Error("无法读取这个文件。");
        const plan = previewWritingRestore(source, parseWritingBackup(input.result));
        setPreview(plan);
        setSelected(plan.changedFields.filter(field => !(field === "locale" && plan.backup.draft.locale === "zh-TW" && source.locale !== "zh-TW") && !(field === "workType" && plan.backup.draft.workType === "serial" && source.workType !== "serial")));
        setMessage("备份校验通过，请核对差异与恢复字段；尚未修改编辑区。");
      } catch (error) { setMessage(error instanceof Error ? error.message : "备份无法读取。"); }
    };
    input.onerror = () => { if (epoch.current.value === ticket) { setReading(false); setMessage("文件读取失败，请重新选择文件。"); } };
    input.readAsText(file, "utf-8");
  }

  function restore() {
    if (!preview || locked) return;
    try {
      apply(restoreWritingSelection(read(), preview, selected, bodyMode === "append" ? { mode: "append", blocks: bodyBlocks } : { mode: "replace" }));
      setPreview(null);
      setSelected([]);
      setMessage("所选字段已恢复到当前编辑区，尚未保存或发布。正文可撤销；标题、摘要、语言和类型不属于富文本撤销记录。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "恢复失败，未修改文稿。"); }
  }
  const remoteCount = (preview?.backup.draft.editorState?.root.children ?? []).filter((node, index) => node.type === "image" && typeof node.src === "string" && !node.src.startsWith("/") && (bodyMode === "replace" || bodyBlocks.includes(index))).length;
  const needsRemoteConsent = remoteCount > 0 && selected.includes("editorState");
  const missingBlocks = selected.includes("editorState") && bodyMode === "append" && !bodyBlocks.length;
  return <section aria-label="本机备份与恢复">
    <p>JSON 备份包含当前标题、摘要、语言、类型和正文，不附加账户、作品地址、发布状态或版本凭据。纯文本和 Markdown 仅导出标题与正文。此处仅手动下载/读取，不上传备份文件；只有上方另行明确启用的“本机文稿恢复”才会自动缓存编辑内容。</p>
    <p className="nw-m">备份文件未加密，请妥善保管；不包含图片原文件。恢复图片后仍需服务端验证媒体权限。浏览器崩溃或强制退出时，离开提醒无法保证生效。</p>
    <div className="nw-authoring-actions">
      <button className="nw-btn" type="button" onClick={() => download("json")}>下载 JSON 文稿备份</button>
      <button className="nw-btn" type="button" onClick={() => download("text")}>导出纯文本</button>
      <button className="nw-btn" type="button" onClick={() => download("markdown")}>导出 Markdown</button>
    </div>
    <p className="nw-m">纯文本会丢失格式；Markdown 不保留下划线和应用元数据，不保证完全还原，也不能在此导入。完整恢复请使用 JSON 备份。</p>
    <label className="nw-writing-file">读取 JSON 文稿备份<input type="file" accept=".json,application/json" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; chooseFile(file); }} /></label>
    {reading ? <p role="status">正在读取本地文件……</p> : null}
    {preview ? <div className="nw-writing-restore" aria-label="文稿恢复预览">
      <h3>恢复预览</h3>
      <p>备份时间：{new Date(preview.backup.createdAt).toLocaleString()} · {restoredInspection?.statistics.characters} 个正文字符 · {restoredInspection?.statistics.images} 张图片</p>
      <p>备份标题：{preview.backup.draft.title || "（空标题）"}</p>
      <p>备份摘要：{preview.backup.draft.summary || "（空摘要）"}</p>
      <p>备份语言：{preview.backup.draft.locale} · 类型：{preview.backup.draft.workType}</p>
      <p>正文片段（最多 1200 字符，不加载图片或链接）：</p>
      <pre>{restoredInspection?.blocks.map(block => block.text).join("\n").slice(0, 1200) || "（没有文字正文）"}</pre>
      <fieldset disabled={stale}><legend>选择要恢复的字段</legend>{WRITING_FIELDS.map(field => <label className="nw-writing-check" key={field}>
        <input type="checkbox" aria-label={`恢复${FIELD_LABELS[field]}`} checked={selected.includes(field)} onChange={event => { const checked = event.target.checked; setSelected(values => checked ? [...values, field] : values.filter(item => item !== field)); }} />
        {FIELD_LABELS[field]}（{preview.changedFields.includes(field) ? "与当前不同" : "与当前相同"}）
      </label>)}</fieldset>
      <WritingRestorePreview current={draft} preview={preview} mode={bodyMode} onMode={mode => { setBodyMode(mode); setAllowRemote(false); }} blocks={bodyBlocks} onBlocks={blocks => { setBodyBlocks(blocks); setAllowRemote(false); }} disabled={stale || !selected.includes("editorState")} />
      {needsRemoteConsent ? <label className="nw-writing-check"><input type="checkbox" checked={allowRemote} onChange={event => setAllowRemote(event.target.checked)} />恢复正文将载入 {remoteCount} 张远程图片，我同意向图片地址发出请求</label> : null}
      <button className="nw-btn nw-pri" type="button" disabled={locked || stale || !selected.length || missingBlocks || (needsRemoteConsent && !allowRemote)} onClick={restore}>恢复所选字段到编辑区</button>
    </div> : null}
    {stale ? <p role="alert">恢复预览已过期，文稿已改变；请重新选择备份文件。</p> : null}
    {locked ? <p>上次创建请求尚未确认，暂不能应用恢复；仍可下载当前输入的备份。</p> : null}
    {reading || preview ? <button className="nw-btn" type="button" onClick={cancelRead}>取消读取与恢复预览</button> : null}
    {message ? <p role="status">{message}</p> : null}
  </section>;
}

export function WritingTools({ draft, getDraft, onChange, locked, recovery }: ToolsProps) {
  const [editor] = useLexicalComposerContext();
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<"inspection" | "replacement" | "backup">("inspection");
  const [message, setMessage] = useState("");
  const inspection = useMemo(() => open ? inspectWriting(draft) : null, [draft, open]);
  const read = useCallback((): WritingDraft => ({ ...getDraft(), editorState: editor.getEditorState().toJSON() as LexicalEditorStateJson }), [editor, getDraft]);
  const apply = useCallback((next: WritingDraft) => {
    if (locked) throw new Error("请先确认上次创建请求。");
    if (editor.isComposing()) throw new Error("请先完成输入法组词，再应用文稿工具。");
    if (!next.editorState) throw new Error("编辑器尚未初始化。");
    if (JSON.stringify(read().editorState) !== JSON.stringify(next.editorState)) {
      const parsed = editor.parseEditorState(JSON.stringify(next.editorState));
      editor.setEditorState(parsed, { tag: HISTORY_PUSH_TAG });
      // The runtime may normalize adjacent text nodes/default fields.
      onChange({ ...next, editorState: editor.getEditorState().toJSON() as LexicalEditorStateJson });
    } else onChange(next);
  }, [editor, locked, onChange, read]);

  function navigateMatch(match: WritingMatch, source: string) {
    const current = read();
    if (editor.isComposing()) throw new Error("请先完成输入法组词，再定位匹配。");
    if (writingSnapshotKey(current) !== source) throw new Error("预览已过期，请重新预览后定位。");
    const anchors = writingMatchAnchors(current, match);
    if (!anchors) throw new Error("匹配位置已改变，请重新预览。");
    let key: string | null = null;
    editor.update(() => {
      const resolve = (path: WritingPath): LexicalNode | null => {
        let node: LexicalNode | null = $getRoot();
        for (const index of path) node = $isElementNode(node) ? node.getChildren()[index] ?? null : null;
        return node;
      };
      const start = resolve(anchors.anchor.path), end = resolve(anchors.focus.path);
      if (!$isTextNode(start) || !$isTextNode(end) || anchors.anchor.offset > start.getTextContentSize() || anchors.focus.offset > end.getTextContentSize()) return;
      const selection = $createRangeSelection();
      selection.anchor.set(start.getKey(), anchors.anchor.offset, "text");
      selection.focus.set(end.getKey(), anchors.focus.offset, "text");
      $setSelection(selection);
      key = start.getKey();
    }, { onUpdate: () => { if (key) editor.getElementByKey(key)?.scrollIntoView({ block: "center" }); } });
  }

  function navigate(path: WritingPath) {
    if (editor.isComposing() || writingSnapshotKey(read()) !== writingSnapshotKey(draft)) { setMessage("文稿已变化或输入法尚在组词，请稍后重新定位。"); return; }
    let key: string | null = null;
    editor.update(() => {
      let node: LexicalNode | null = $getRoot();
      for (const index of path) node = $isElementNode(node) ? node.getChildren()[index] ?? null : null;
      if (!node) return;
      key = node.getKey();
      if ($isElementNode(node) || $isTextNode(node)) node.selectStart();
      else { const selection = $createNodeSelection(); selection.add(key); $setSelection(selection); }
    }, { onUpdate: () => { if (key) editor.getElementByKey(key)?.scrollIntoView({ block: "center" }); } });
    setMessage("已定位到正文对应位置。");
  }

  return <><WritingRecovery owner={recovery} draft={draft} read={read} apply={apply} locked={locked} />
  <details className="nw-writing-tools" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>文稿工具：检查、大纲、替换与本机备份</summary>
    {open ? <div className="nw-writing-tools-body">
      <div className="nw-authoring-actions" role="group" aria-label="选择文稿工具">
        <button className="nw-btn" type="button" aria-pressed={panel === "inspection"} onClick={() => setPanel("inspection")}>文稿检查与大纲</button>
        <button className="nw-btn" type="button" aria-pressed={panel === "replacement"} onClick={() => setPanel("replacement")}>正文查找替换</button>
        <button className="nw-btn" type="button" aria-pressed={panel === "backup"} onClick={() => setPanel("backup")}>本机备份与恢复</button>
      </div>
      {panel === "inspection" && inspection ? <InspectionPanel inspection={inspection} draft={draft} navigate={navigate} /> : null}
      {panel === "replacement" ? <ReplacementPanel draft={draft} read={read} apply={apply} locked={locked} navigate={navigateMatch} /> : null}
      {panel === "backup" ? <BackupPanel draft={draft} read={read} apply={apply} locked={locked} /> : null}
      {message ? <p role="status">{message}</p> : null}
      <div className="nw-writing-deep">
        <p className="nw-kicker">深度校对与分析 · 新标签页打开</p>
        <div className="nw-authoring-actions nw-writing-deep-links">
          <Link className="nw-btn" href="/write/overlap" target="_blank" rel="noopener noreferrer">段落审阅 ↗</Link>
          <Link className="nw-btn" href="/write/terms" target="_blank" rel="noopener noreferrer">术语审阅 ↗</Link>
          <Link className="nw-btn" href="/write/cadence" target="_blank" rel="noopener noreferrer">标点与节奏 ↗</Link>
          <Link className="nw-btn" href="/write/parallel" target="_blank" rel="noopener noreferrer">双语对照 ↗</Link>
          <Link className="nw-btn" href="/write/collections" target="_blank" rel="noopener noreferrer">文稿集合 ↗</Link>
          <Link className="nw-btn" href="/write/merge" target="_blank" rel="noopener noreferrer">三方合并 ↗</Link>
          <Link className="nw-btn" href="/write/vault" target="_blank" rel="noopener noreferrer">加密备份 ↗</Link>
        </div>
      </div>
    </div> : null}
  </details></>;
}
