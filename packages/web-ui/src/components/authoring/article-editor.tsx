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
import { PromptDialog, type PromptDialogField } from "@/components/ui/prompt-dialog.tsx";
import { useConfirm } from "@/components/ui/confirm-dialog.tsx";
import { AUTHORING_ARTICLE_ID_PATTERN, AUTHORING_EXPECTED_ACTOR_HEADER, AUTHORING_NOT_FORWARDED_HEADER, isAuthoringLocale } from "@bot-thk/web-http";
import { Link } from "@/lib/framework/link.tsx";
import { IDEMPOTENCY_KEY_HEADER, intentForAttempt, type PendingIntent } from "@/lib/idempotency-key.ts";
import type { WorkType } from "@/lib/content.ts";
import { sanitizeEditorHref } from "@/lib/editor-href.ts";
import { articleBlocksToLexicalEditorState, type LexicalEditorStateJson } from "@/lib/lexical-article-state.ts";

export type AuthoringArticle = {
  id: string;
  revision?: string;
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
  viewerId: string | null;
  onSaved(article: AuthoringArticle): void;
  onDeleted(article: AuthoringArticle): void;
  onPendingChange(pending: boolean): void;
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

function Toolbar({
  onStatus,
  onError,
  ask,
}: {
  onStatus(message: string): void;
  onError(message: string): void;
  /**
   * Collects form values in a dialog instead of `window.prompt` (#195). Resolves
   * to `null` when the writer cancels, which is the same signal `prompt()`
   * returned — except that it also works in the WebViews that return `null` from
   * `prompt()` without ever showing it.
   */
  ask(kind: "link" | "image"): Promise<Record<string, string> | null>;
}) {
  const [editor] = useLexicalComposerContext();
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const setBlock = useCallback((createNode: () => ElementNode) => {
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) $setBlocksType(selection, createNode);
    });
  }, [editor]);

  async function addLink() {
    const values = await ask("link");
    if (values === null) return;
    const href = sanitizeEditorHref(values.url ?? "");
    if (!href) {
      // The dialog validates its own fields; a URL that survives the dialog but
      // fails `sanitizeEditorHref` is a protocol the form cannot know about yet,
      // so it is reported in the same place the toolbar reports everything else
      // rather than in a modal the writer has to dismiss.
      onError("请输入有效的 HTTP(S) 链接或站内绝对路径。");
      return;
    }
    onError("");
    editor.dispatchCommand(TOGGLE_LINK_COMMAND, href);
  }

  async function uploadImage(file: File | undefined) {
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      onError("图片只支持 JPEG、PNG 与 WebP 格式。");
      return;
    }
    if (file.size < 1 || file.size > 8 * 1024 * 1024) {
      onError("单张图片大小必须大于 0 且不超过 8 MiB。");
      return;
    }
    // Alt text and caption are asked for together, in one dialog, instead of in
    // two sequential `prompt()` calls — the second of which used to be the one
    // that could silently never appear.
    const values = await ask("image");
    if (values === null) return;
    const alt = values.alt ?? "";
    const caption = values.caption ?? "";
    if (!alt.trim() || alt.trim().length > 500) {
      onError("图片替代文本不能为空，且不得超过 500 字符。");
      return;
    }
    if (caption.length > 1000) {
      onError("图片说明不得超过 1000 字符。");
      return;
    }
    setUploading(true);
    onError("");
    onStatus("正在安全处理并上传图片……");
    try {
      const response = await fetch("/api/authoring/media", {
        method: "POST",
        headers: { "content-type": file.type, accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: file,
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message = typeof payload === "object" && payload !== null && "error" in payload
          ? (payload as { error?: { message?: unknown } }).error?.message : undefined;
        throw new Error(typeof message === "string" ? message : "图片上传失败，请稍后重试。");
      }
      const data = typeof payload === "object" && payload !== null && "data" in payload
        ? (payload as { data?: unknown }).data : null;
      if (!data || typeof data !== "object" || !("src" in data) ||
        typeof (data as { src?: unknown }).src !== "string" ||
        !/^\/api\/media\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test((data as { src: string }).src)) {
        throw new Error("上传服务返回了无效的图片地址。");
      }
      const src = (data as { src: string }).src;
      editor.update(() => {
        $insertNodes([$createArticleImageNode({ src, alt: alt.trim(), caption: caption.trim() })]);
      });
      onStatus("图片已上传并插入正文。");
    } catch (caught) {
      onStatus("");
      onError(caught instanceof Error ? caught.message : "图片上传失败，请稍后重试。");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
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
      <button type="button" disabled={uploading} onClick={() => fileInput.current?.click()}>{uploading ? "上传图片中…" : "插入图片"}</button>
      <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" aria-label="选择要上传的图片" hidden onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; void uploadImage(file); }} />
      <button type="button" onClick={() => setBlock(() => $createCodeNode())}>代码块</button>
      <button type="button" onClick={() => editor.dispatchCommand(UNDO_COMMAND, undefined)} aria-label="撤销">撤销</button>
      <button type="button" onClick={() => editor.dispatchCommand(REDO_COMMAND, undefined)} aria-label="重做">重做</button>
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
  // A 2xx with a partial article cannot safely retire a create key: the write
  // may have committed, but the editor cannot yet treat the result as a work.
  return typeof item.id === "string" && AUTHORING_ARTICLE_ID_PATTERN.test(item.id) &&
    typeof item.slug === "string" && item.slug.length <= 160 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.slug) &&
    typeof item.title === "string" && item.title.trim().length > 0 &&
    typeof item.summary === "string" && typeof item.locale === "string" && isAuthoringLocale(item.locale) &&
    (item.workType === "serial" || workTypes.some(({ value: type }) => type === item.workType)) &&
    (item.status === "draft" || item.status === "published") &&
    Array.isArray(item.contentBlocks) && item.contentBlocks.length > 0 &&
    (item.contentBlocksVersion === 0 || item.contentBlocksVersion === 1) &&
    (item.updatedAt === undefined || typeof item.updatedAt === "string") &&
    (item.publishedAt === undefined || item.publishedAt === null || typeof item.publishedAt === "string");
}

/**
 * The types a *new* work can be created as.
 *
 * `serial` is deliberately absent: ADR 0016 and `38d087b` settled that the
 * platform is for short and medium-form work, but the type was still offered
 * here, so a new work could be born in a shape the product does not support
 * (#196). It stays in the type union and in the reader's filter tabs, because
 * works created before that decision still have to be listed and read — this
 * list is about what can be *chosen*, not about what can exist.
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

/** Types that can exist but can no longer be chosen, and how to name them. */
const retiredWorkTypes: Partial<Record<WorkType, string>> = { serial: "连载" };

/**
 * The languages a work can be *written* in (#196).
 *
 * `zh-TW` is absent on purpose. The API and storage still support it, but the
 * desk does not offer it for a new work: `zh-CN` and `en` are the authored
 * editions. An existing `zh-TW` work keeps its locale through `retiredLocales`
 * below, so opening one does not silently migrate it.
 */
const authoringLocales: { value: string; label: string }[] = [
  { value: "zh-CN", label: "简体中文（zh-CN）" },
  { value: "en", label: "English (en)" },
];

const retiredLocales: Record<string, string> = { "zh-TW": "繁體中文（zh-TW，历史版本）" };

/**
 * The two things the editor used to ask for with `window.prompt` (#195). The
 * limits are the ones the API enforces — stated here so the writer is stopped
 * before the upload rather than after it.
 */
const LINK_FIELDS: readonly PromptDialogField[] = [
  {
    name: "url",
    label: "链接地址",
    maxLength: 2048,
    required: true,
    requiredMessage: "请填写链接地址。",
    placeholder: "https://…",
  },
];

const IMAGE_FIELDS: readonly PromptDialogField[] = [
  {
    name: "alt",
    label: "替代文本",
    maxLength: 500,
    required: true,
    requiredMessage: "图片替代文本不能为空。",
    hint: "描述图片内容，会读给使用屏幕阅读器的人。",
  },
  {
    name: "caption",
    label: "图片说明",
    maxLength: 1000,
    placeholder: "可留空",
  },
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

type SaveTarget = "draft" | "publish";
type Draft = {
  title: string;
  summary: string;
  locale: string;
  workType: WorkType;
  editorState: LexicalEditorStateJson | null;
};
type PendingCreate = PendingIntent & { target: SaveTarget; mayHaveCommitted: boolean };
type LocaleChangeSave = { target: SaveTarget; article: AuthoringArticle; body: string; locale: string };

/** The public Web has zh-CN and English routes; legacy zh-TW has no Web route. */
function publicArticlePath(article: Pick<AuthoringArticle, "slug" | "locale">): string | null {
  if (article.locale !== "zh-CN" && article.locale !== "en") return null;
  return `${article.locale === "en" ? "/en" : ""}/articles/${encodeURIComponent(article.slug)}`;
}

/** Serialize once per attempt; a pending create retains these exact bytes. */
function saveBody(draft: Draft, target: SaveTarget, article: AuthoringArticle | null): string {
  return JSON.stringify({
    ...(article ? { slug: article.slug, ...(article.revision !== undefined ? { expectedRevision: article.revision } : {}) } : {}),
    title: draft.title.trim(),
    summary: draft.summary.trim(),
    locale: draft.locale,
    workType: draft.workType,
    editorState: draft.editorState,
    contentBlocksVersion: 1,
    publish: target === "publish",
  });
}

function errorCode(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) return null;
  const error = (payload as { error?: unknown }).error;
  return typeof error === "object" && error !== null && "code" in error &&
    typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : null;
}

export function ArticleEditor({ article, viewerId, onSaved, onDeleted, onPendingChange }: ArticleEditorProps) {
  const [initialState] = useState<LexicalEditorStateJson | null>(() => {
    try { return articleBlocksToLexicalEditorState(article?.contentBlocks); }
    catch { return null; }
  });
  const [editorState, setEditorState] = useState<LexicalEditorStateJson | null>(initialState);
  const [title, setTitle] = useState(article?.title ?? "");
  const [summary, setSummary] = useState(article?.summary ?? "");
  const [workType, setWorkType] = useState<WorkType>(article?.workType ?? "other");
  // An existing work keeps whatever locale it already has; a new one starts in
  // the interface's language rather than in a constant (#196).
  const [locale, setLocale] = useState<string>(article?.locale ?? "zh-CN");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [confirmedReplay, setConfirmedReplay] = useState(false);
  const [signInHelp, setSignInHelp] = useState(false);
  const [hasPending, setHasPending] = useState(false);
  const inFlight = useRef(false);
  const pending = useRef<PendingCreate | null>(null);
  // A successful create can finish before React has rendered the parent's new
  // article prop. The ref closes that gap so a fast second click is a PUT.
  const created = useRef<AuthoringArticle | null>(null);
  const blockedTarget = useRef<SaveTarget | null>(null);
  // Fields remain editable during a request. Keep their latest values outside
  // a stale async closure so success never claims later edits were saved.
  const latest = useRef<Draft>({ title, summary, locale, workType, editorState });
  // One dialog, whichever the toolbar asked for. The resolver is held in a ref
  // rather than state: it is not rendered, and recreating it would drop the
  // pending promise.
  const [askKind, setAskKind] = useState<"link" | "image" | null>(null);
  const askResolver = useRef<((values: Record<string, string> | null) => void) | null>(null);
  const { confirm, dialog: confirmDialog } = useConfirm();
  const ask = useCallback((kind: "link" | "image") => new Promise<Record<string, string> | null>((resolve) => {
    askResolver.current = resolve;
    setAskKind(kind);
  }), []);
  const settleAsk = useCallback((values: Record<string, string> | null) => {
    const resolve = askResolver.current;
    askResolver.current = null;
    setAskKind(null);
    resolve?.(values);
  }, []);

  const extension = useMemo(() => initialState ? defineExtension({
    name: "@no-wave/article-authoring",
    namespace: "no-wave-article-authoring",
    dependencies: extensionDependencies,
    nodes: [ArticleImageNode],
    theme: editorTheme,
    $initialEditorState: JSON.stringify(initialState),
  }) : null, [initialState]);

  const onEditorChange = useCallback((next: LexicalEditorStateJson) => {
    latest.current.editorState = next;
    setEditorState(next);
  }, []);

  function clearPending() {
    pending.current = null;
    blockedTarget.current = null;
    setHasPending(false);
    onPendingChange(false);
  }

  /**
   * Resolve one request. A create holds its key and original bytes until a
   * well-formed success or an explicit discard; updates remain ordinary PUTs.
   */
  async function performSave(target: SaveTarget, currentArticle: AuthoringArticle | null, body: string, create: PendingCreate | null) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setSignInHelp(false);
    setStatus("");
    setConfirmedReplay(false);
    try {
      const response = await fetch(currentArticle ? `/api/authoring/articles/${encodeURIComponent(currentArticle.id)}` : "/api/authoring/articles", {
        method: currentArticle ? "PUT" : "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(create && viewerId ? {
            [IDEMPOTENCY_KEY_HEADER]: create.key,
            [AUTHORING_EXPECTED_ACTOR_HEADER]: encodeURIComponent(viewerId),
          } : {}),
        },
        credentials: "same-origin",
        cache: "no-store",
        body,
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const code = errorCode(payload);
        if (create) {
          // HTTP status alone cannot prove a write did not happen: even a 400
          // could come from response assembly after commit. Only a same-origin
          // proxy rejection explicitly marked *not forwarded* proves this one
          // attempt did not write; an earlier ambiguous attempt still matters.
          const rejectedBeforeWrite = response.headers.get(AUTHORING_NOT_FORWARDED_HEADER) === "1";
          if (rejectedBeforeWrite && !create.mayHaveCommitted) {
            clearPending();
            setError(apiError(payload));
            return;
          }
          if (response.status === 401) {
            create.mayHaveCommitted = true;
            setSignInHelp(true);
            setError("登录状态已失效；请在新标签页登录原账户，再返回确认上次保存。");
          } else if (response.status === 409 && code === "ACCOUNT_CHANGED") {
            create.mayHaveCommitted = true;
            setSignInHelp(true);
            setError("登录账户已变化；请在新标签页登录原账户，再返回确认上次保存。");
          } else if (response.status === 409) {
            create.mayHaveCommitted = true;
            setError("上次保存的请求与已有记录冲突。请先核对作品列表，再决定是否放弃这次未确认的请求。");
          } else if (response.status === 400) {
            create.mayHaveCommitted = true;
            setError(`${apiError(payload)} 上次保存是否已创建仍需确认；请先核对作品列表。`);
          } else {
            create.mayHaveCommitted = true;
            setError("暂时无法确认作品是否已创建。请确认上次保存，或先核对作品列表。");
          }
          return;
        }
        if (code === "ARTICLE_VERSION_CONFLICT") throw new Error("作品已在其他窗口或导入中更新，本次保存未写入。当前草稿仍保留，请先复制备份，再重新打开最新作品进行合并。");
        throw new Error(apiError(payload));
      }
      const data = typeof payload === "object" && payload !== null && "data" in payload ? (payload as { data?: unknown }).data : null;
      // A plausible response for another language is not confirmation of the
      // submitted edition. Keep a create's exact retry intent until it matches.
      const requestedLocale = (JSON.parse(body) as { locale: string }).locale;
      if (!isSavedArticle(data) || data.locale !== requestedLocale) {
        if (create) {
          create.mayHaveCommitted = true;
          setError("暂时无法确认作品是否已创建：保存响应格式不正确。请确认上次保存。");
          return;
        }
        throw new Error("API 响应格式不正确，作品可能已保存，请刷新列表核对。");
      }
      const hasLaterEdits = saveBody(latest.current, target, currentArticle) !== body;
      const hasOtherAction = !!create && blockedTarget.current !== null && blockedTarget.current !== target;
      const replayed = create?.mayHaveCommitted === true;
      if (create) {
        created.current = data;
        clearPending();
      }
      onSaved(data);
      // A replay returns the *current* resource, which another tab may have
      // changed after the original create. Do not say this editor's snapshot
      // was just saved over those changes.
      const publicPath = publicArticlePath(data);
      const address = publicPath ? `作品地址：${publicPath}` : "该语言暂无公开网页地址。";
      const completion = replayed
        ? `上次创建已确认。服务器返回的是当前版本，若曾在其他页面修改，请先核对再保存。${address}`
        : currentArticle?.status === "published" && target === "draft"
          ? "作品已转为草稿，公开页面已不可访问；重新发布即可恢复同一地址。"
          : `${data.status === "published" ? "作品已发布。" : "草稿已保存。"} ${address}`;
      setConfirmedReplay(replayed);
      setStatus(`${completion}${hasLaterEdits ? " 当前修改尚未保存，请再次保存或发布。" : hasOtherAction ? " 所选操作尚未执行，请再次保存或发布。" : ""}`);
    } catch (caught) {
      if (create) {
        create.mayHaveCommitted = true;
        setError("暂时无法确认作品是否已创建。请确认上次保存，或先核对作品列表。");
      } else {
        setError(caught instanceof Error ? caught.message : "保存失败，请重试。");
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  /** Save the state the button asks for, without changing a pending intent. */
  async function save(target: SaveTarget) {
    if (inFlight.current) return;
    const draft = latest.current;
    if (!draft.title.trim()) { setError("请填写作品标题。"); return; }
    if (!draft.editorState) { setError("编辑器内容尚未初始化，请重新载入页面。"); return; }
    if (!collectPlainText(draft.editorState.root).trim()) { setError("请先输入正文内容。"); return; }
    const currentArticle = article ?? created.current;
    const body = saveBody(draft, target, currentArticle);
    if (currentArticle) {
      // A PUT to another locale upserts a translation of the same article; if
      // that translation already exists it replaces its text. Never do that as
      // a surprising consequence of changing a dropdown.
      if (draft.locale !== currentArticle.locale) {
        void askLocale({ target, article: currentArticle, body, locale: draft.locale });
      } else {
        await performSave(target, currentArticle, body, null);
      }
      return;
    }
    if (!viewerId) { setError("无法确认当前登录账户，请重新载入写作台后再保存。"); return; }
    let intent: PendingIntent | null;
    try { intent = intentForAttempt(pending.current, body); } catch {
      setError("无法生成安全的保存标识，请检查浏览器安全设置后重试。");
      return;
    }
    if (!intent) {
      blockedTarget.current = target;
      setSignInHelp(false);
      setError("上次保存可能已经创建作品；当前内容或操作已改变。请先确认上次保存，当前编辑会保留。");
      return;
    }
    const create = pending.current ?? { ...intent, target, mayHaveCommitted: false };
    pending.current = create;
    setHasPending(true);
    onPendingChange(true);
    await performSave(target, null, create.payload, create);
  }

  function retryPending() {
    const create = pending.current;
    if (!create || inFlight.current) return;
    void performSave(create.target, null, create.payload, create);
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
    const confirmed = await confirm({
      title: `删除《${article.title}》？`,
      description: "作品的所有语言版本会立刻从写作台移除，已发布的页面也会立即不可访问。\n"
        + "删除后可在回收站还原所有版本，但到期自动清除时，这篇作品下的评论会一起消失。",
      confirmLabel: "确认删除",
      tone: "danger",
    });
    if (!confirmed) return;
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

  // The address a published work lives at, or null for a draft. Computed once so
  // the withdrawal dialog and the desk's link cannot disagree about it.
  const articlePublicPath = article ? publicArticlePath(article) : null;

  /**
   * Abandon a request whose outcome is unknown.
   *
   * This is the one confirmation on the desk that warns about a duplicate rather
   * than a loss: the request may have created the work, and saving again after
   * giving up on it would create a second one. Not destructive to the text —
   * which is why it is not `tone: "danger"` — but not something to click through
   * either.
   */
  async function discardPending() {
    const confirmed = await confirm({
      title: "放弃未确认的保存？",
      description: "上次请求可能已经创建作品。放弃后再次保存可能产生重复作品，请先核对作品列表；当前输入不会被清空。",
      confirmLabel: "确认放弃",
    });
    if (!confirmed) return;
    clearPending();
    setError("");
    setSignInHelp(false);
  }

  /**
   * Saving into another language's edition overwrites that edition's title and
   * body, so a dropdown change is confirmed as a write rather than treated as a
   * view. Cancelling must leave the other edition untouched.
   */
  async function askLocale(change: LocaleChangeSave) {
    const confirmed = await confirm({
      title: "保存到其他语言？",
      description: `将内容保存到 ${change.locale} 版本，不会删除当前版本；如果目标语言已有版本，它的标题和正文会被覆盖。发布状态对所有语言版本生效。`,
      confirmLabel: "确认保存",
    });
    if (confirmed) await performSave(change.target, change.article, change.body, null);
  }

  /**
   * Withdraw a published work: the address stops serving it and readers lose it
   * where they left it, so the desk asks first.
   *
   * The dialog names the address that goes dark and says the text is kept, which
   * is the difference between "withdraw" and "delete" that a one-line browser
   * `confirm()` could not carry.
   */
  async function withdraw() {
    if (!article) return;
    const confirmed = await confirm({
      title: "转为草稿？",
      description: `转为草稿后，${articlePublicPath ?? "该作品"} 的所有语言版本将对读者不可访问（内容会保留在写作台）。`,
      confirmLabel: "确认转为草稿",
    });
    if (confirmed) void save("draft");
  }

  if (!initialState || !extension) {
    return <p className="nw-auth-error" role="alert">此作品含有当前编辑器尚不支持的内容块（例如带署名的引用）。没有修改任何内容；请先返回作品列表。</p>;
  }

  return (
    <section className="nw-article-editor" aria-label="作品编辑器">
      <div className="nw-article-fields">
        <label className="nw-field-wide">标题
          <input value={title} onChange={(event) => { latest.current.title = event.target.value; setTitle(event.target.value); }} required maxLength={200} />
        </label>
      </div>
      <LexicalExtensionComposer extension={extension} contentEditable={null}>
        <Toolbar onStatus={setStatus} onError={setError} ask={ask} />
        <div className="nw-lexical-shell">
          <ContentEditable className="nw-lexical-input" aria-label="作品正文" aria-placeholder="从这里开始写作" placeholder={<p className="nw-lexical-placeholder">从这里开始写作……</p>} />
        </div>
        <EditorStatePlugin onChange={onEditorChange} />
      </LexicalExtensionComposer>
      <div className="nw-article-fields nw-article-metadata">
        <p className="nw-field-note">作品地址（slug）由系统根据标题自动生成，无需填写。</p>
        <label>作品语言
          <select value={locale} onChange={(event) => { latest.current.locale = event.target.value; setLocale(event.target.value); }}>
            {/* Keep the stored retired option even while the author is trying
                another selection, so they can return without losing edits. */}
            {article && retiredLocales[article.locale] ? <option value={article.locale}>{retiredLocales[article.locale]}</option> : null}
            {authoringLocales.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        <label>作品类型
          <select value={workType} onChange={(event) => { latest.current.workType = event.target.value as WorkType; setWorkType(event.target.value as WorkType); }}>
            {/* An existing `serial` work keeps its type in the list, or opening
                it would silently retype it on the next save — the compatibility
                half of #196. The option is present only because the work already
                is. */}
            {retiredWorkTypes[workType] ? (
              <option value={workType}>{retiredWorkTypes[workType]}（已停用类型，保留原样）</option>
            ) : null}
            {workTypes.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        {article ? <p className="nw-field-note">更改作品语言会写入该语言版本，已有版本可能被覆盖；发布状态和删除作用于所有版本。</p> : null}
        <label className="nw-field-wide">摘要
          <textarea value={summary} onChange={(event) => { latest.current.summary = event.target.value; setSummary(event.target.value); }} maxLength={2000} placeholder="留空则由系统摘取正文开头自动生成" />
        </label>
      </div>
      <PromptDialog
        open={askKind !== null}
        title={askKind === "link" ? "插入链接" : "插入图片"}
        description={askKind === "link"
          ? "可以填写完整的 https:// 地址，或站内以 / 开头的绝对路径。"
          : "替代文本会被屏幕阅读器读出，也是图片无法显示时唯一能看到的内容。"}
        fields={askKind === "link" ? LINK_FIELDS : IMAGE_FIELDS}
        submitLabel={askKind === "link" ? "插入" : "上传并插入"}
        onCancel={() => settleAsk(null)}
        onSubmit={(values) => settleAsk(values)}
      />
      <p className="nw-lexical-empty-note">支持段落、二至四级标题、引用、列表、文本格式、链接、代码块及经服务端安全处理的图片。每张图片都会被重编码为 WebP；图片上传需配置 S3 兼容存储。</p>
      {error ? <p className="nw-auth-error" role="alert">{error}{signInHelp ? <> <Link href="/sign-in?next=%2Fwrite" target="_blank" rel="noopener noreferrer">登录原账户</Link></> : null}</p> : null}
      {status ? <p className="nw-auth-status" role="status">{status}{confirmedReplay ? <> <Link href="/write" target="_blank" rel="noopener noreferrer">在新标签页核对服务器版本</Link></> : null}</p> : null}
      {hasPending && !busy ? (
        <div className="nw-authoring-recovery">
          <p>这次请求和当前编辑只暂存在此页面。确认前请勿刷新或离开；确认原请求不会覆盖当前编辑。 <Link href="/write" target="_blank" rel="noopener noreferrer">在新标签页核对作品列表</Link></p>
          <div className="nw-authoring-actions">
            <button className="nw-btn" type="button" onClick={retryPending}>确认上次保存</button>
            <button className="nw-btn" type="button" onClick={() => void discardPending()}>放弃上次未确认的请求</button>
          </div>
        </div>
      ) : null}
      <div className="nw-authoring-actions">
        {article ? <button className="nw-btn" type="button" disabled={busy} onClick={() => void destroy()}>删除作品</button> : null}
        <button className="nw-btn" type="button" disabled={busy} onClick={() => void save(article?.status === "published" ? "publish" : "draft")}>{busy ? "保存中…" : article?.status === "published" ? "保存更新" : "保存草稿"}</button>
        <button className="nw-btn nw-pri" type="button" disabled={busy} onClick={() => void save("publish")}>{busy ? "正在保存…" : article?.status === "published" ? "保存并发布" : "发布作品"}</button>
        {article && article.status === "published" ? (
          <>
            {/* Withdrawing a public page is one click and it takes the address
                away from anyone who was reading it, so the desk asks first. */}
            <button className="nw-btn" type="button" disabled={busy} onClick={() => void withdraw()}>转为草稿</button>
            {articlePublicPath ? <a className="nw-btn" href={articlePublicPath} target="_blank" rel="noreferrer">查看已发布作品 ↗</a> : <span className="nw-m">该语言暂无公开网页地址。</span>}
          </>
        ) : null}
        {/* The other direction of the Notion exchange (ADR 0036): the work so far,
            as a bundle the author can push into their own database with their own
            token. A plain download, because the proxy answers with the file — and
            it is offered for drafts too, since an export writes nothing. */}
        {article ? (
          <a className="nw-btn" href={`/api/authoring/notion-export?slugs=${encodeURIComponent(article.slug)}`}>
            导出到 Notion ↓
          </a>
        ) : null}
      </div>
      {confirmDialog}
    </section>
  );
}
