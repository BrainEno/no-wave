"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { $createParagraphNode, $getSelection, $insertNodes, $isRangeSelection, defineExtension, FORMAT_TEXT_COMMAND, REDO_COMMAND, UNDO_COMMAND, type ElementNode } from "lexical";
import { ArticleImageNode, $createArticleImageNode } from "./article-image-node.tsx";
import { InlineConfirm, InlineForm, type InlineFormErrors } from "@/components/ui/inline-form.tsx";
import { AUTHORING_LOCALE_LABELS, AUTHORING_LOCALES, NO_CREATE_INTENT, beginCreateIntent, finishCreateIntent, isAuthoringLocale, resolveAuthoringLocale, type CreateIntent } from "@/lib/authoring-save.ts";
import type { WorkType } from "@/lib/content.ts";
import { sanitizeEditorHref } from "@/lib/editor-href.ts";
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
  onDeleted(article: AuthoringArticle): void;
};

const extensionDependencies = [
  RichTextExtension,
  HistoryExtension,
  ClipboardDOMImportExtension,
  LinkExtension,
  ListExtension,
  CodeExtension,
];

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

/** The API's own words for a failed upload, or a fallback that at least says so. */
function uploadError(payload: unknown, fallback: string): string {
  if (typeof payload === "object" && payload !== null && "error" in payload) {
    const message = (payload as { error?: { message?: unknown } }).error?.message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return fallback;
}

/** The address an upload answers with, or `null` when it is not one of ours. */
function uploadedSrc(payload: unknown): string | null {
  const data = typeof payload === "object" && payload !== null && "data" in payload
    ? (payload as { data?: unknown }).data : null;
  if (!data || typeof data !== "object" || !("src" in data)) return null;
  const src = (data as { src?: unknown }).src;
  return typeof src === "string" && /^\/api\/media\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(src)
    ? src
    : null;
}

type ImageDraft = { file: File; alt: string; caption: string };

function Toolbar({ onStatus, onError }: { onStatus(message: string): void; onError(message: string): void }) {
  const [editor] = useLexicalComposerContext();
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  /** 链接浮层；`null` 表示关着。 */
  const [linkOpen, setLinkOpen] = useState(false);
  /** 已选好文件、正在补 alt 与说明的那张图。 */
  const [imageDraft, setImageDraft] = useState<ImageDraft | null>(null);
  const setBlock = useCallback((createNode: () => ElementNode) => {
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) $setBlocksType(selection, createNode);
    });
  }, [editor]);

  /**
   * 插入链接。
   *
   * 先校验再关浮层：地址不合法时错误留在输入框下面（`aria-describedby` 关联），
   * 而不是像 `window.alert` 那样弹一句没有归属的话然后清空一切。
   */
  function submitLink(values: Record<string, string>): InlineFormErrors {
    const href = sanitizeEditorHref(values.url ?? "");
    if (!href) return { url: "请输入有效的 HTTP(S) 链接或站内绝对路径。" };
    editor.dispatchCommand(TOGGLE_LINK_COMMAND, href);
    setLinkOpen(false);
    return null;
  }

  /**
   * 上传并插入图片。
   *
   * 上传失败时浮层**不关**：作者刚写好的替代文本还在，改一下就能重试，不必从头
   * 再选一次文件。`window.prompt` 做不到这一点，它只能返回 `null` 并丢掉一切。
   */
  async function submitImage(values: Record<string, string>): Promise<InlineFormErrors> {
    const draft = imageDraft;
    if (!draft) return { alt: "请重新选择图片。" };
    const alt = (values.alt ?? "").trim();
    const caption = (values.caption ?? "").trim();
    if (!alt) return { alt: "图片替代文本不能为空。" };
    if (alt.length > 500) return { alt: "图片替代文本不得超过 500 字符。" };
    if (caption.length > 1000) return { caption: "图片说明不得超过 1000 字符。" };
    setUploading(true);
    onError("");
    onStatus("正在安全处理并上传图片……");
    try {
      const response = await fetch("/api/authoring/media", {
        method: "POST",
        headers: { "content-type": draft.file.type, accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: draft.file,
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) return { alt: uploadError(payload, "图片上传失败，请稍后重试。") };
      const src = uploadedSrc(payload);
      if (!src) return { alt: "上传服务返回了无效的图片地址。" };
      editor.update(() => {
        $insertNodes([$createArticleImageNode({ src, alt, caption })]);
      });
      onStatus("图片已上传并插入正文。");
      setImageDraft(null);
      return null;
    } catch {
      return { alt: "图片上传失败，请检查网络后重试。" };
    } finally {
      setUploading(false);
    }
  }

  /** 选好文件后先校验格式与大小，通过才打开补全信息的浮层。 */
  function chooseImage(file: File | undefined) {
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      onError("图片只支持 JPEG、PNG 与 WebP 格式。");
      return;
    }
    if (file.size < 1 || file.size > 8 * 1024 * 1024) {
      onError("单张图片大小必须大于 0 且不超过 8 MiB。");
      return;
    }
    onError("");
    setImageDraft({ file, alt: "", caption: "" });
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
      <button type="button" onClick={() => setLinkOpen(true)}>链接</button>
      <button type="button" disabled={uploading} onClick={() => fileInput.current?.click()}>{uploading ? "上传图片中…" : "插入图片"}</button>
      <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" aria-label="选择要上传的图片" hidden onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; chooseImage(file); }} />
      <button type="button" onClick={() => setBlock(() => $createCodeNode())}>代码块</button>
      <button type="button" onClick={() => editor.dispatchCommand(UNDO_COMMAND, undefined)} aria-label="撤销">撤销</button>
      <button type="button" onClick={() => editor.dispatchCommand(REDO_COMMAND, undefined)} aria-label="重做">重做</button>
      {linkOpen ? (
        <InlineForm
          title="插入链接"
          description="选中的文字会变成链接。只接受 HTTP(S) 网址或站内绝对路径。"
          fields={[{ name: "url", label: "链接地址", placeholder: "https://example.com 或 /articles/…", required: true, maxLength: 2048 }]}
          submitLabel="插入链接"
          onSubmit={submitLink}
          onCancel={() => setLinkOpen(false)}
        />
      ) : null}
      {imageDraft ? (
        <InlineForm
          title="插入图片"
          description={`已选择 ${imageDraft.file.name}。上传后会被重编码为 WebP。`}
          fields={[
            {
              name: "alt",
              label: "替代文本",
              required: true,
              maxLength: 500,
              hint: "给看不到图片的读者：屏幕阅读器会读这一句。请描述图片本身，而不是它的用途。",
            },
            { name: "caption", label: "图片说明", multiline: true, maxLength: 1000, hint: "显示在图片下方的说明文字，可留空。" },
          ]}
          submitLabel={uploading ? "正在上传…" : "上传并插入"}
          onSubmit={submitImage}
          onCancel={() => { if (!uploading) setImageDraft(null); }}
          validate={(values) => {
            if (!(values.alt ?? "").trim()) return { alt: "图片替代文本不能为空。" };
            return null;
          }}
        />
      ) : null}
    </div>
  );
}

/** @param fallback — the message shown when the API did not say why it failed. */
function apiError(payload: unknown, fallback = "保存失败，请检查网络后重试。"): string {
  if (typeof payload === "object" && payload !== null && "error" in payload) {
    const error = (payload as { error?: { message?: unknown } }).error;
    if (error && typeof error.message === "string") return error.message;
  }
  return fallback;
}

function isSavedArticle(value: unknown): value is AuthoringArticle {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<AuthoringArticle>;
  return typeof item.id === "string" && typeof item.slug === "string" &&
    typeof item.title === "string" && (item.status === "draft" || item.status === "published") &&
    Array.isArray(item.contentBlocks);
}

/**
 * The work types an author can pick.
 *
 * `serial` is deliberately absent (issue #168, ADR 0016): the platform decided it
 * publishes short and medium-length work, not serialized novels, so offering the
 * option makes a promise the product does not keep. A work that already *is*
 * `serial` is still readable — `workTypeOptions` below adds it back for display
 * only, because silently relabelling somebody's existing work as "其他" would
 * rewrite their own description of it.
 */
const workTypes: { value: WorkType; label: string }[] = [
  { value: "novel", label: "小说" },
  { value: "short_story", label: "短篇小说" },
  { value: "poetry", label: "诗歌" },
  { value: "essay", label: "随笔" },
  { value: "criticism", label: "评论" },
  { value: "literary_criticism", label: "文学批评" },
  { value: "nonfiction", label: "非虚构" },
  { value: "other", label: "其他" },
];

/** The retired type, kept only so an existing work still shows what it is. */
const SERIAL_WORK_TYPE = { value: "serial" as WorkType, label: "连载（历史作品）" };

/**
 * The options a given work gets: the current list, plus its own retired type when
 * it has one.
 *
 * This is the whole compatibility story for `serial` — no data migration, no
 * silent rewrite, and a new work can never choose it.
 */
export function workTypeOptions(current: WorkType): { value: WorkType; label: string }[] {
  return current === "serial" ? [...workTypes, SERIAL_WORK_TYPE] : workTypes;
}

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

export function ArticleEditor({ article, onSaved, onDeleted }: ArticleEditorProps) {
  const [initialState] = useState<LexicalEditorStateJson | null>(() => {
    try { return articleBlocksToLexicalEditorState(article?.contentBlocks); }
    catch { return null; }
  });
  const [editorState, setEditorState] = useState<LexicalEditorStateJson | null>(initialState);
  const [title, setTitle] = useState(article?.title ?? "");
  const [summary, setSummary] = useState(article?.summary ?? "");
  const [workType, setWorkType] = useState<WorkType>(article?.workType ?? "other");
  const [chosenLocale, setChosenLocale] = useState<string | null>(null);
  /**
   * 作品语言。新建时可选，编辑既有作品时锁定为作品自己的语言。
   *
   * 之前这里写死 `locale: "zh-CN"`，于是英文作者写不了英文作品，而 `zh-TW`
   * 作品打开再保存会被悄悄改成简体——改了语言就等于换了译文，原文一个字没动。
   */
  const locale = resolveAuthoringLocale(article, chosenLocale);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  /**
   * 待完成的一次「创建」意图（issue #168）。
   *
   * 弱网下作者点了保存、请求超时、又点一次，服务端会看到两个请求。带同一个
   * `Idempotency-Key` 时第二次是重放，不是第二篇作品；成功之后键作废，下一次
   * 点击就是新意图。编辑既有作品不带键——`PUT` 本来就是幂等的。
   */
  const [createIntent, setCreateIntent] = useState<CreateIntent>(NO_CREATE_INTENT);
  const [confirming, setConfirming] = useState<"delete" | "unpublish" | null>(null);

  const extension = useMemo(() => initialState ? defineExtension({
    name: "@no-wave/article-authoring",
    namespace: "no-wave-article-authoring",
    dependencies: extensionDependencies,
    nodes: [ArticleImageNode],
    theme: editorTheme,
    $initialEditorState: JSON.stringify(initialState),
  }) : null, [initialState]);

  const onEditorChange = useCallback((next: LexicalEditorStateJson) => setEditorState(next), []);

  /**
   * Save the document in the state the button asks for.
   *
   * `intent` names the target state rather than toggling a flag: a published
   * work that is saved again stays published, and 转为草稿 is the one save that
   * asks for the draft state explicitly. With a boolean the two cannot be told
   * apart — `publish: false` had to mean "leave the status alone" for a work
   * that was already public, which is precisely what unpublishing needs to say.
   */
  async function save(intent: "draft" | "publish") {
    if (!title.trim()) { setError("请填写作品标题。"); return; }
    if (!editorState) { setError("编辑器内容尚未初始化，请重新载入页面。"); return; }
    if (!collectPlainText(editorState.root).trim()) { setError("请先输入正文内容。"); return; }
    const wasPublished = article?.status === "published";
    // 新建作品才需要幂等键：一次点击 = 一次意图，重试复用，成功后作废。
    const pending = article ? null : beginCreateIntent(createIntent, () => crypto.randomUUID());
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const response = await fetch(article ? `/api/authoring/articles/${encodeURIComponent(article.id)}` : "/api/authoring/articles", {
        method: article ? "PUT" : "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          // The proxy forwards this header verbatim (`web-http/src/policy.ts`),
          // so the retry is recognisable as the same intent on the other side.
          ...(pending ? { "idempotency-key": pending.key } : {}),
        },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({
          // New articles let the API derive the slug from the title; existing
          // ones are addressed by the slug they already have.
          ...(article ? { slug: article.slug } : {}),
          title: title.trim(),
          summary: summary.trim(),
          locale,
          workType,
          editorState,
          contentBlocksVersion: 1,
          publish: intent === "publish",
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiError(payload));
      const data = typeof payload === "object" && payload !== null && "data" in payload ? (payload as { data?: unknown }).data : null;
      if (!isSavedArticle(data)) throw new Error("API 响应格式不正确，作品可能已保存，请刷新列表核对。");
      if (pending) setCreateIntent(finishCreateIntent(pending.intent, true));
      onSaved(data);
      // Withdrawing a work is not the same message as saving one: the address
      // the author was given a minute ago is the address that just stopped
      // answering, so say so instead of pointing at it.
      setStatus(wasPublished && intent === "draft"
        ? "作品已转为草稿，公开页面已不可访问；重新发布即可恢复同一地址。"
        : `${data.status === "published" ? "作品已发布。" : "草稿已保存。"} 作品地址：/articles/${data.slug}`);
    } catch (caught) {
      // 失败保留键：作者再点一次是重试，不是第二篇作品。
      if (pending) setCreateIntent(finishCreateIntent(pending.intent, false));
      setError(caught instanceof Error ? caught.message : "保存失败，请重试。");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Delete the open work.
   *
   * The API soft-deletes it: the row stays, the work leaves every list, and the
   * recycle bin is where it goes. The confirmation therefore has to say three
   * things rather than one — what happens now (the desk and the public page lose
   * it at once), how far the author can undo it (the recycle bin, until the
   * sweep), and what undoing it later cannot save (the comments under it). It
   * used to promise "无法恢复"; with a recycle bin behind the button, that was a
   * lie the desk was telling about its own feature.
   */
  async function destroy() {
    if (!article) return;
    setConfirming(null);
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const response = await fetch(`/api/authoring/articles/${encodeURIComponent(article.id)}`, {
        method: "DELETE",
        headers: { accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiError(payload, "删除失败，请检查网络后重试。"));
      onDeleted(article);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "删除失败，请重试。");
    } finally {
      setBusy(false);
    }
  }

  if (!initialState || !extension) {
    return <p className="nw-auth-error" role="alert">此作品含有当前编辑器尚不支持的内容块（例如带署名的引用）。没有修改任何内容；请先返回作品列表。</p>;
  }

  return (
    <section className="nw-article-editor" aria-label="作品编辑器">
      <div className="nw-article-fields">
        <label className="nw-field-wide">标题
          <input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={200} />
        </label>
        <p className="nw-field-note">作品地址（slug）由系统根据标题自动生成，无需填写。</p>
        <label>作品类型
          <select value={workType} onChange={(event) => setWorkType(event.target.value as WorkType)}>
            {workTypeOptions(workType).map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        <label>作品语言
          <select
            value={locale}
            disabled={Boolean(article)}
            aria-describedby="nw-editor-locale-note"
            onChange={(event) => setChosenLocale(event.target.value)}
          >
            {/*
              编辑既有作品时语言是锁定的：保存一份已存在的作品不能改变它的语言，
              那会把这篇作品的译文换成另一种语言，而原文并没有变。旧作品的语言
              即使不在当前可选列表里（例如 zh-TW），也照样在这里显示出来。
            */}
            {(isAuthoringLocale(locale) ? AUTHORING_LOCALES : [locale]).map((value) => (
              <option key={value} value={value}>
                {isAuthoringLocale(value) ? AUTHORING_LOCALE_LABELS[value] : value}
              </option>
            ))}
          </select>
        </label>
        <p className="nw-field-note" id="nw-editor-locale-note">
          {article
            ? "作品语言在创建后不可更改；如需另一种语言，请另建一篇。"
            : "作品将会发布到所选语言的栏目。中文与英文可以分别发表。"}
        </p>
        <label className="nw-field-wide">摘要
          <textarea value={summary} onChange={(event) => setSummary(event.target.value)} maxLength={2000} placeholder="留空则由系统摘取正文开头自动生成" />
        </label>
      </div>
      <LexicalExtensionComposer extension={extension} contentEditable={null}>
        <Toolbar onStatus={setStatus} onError={setError} />
        <div className="nw-lexical-shell">
          <ContentEditable className="nw-lexical-input" aria-label="作品正文" aria-placeholder="从这里开始写作" placeholder={<p className="nw-lexical-placeholder">从这里开始写作……</p>} />
        </div>
        <EditorStatePlugin onChange={onEditorChange} />
      </LexicalExtensionComposer>
      <p className="nw-lexical-empty-note">支持段落、二至四级标题、引用、列表、文本格式、链接、代码块及经服务端安全处理的图片。每张图片都会被重编码为 WebP；图片上传需配置 S3 兼容存储。</p>
      {error ? <p className="nw-auth-error" role="alert">{error}</p> : null}
      {status ? <p className="nw-auth-status" role="status">{status}</p> : null}
      <div className="nw-authoring-actions">
        {article ? <button className="nw-btn" type="button" disabled={busy} onClick={() => setConfirming("delete")}>删除作品</button> : null}
        <button className="nw-btn" type="button" disabled={busy} onClick={() => void save(article?.status === "published" ? "publish" : "draft")}>{busy ? "保存中…" : article?.status === "published" ? "保存更新" : "保存草稿"}</button>
        <button className="nw-btn nw-pri" type="button" disabled={busy} onClick={() => void save("publish")}>{busy ? "正在保存…" : article?.status === "published" ? "保存并发布" : "发布作品"}</button>
        {article && article.status === "published" ? (
          <>
            {/* Withdrawing a public page is one click and it takes the address
                away from anyone who was reading it, so the desk asks first. */}
            <button className="nw-btn" type="button" disabled={busy} onClick={() => setConfirming("unpublish")}>转为草稿</button>
            <a className="nw-btn" href={`/articles/${encodeURIComponent(article.slug)}`} target="_blank" rel="noreferrer">查看已发布作品 ↗</a>
          </>
        ) : null}
      </div>
      {confirming === "delete" && article ? (
        <InlineConfirm
          title={`删除《${article.title}》？`}
          danger
          confirmLabel="删除作品"
          body={
            <>
              <p>作品会立刻从写作台移除，已发布的页面也会立即不可访问。</p>
              <p>删除后可在回收站还原，但到期自动清除时，这篇作品下的评论会一起消失。</p>
            </>
          }
          onConfirm={() => void destroy()}
          onCancel={() => setConfirming(null)}
        />
      ) : null}
      {confirming === "unpublish" && article ? (
        <InlineConfirm
          title="转为草稿？"
          confirmLabel="转为草稿"
          body={<p>转为草稿后，<code>/articles/{article.slug}</code> 将对读者不可访问（内容会保留在写作台），重新发布即可恢复同一地址。</p>}
          onConfirm={() => { setConfirming(null); void save("draft"); }}
          onCancel={() => setConfirming(null)}
        />
      ) : null}
    </section>
  );
}
