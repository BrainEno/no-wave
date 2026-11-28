import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@/lib/framework/link.tsx";
import { hasUsableSession, isRecord, SESSION_MARKER_COOKIE } from "@no-wave/web-http";
import { sessionMarkerFromCookie } from "@/lib/chrome.ts";
import type { ReactNode } from "react";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalExtensionComposer } from "@lexical/react/LexicalExtensionComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ClipboardDOMImportExtension } from "@lexical/clipboard";
import { HistoryExtension } from "@lexical/history";
import { LinkExtension, TOGGLE_LINK_COMMAND } from "@lexical/link";
import { PlainTextExtension } from "@lexical/plain-text";
import { defineExtension, FORMAT_TEXT_COMMAND, REDO_COMMAND, UNDO_COMMAND } from "lexical";
import type { LexicalEditor } from "lexical";
import type { Locale } from "@/lib/content.ts";
import { sanitizeEditorHref } from "@/lib/editor-href.ts";
import { InlineRuns } from "@/components/ui/inline-runs.tsx";
import { PromptDialog, type PromptDialogField } from "@/components/ui/prompt-dialog.tsx";
import { articleBlocksToLexicalEditorState, type LexicalEditorStateJson } from "@/lib/lexical-article-state.ts";
import { canEditComment, commentCopy, commentCreatePath, commentDocumentToSubmit, commentEditBody, commentEditPath, editedMarker } from "@/lib/comment-edit.ts";

const COMMENT_LINK_FIELDS: readonly PromptDialogField[] = [
  {
    name: "url",
    label: "链接地址",
    maxLength: 2048,
    required: true,
    requiredMessage: "请填写链接地址。",
    placeholder: "https://…",
  },
];

type CommentRun = { text: string; marks?: string[]; href?: string };
type CommentBlock = { id: string; type: "paragraph"; text: string; inlines?: CommentRun[] };
type CommentView = {
  id: string;
  authorId?: string;
  content: string;
  contentBlocks?: CommentBlock[] | null;
  contentBlocksVersion?: 0 | 1;
  createdAt: string;
  /** Set by the API once the author has corrected the text (ADR 0031). */
  editedAt?: string | null;
  author?: { displayName?: string; username?: string } | null;
  replies?: CommentView[];
};

function readError(value: unknown): string {
  if (isRecord(value) && isRecord(value.error) && typeof value.error.message === "string") return value.error.message;
  return "评论暂时无法提交，请稍后重试。";
}

function isComment(value: unknown): value is CommentView {
  return isRecord(value) && typeof value.id === "string" && typeof value.content === "string" &&
    typeof value.createdAt === "string";
}

function renderCommentBlocks(comment: CommentView): ReactNode {
  const blocks = comment.contentBlocks;
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return comment.content.split("\n").map((paragraph, index) => <p key={index}>{paragraph}</p>);
  }
  return blocks.filter((block) => block && block.type === "paragraph" && typeof block.text === "string")
    .map((block, index) => (
      <p key={block.id || index}>
        {Array.isArray(block.inlines) && block.inlines.length
          ? <InlineRuns runs={block.inlines} idPrefix={`${block.id || index}`} />
          : block.text}
      </p>
    ));
}

/** The blocks an edit starts from: the stored ones, or the plain text as paragraphs. */
function blocksForEdit(comment: CommentView): CommentBlock[] {
  if (Array.isArray(comment.contentBlocks) && comment.contentBlocks.length > 0) return comment.contentBlocks;
  return comment.content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(0, 20)
    .map((line, index) => ({ id: "comment-" + comment.id + "-" + index, type: "paragraph" as const, text: line }));
}

type EditHandler = (comment: CommentView, editorState: LexicalEditorStateJson) => Promise<boolean>;

function CommentItem({ comment, locale, viewerId, onEdit }: {
  comment: CommentView;
  locale: Locale;
  viewerId: string | null;
  onEdit: EditHandler;
}) {
  const copy = commentCopy(locale);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const timestamp = Date.parse(comment.createdAt);
  const date = Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString(locale === "en" ? "en-US" : "zh-CN") : "";
  const marker = editedMarker(locale, comment);
  const editable = canEditComment(viewerId, comment);

  async function save(state: LexicalEditorStateJson): Promise<boolean> {
    setBusy(true);
    try {
      const saved = await onEdit(comment, state);
      if (saved) setEditing(false);
      return saved;
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="nw-comment-item">
      <header>
        <strong>{comment.author?.displayName || comment.author?.username || "读者"}</strong>
        <time dateTime={comment.createdAt}>{date}</time>
        {marker ? <span className="nw-comment-edited" title={locale === "en" ? "Changed after it was posted" : "发表后修改过"}>· {marker}</span> : null}
        {editable && !editing ? (
          <button className="nw-btn nw-comment-edit" type="button" onClick={() => setEditing(true)}>{copy.edit}</button>
        ) : null}
      </header>
      {editing ? (
        <CommentComposer
          resetKey={0}
          formatNames={copy.format}
          initialBlocks={blocksForEdit(comment)}
          submitLabel={copy.save}
          busyLabel={copy.saving}
          onCancel={() => setEditing(false)}
          cancelLabel={copy.cancel}
          onSubmit={save}
          busy={busy}
        />
      ) : (
        <div className="nw-comment-body">{renderCommentBlocks(comment)}</div>
      )}
      {comment.replies?.length ? (
        <div className="nw-comment-replies">
          {comment.replies.map((reply) => (
            <CommentItem key={reply.id} comment={reply} locale={locale} viewerId={viewerId} onEdit={onEdit} />
          ))}
        </div>
      ) : null}
    </article>
  );
}

function textFromEditorState(state: LexicalEditorStateJson): string {
  let text = "";
  function visit(node: unknown) {
    if (!isRecord(node)) return;
    if (node.type === "text" && typeof node.text === "string") text += node.text;
    if (Array.isArray(node.children)) node.children.forEach(visit);
  }
  visit(state.root);
  return text;
}

/**
 * Hands the composer the editor it draws, and keeps its mirror of the
 * document current.
 *
 * The committed state is published once when the composer subscribes, not only
 * on the updates that follow: an update that landed before this effect ran is
 * never reported by the listener, and the composer would keep the document it
 * started with — which is how a comment came to be refused for text the reader
 * could plainly see in the box.
 */
function CommentStatePlugin({ onEditor, onChange }: {
  /** The editor itself: the submit path reads the live document from it. */
  onEditor(editor: LexicalEditor | null): void;
  onChange(state: LexicalEditorStateJson): void;
}) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    onEditor(editor);
    onChange(editor.getEditorState().toJSON() as LexicalEditorStateJson);
    const unregister = editor.registerUpdateListener(({ editorState }) => onChange(editorState.toJSON() as LexicalEditorStateJson));
    return () => {
      unregister();
      onEditor(null);
    };
  }, [editor, onChange, onEditor]);
  return null;
}

function CommentToolbar({
  onLinkError,
  ask,
  names,
}: {
  onLinkError(message: string): void;
  /** Collects the URL in a dialog instead of `window.prompt` (#195). */
  ask(): Promise<Record<string, string> | null>;
  /** The accessible names of the formatting controls. */
  names: ReturnType<typeof commentCopy>["format"];
}) {
  const [editor] = useLexicalComposerContext();

  async function addLink() {
    const values = await ask();
    if (values === null) return;
    const href = sanitizeEditorHref(values.url ?? "");
    if (!href) {
      onLinkError("只允许 HTTP(S) 链接或站内绝对路径。");
      return;
    }
    onLinkError("");
    // `rel: null` on purpose: the article contract stores the address and the
    // marks, not the link's HTML attributes, and the reading page gives every
    // author link a `rel` of its own. Left to itself, Lexical stamps
    // `rel="noreferrer"` on the node — metadata the document cannot keep.
    editor.dispatchCommand(TOGGLE_LINK_COMMAND, { url: href, rel: null });
  }

  return (
    <div className="nw-comment-toolbar" role="toolbar" aria-label="评论格式">
      <button type="button" aria-label={names.bold} onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold")}><strong aria-hidden="true">B</strong></button>
      <button type="button" aria-label={names.italic} onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "italic")}><em aria-hidden="true">I</em></button>
      <button type="button" aria-label={names.underline} onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "underline")}><u aria-hidden="true">U</u></button>
      <button type="button" aria-label={names.strikethrough} onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "strikethrough")}><s aria-hidden="true">S</s></button>
      <button type="button" onClick={() => { void addLink(); }}>链接</button>
      <button type="button" onClick={() => editor.dispatchCommand(UNDO_COMMAND, undefined)} aria-label="撤销">撤销</button>
      <button type="button" onClick={() => editor.dispatchCommand(REDO_COMMAND, undefined)} aria-label="重做">重做</button>
    </div>
  );
}

const commentTheme = {
  paragraph: "nw-lexical-paragraph",
  text: { bold: "nw-lexical-bold", italic: "nw-lexical-italic", underline: "nw-lexical-underline", strikethrough: "nw-lexical-strikethrough", code: "nw-lexical-inline-code" },
};

function CommentComposer({ resetKey, onSubmit, busy, initialBlocks, submitLabel, busyLabel, cancelLabel, onCancel, formatNames }: {
  resetKey: number;
  onSubmit(state: LexicalEditorStateJson): Promise<boolean>;
  busy: boolean;
  /** The accessible names of the formatting controls, in the page's language. */
  formatNames: ReturnType<typeof commentCopy>["format"];
  /** Prefills the editor; used by an edit, absent for a new comment. */
  initialBlocks?: CommentBlock[] | null;
  submitLabel?: string;
  busyLabel?: string;
  cancelLabel?: string;
  onCancel?: () => void;
}) {
  const initialState = useMemo(
    () => articleBlocksToLexicalEditorState(
      initialBlocks && initialBlocks.length > 0 ? initialBlocks : [{ id: "comment-empty", type: "paragraph", text: "" }],
    ),
    [initialBlocks],
  );
  const [editorState, setEditorState] = useState<LexicalEditorStateJson>(initialState);
  // The editor the composer draws, so the submit path can read the document it
  // holds right now instead of the last one React heard about.
  const editorRef = useRef<LexicalEditor | null>(null);
  const extension = useMemo(() => defineExtension({
    name: "@no-wave/comment-composition",
    namespace: "no-wave-comment-" + resetKey,
    dependencies: [PlainTextExtension, HistoryExtension, ClipboardDOMImportExtension, LinkExtension],
    theme: commentTheme,
    $initialEditorState: JSON.stringify(initialState),
  }), [initialState, resetKey]);
  const onChange = useCallback((state: LexicalEditorStateJson) => setEditorState(state), []);
  const bindEditor = useCallback((editor: LexicalEditor | null) => { editorRef.current = editor; }, []);
  const [formError, setFormError] = useState("");
  const [askingLink, setAskingLink] = useState(false);
  const askResolver = useRef<((values: Record<string, string> | null) => void) | null>(null);
  const askForLink = useCallback(() => new Promise<Record<string, string> | null>((resolve) => {
    askResolver.current = resolve;
    setAskingLink(true);
  }), []);
  const settleLink = useCallback((values: Record<string, string> | null) => {
    const resolve = askResolver.current;
    askResolver.current = null;
    setAskingLink(false);
    resolve?.(values);
  }, []);

  return (
    <>
      <form className="nw-comment-form" onSubmit={(event) => {
        event.preventDefault();
        // The editor is the source of truth at this point: the document React
        // last heard about can lag behind the text in the box, and a comment
        // must not be refused for text the reader can see.
        const submitted = commentDocumentToSubmit(editorRef.current, editorState);
        const text = textFromEditorState(submitted).trim();
        if (!text) { setFormError("评论内容不能为空。"); return; }
        if (text.length > 5000) { setFormError("评论不能超过 5000 个字符。"); return; }
        if (submitted.root.children.length < 1 || submitted.root.children.length > 20) {
          setFormError("评论最多包含 20 个段落。");
          return;
        }
        setFormError("");
        void onSubmit(submitted);
      }}>
        <LexicalExtensionComposer extension={extension} contentEditable={null}>
          <CommentToolbar onLinkError={setFormError} ask={askForLink} names={formatNames} />
          <div className="nw-comment-shell">
            <ContentEditable className="nw-comment-editor" aria-label="评论内容" aria-placeholder="写下你的回应……" placeholder={<p className="nw-comment-placeholder">写下你的回应……</p>} />
          </div>
          <CommentStatePlugin onEditor={bindEditor} onChange={onChange} />
        </LexicalExtensionComposer>
        {formError ? <p className="nw-notice-error" role="alert">{formError}</p> : null}
        <div className="nw-authoring-actions">
          <button className="nw-btn nw-pri" type="submit" disabled={busy}>
            {busy ? (busyLabel ?? "正在提交……") : (submitLabel ?? "提交评论")}
          </button>
          {onCancel ? (
            <button className="nw-btn" type="button" onClick={onCancel} disabled={busy}>{cancelLabel ?? "取消"}</button>
          ) : null}
        </div>
      </form>
      <PromptDialog
        open={askingLink}
        title="插入链接"
        description="可以填写完整的 https:// 地址，或站内以 / 开头的绝对路径。"
        fields={COMMENT_LINK_FIELDS}
        submitLabel="插入"
        onCancel={() => settleLink(null)}
        onSubmit={(values) => settleLink(values)}
      />
    </>
  );
}

export function ArticleComments({ slug, locale }: { slug: string; locale: Locale }) {
  const copy = commentCopy(locale);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [comments, setComments] = useState<CommentView[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    const response = await fetch("/api/articles/" + encodeURIComponent(slug) + "/comments?locale=" + encodeURIComponent(locale), { cache: "no-store", credentials: "same-origin" });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(readError(payload));
    const data = isRecord(payload) && Array.isArray(payload.data) ? payload.data : null;
    if (!data) throw new Error("评论列表的响应格式不正确。");
    setComments(data.filter(isComment));
    setState("ready");
  }, [slug, locale]);

  /**
   * Who is reading, if anyone.
   *
   * Only used to decide whether to offer the edit button — the API is the thing
   * that decides whether an edit is allowed, and it answers 403 for somebody
   * else's comment. The session endpoint answers 401 for a visitor, which is a
   * fact about the page, not an error to report.
   */
  useEffect(() => {
    let active = true;
    // The marker only avoids a known-anonymous request. It never proves an
    // identity: the API must still verify a usable (or forged) marker.
    if (!hasUsableSession(sessionMarkerFromCookie(document.cookie, SESSION_MARKER_COOKIE))) {
      setViewerId(null);
      setSignedOut(true);
      return () => { active = false; };
    }
    setSignedOut(false);
    fetch("/api/authoring/session", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        if (active && response.status === 401) setSignedOut(true);
        return response.ok ? await response.json().catch(() => null) : null;
      })
      .then((payload: unknown) => {
        if (!active || !isRecord(payload) || !isRecord(payload.data)) return;
        const id = payload.data.id;
        if (typeof id === "string" && id.length > 0) setViewerId(id);
      })
      .catch(() => { /* an anonymous reader simply gets no edit buttons */ });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    reload().catch((caught: unknown) => {
      if (active) { setError(caught instanceof Error ? caught.message : "评论暂时无法载入。"); setState("error"); }
    });
    return () => { active = false; };
  }, [reload]);

  async function submit(editorState: LexicalEditorStateJson): Promise<boolean> {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      // The write goes to the authoring prefix: that is the only place the
      // access cookie is sent, and without it every submission took a 401 and a
      // token rotation before succeeding (#242).
      const response = await fetch(commentCreatePath(slug, locale), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ editorState, contentBlocksVersion: 1 }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (response.status === 401) {
        setError("请先登录后再发表评论。");
        return false;
      }
      if (!response.ok) throw new Error(readError(payload));
      setStatus("评论已发布。");
      setResetKey((value) => value + 1);
      try { await reload(); } catch {
        setStatus("评论已发布，但列表刷新失败，请稍后重新载入。");
      }
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "评论提交失败，请稍后重试。");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function edit(comment: CommentView, editorState: LexicalEditorStateJson): Promise<boolean> {
    setError("");
    setStatus("");
    try {
      const response = await fetch(commentEditPath(comment.id, locale), {
        method: "PATCH",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify(commentEditBody(editorState)),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (response.status === 401) {
        setError(copy.signInToEdit);
        return false;
      }
      if (!response.ok) throw new Error(readError(payload));
      setStatus(copy.updated);
      try { await reload(); } catch {
        setStatus(copy.staleList);
      }
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : copy.failed);
      return false;
    }
  }

  return (
    <section className="nw-comment-section" aria-labelledby="nw-comments-title">
      <h2 id="nw-comments-title">回应 / Comments</h2>
      {state === "loading" ? <p className="nw-m" role="status">正在载入评论……</p> : null}
      {state === "error" ? <p className="nw-notice-error" role="alert">{error}</p> : null}
      {state === "ready" && comments.length === 0 ? <p className="nw-m">还没有评论，欢迎留下第一条回应。</p> : null}
      {comments.length > 0 ? (
        <div className="nw-comment-list">
          {comments.map((comment) => (
            <CommentItem key={comment.id} comment={comment} locale={locale} viewerId={viewerId} onEdit={edit} />
          ))}
        </div>
      ) : null}
      <h3>写下你的回应</h3>
      {signedOut ? <p className="nw-m">请先登录后再发表评论。 <Link href={"/sign-in?next=" + encodeURIComponent("/articles/" + slug)}>前往登录</Link></p> : null}
      <CommentComposer key={resetKey} resetKey={resetKey} formatNames={copy.format} onSubmit={submit} busy={busy} />
      {status ? <p role="status" className="nw-notice-status">{status}</p> : null}
      {error && state !== "error" ? <p className="nw-notice-error" role="alert">{error} {error.includes("登录") ? <Link href={"/sign-in?next=" + encodeURIComponent("/articles/" + slug)}>前往登录</Link> : null}</p> : null}
    </section>
  );
}
