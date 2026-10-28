"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalExtensionComposer } from "@lexical/react/LexicalExtensionComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ClipboardDOMImportExtension } from "@lexical/clipboard";
import { $createCodeNode, CodeExtension } from "@lexical/code";
import { HistoryExtension } from "@lexical/history";
import { LinkExtension, TOGGLE_LINK_COMMAND } from "@lexical/link";
import { INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND, ListExtension } from "@lexical/list";
import { $createHeadingNode, $createQuoteNode, RichTextExtension } from "@lexical/rich-text";
import { $setBlocksType } from "@lexical/selection";
import { $createParagraphNode, $getSelection, $isRangeSelection, defineExtension, FORMAT_TEXT_COMMAND, REDO_COMMAND, UNDO_COMMAND, type ElementNode } from "lexical";
import type { WorkType } from "@/lib/content.ts";
import { articleBlocksToLexicalEditorState, type LexicalEditorStateJson } from "@/lib/lexical-article-state.ts";

export type AuthoringArticle = {
  id: string;
  slug: string;
  title: string;
  summary: string;
  locale: string;
  workType: WorkType;
  status: "draft" | "published";
  contentBlocks: unknown[];
  contentBlocksVersion: number;
  updatedAt?: string;
  publishedAt?: string | null;
};

type ArticleEditorProps = {
  article: AuthoringArticle | null;
  onSaved(article: AuthoringArticle): void;
};

const extensionDependencies = [
  RichTextExtension,
  HistoryExtension,
  ClipboardDOMImportExtension,
  LinkExtension,
  ListExtension,
  CodeExtension,
] as const;

const editorTheme = {
  paragraph: "nw-lexical-paragraph",
  heading: { h2: "nw-lexical-heading-2", h3: "nw-lexical-heading-3", h4: "nw-lexical-heading-4" },
  quote: "nw-lexical-quote",
  list: { ol: "nw-lexical-ordered-list", ul: "nw-lexical-unordered-list", listitem: "nw-lexical-list-item" },
  text: { bold: "nw-lexical-bold", italic: "nw-lexical-italic", underline: "nw-lexical-underline", strikethrough: "nw-lexical-strikethrough", code: "nw-lexical-inline-code" },
  code: "nw-lexical-code",
};

function EditorStatePlugin({ onChange }: { onChange(state: LexicalEditorStateJson): void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => editor.registerUpdateListener(({ editorState }) => {
    onChange(editorState.toJSON() as LexicalEditorStateJson);
  }), [editor, onChange]);
  return null;
}

function Toolbar() {
  const [editor] = useLexicalComposerContext();
  const setBlock = useCallback((createNode: () => ElementNode) => {
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) $setBlocksType(selection, createNode);
    });
  }, [editor]);

  function addLink() {
    const url = window.prompt("输入链接（https:// 或站内绝对路径）");
    if (url === null) return;
    const candidate = url.trim();
    if (!candidate || candidate.startsWith("//") || /[\u0000-\u0020\u007f\\]/.test(candidate)) {
      window.alert("请输入有效的 HTTP(S) 链接或站内绝对路径。");
      return;
    }
    if (!candidate.startsWith("/")) {
      try {
        const parsed = new URL(candidate);
        if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) throw new Error("unsafe");
      } catch {
        window.alert("链接仅支持有效的 HTTP(S) URL 或站内绝对路径。");
        return;
      }
    }
    editor.dispatchCommand(TOGGLE_LINK_COMMAND, candidate);
  }

  return (
    <div className="nw-lexical-toolbar" role="toolbar" aria-label="富文本格式">
      <button type="button" onClick={() => setBlock(() => $createParagraphNode())}>段落</button>
      <button type="button" onClick={() => setBlock(() => $createHeadingNode("h2"))}>H2</button>
      <button type="button" onClick={() => setBlock(() => $createHeadingNode("h3"))}>H3</button>
      <button type="button" onClick={() => setBlock(() => $createHeadingNode("h4"))}>H4</button>
      <button type="button" onClick={() => setBlock(() => $createQuoteNode())}>引用</button>
      <button type="button" onClick={() => editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined)}>无序列表</button>
      <button type="button" onClick={() => editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined)}>有序列表</button>
      <button type="button" onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold")}><strong>B</strong></button>
      <button type="button" onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "italic")}><em>I</em></button>
      <button type="button" onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "underline")}><u>U</u></button>
      <button type="button" onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "strikethrough")}><s>S</s></button>
      <button type="button" onClick={addLink}>链接</button>
      <button type="button" onClick={() => setBlock(() => $createCodeNode())}>代码块</button>
      <button type="button" onClick={() => editor.dispatchCommand(UNDO_COMMAND, undefined)} aria-label="撤销">撤销</button>
      <button type="button" onClick={() => editor.dispatchCommand(REDO_COMMAND, undefined)} aria-label="重做">重做</button>
    </div>
  );
}

function apiError(payload: unknown): string {
  if (typeof payload === "object" && payload !== null && "error" in payload) {
    const error = (payload as { error?: { message?: unknown } }).error;
    if (error && typeof error.message === "string") return error.message;
  }
  return "保存失败，请检查网络后重试。";
}

function isSavedArticle(value: unknown): value is AuthoringArticle {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<AuthoringArticle>;
  return typeof item.id === "string" && typeof item.slug === "string" &&
    typeof item.title === "string" && (item.status === "draft" || item.status === "published") &&
    Array.isArray(item.contentBlocks);
}

const workTypes: { value: WorkType; label: string }[] = [
  { value: "novel", label: "小说" },
  { value: "short_story", label: "短篇小说" },
  { value: "poetry", label: "诗歌" },
  { value: "essay", label: "随笔" },
  { value: "criticism", label: "评论" },
  { value: "literary_criticism", label: "文学批评" },
  { value: "nonfiction", label: "非虚构" },
  { value: "serial", label: "连载" },
  { value: "other", label: "其他" },
];

function collectPlainText(value: unknown): string {
  let result = "";
  function visit(node: unknown): void {
    if (!node || typeof node !== "object") return;
    const item = node as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string") result += item.text;
    if (Array.isArray(item.children)) item.children.forEach(visit);
  }
  visit(value);
  return result;
}

export function ArticleEditor({ article, onSaved }: ArticleEditorProps) {
  const [initialState] = useState<LexicalEditorStateJson | null>(() => {
    try { return articleBlocksToLexicalEditorState(article?.contentBlocks); }
    catch { return null; }
  });
  const [editorState, setEditorState] = useState<LexicalEditorStateJson | null>(initialState);
  const [title, setTitle] = useState(article?.title ?? "");
  const [slug, setSlug] = useState(article?.slug ?? "");
  const [summary, setSummary] = useState(article?.summary ?? "");
  const [workType, setWorkType] = useState<WorkType>(article?.workType ?? "other");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  const extension = useMemo(() => initialState ? defineExtension({
    name: "@no-wave/article-authoring",
    namespace: "no-wave-article-authoring",
    dependencies: extensionDependencies,
    theme: editorTheme,
    $initialEditorState: initialState,
  }) : null, [initialState]);

  const onEditorChange = useCallback((next: LexicalEditorStateJson) => setEditorState(next), []);

  async function save(publish: boolean) {
    if (!title.trim()) { setError("请填写作品标题。"); return; }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) { setError("slug 仅支持小写英文字母、数字和单个连字符。"); return; }
    if (!editorState) { setError("编辑器内容尚未初始化，请重新载入页面。"); return; }
    if (!collectPlainText(editorState.root).trim()) { setError("请先输入正文内容。"); return; }
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const response = await fetch(article ? `/api/authoring/articles/${encodeURIComponent(article.id)}` : "/api/authoring/articles", {
        method: article ? "PUT" : "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({
          slug: slug.trim(),
          title: title.trim(),
          summary: summary.trim(),
          locale: "zh-CN",
          workType,
          editorState,
          contentBlocksVersion: 1,
          publish: publish || article?.status === "published",
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiError(payload));
      const data = typeof payload === "object" && payload !== null && "data" in payload ? (payload as { data?: unknown }).data : null;
      if (!isSavedArticle(data)) throw new Error("API 响应格式不正确，作品可能已保存，请刷新列表核对。");
      onSaved(data);
      setStatus(data.status === "published" ? "作品已发布。" : "草稿已保存。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存失败，请重试。");
    } finally {
      setBusy(false);
    }
  }

  if (!initialState || !extension) {
    return <p className="nw-auth-error" role="alert">此作品含有当前编辑器尚不支持的内容块（例如图片或带署名的引用）。没有修改任何内容；请先返回作品列表。图片编辑会在媒体上传工作流完成后接入。</p>;
  }

  return (
    <section className="nw-article-editor" aria-label="作品编辑器">
      <div className="nw-article-fields">
        <label className="nw-field-wide">标题
          <input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={200} />
        </label>
        <label>作品地址 slug
          <input value={slug} onChange={(event) => setSlug(event.target.value)} required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" maxLength={120} autoCapitalize="none" />
        </label>
        <label>作品类型
          <select value={workType} onChange={(event) => setWorkType(event.target.value as WorkType)}>
            {workTypes.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        <label className="nw-field-wide">摘要
          <textarea value={summary} onChange={(event) => setSummary(event.target.value)} maxLength={2000} />
        </label>
      </div>
      <LexicalExtensionComposer extension={extension} contentEditable={null}>
        <Toolbar />
        <div className="nw-lexical-shell">
          <ContentEditable className="nw-lexical-input" aria-label="作品正文" aria-placeholder="从这里开始写作" placeholder={<p className="nw-lexical-placeholder">从这里开始写作……</p>} />
        </div>
        <EditorStatePlugin onChange={onEditorChange} />
      </LexicalExtensionComposer>
      <p className="nw-lexical-empty-note">支持段落、二至四级标题、引用、列表、粗体、斜体、下划线、删除线、链接与代码块。当前版本暂不支持插入图片。</p>
      {error ? <p className="nw-auth-error" role="alert">{error}</p> : null}
      {status ? <p className="nw-auth-status" role="status">{status}</p> : null}
      <div className="nw-authoring-actions">
        <button className="nw-btn" type="button" disabled={busy} onClick={() => void save(false)}>{busy ? "保存中…" : article?.status === "published" ? "保存更新" : "保存草稿"}</button>
        <button className="nw-btn nw-pri" type="button" disabled={busy} onClick={() => void save(true)}>{busy ? "正在保存…" : article?.status === "published" ? "保存并发布" : "发布作品"}</button>
        {article?.status === "published" ? <a className="nw-btn" href={`/articles/${encodeURIComponent(article.slug)}`} target="_blank" rel="noreferrer">查看已发布作品 ↗</a> : null}
      </div>
    </section>
  );
}
