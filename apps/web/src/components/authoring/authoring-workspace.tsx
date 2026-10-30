"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArticleEditor, type AuthoringArticle } from "./article-editor.tsx";
import { NotificationInbox } from "./notification-inbox.tsx";

type WorkspaceState = "loading" | "unauthenticated" | "ready" | "error";

/**
 * A tombstone, as the desk sees it: the work the author deleted, when it was
 * deleted, and when the sweep will make that permanent. The two timestamps come
 * from the API, so the window shown here is always the window the API is using —
 * the desk never carries its own copy of the retention policy.
 */
type DeletedArticle = AuthoringArticle & { deletedAt?: string; purgesAt?: string; commentCount?: number };

function isDeletedArticle(value: unknown): value is DeletedArticle {
  return isArticle(value) && typeof (value as DeletedArticle).deletedAt === "string";
}

/** Whole days until the sweep removes a tombstone, floored at zero. */
function daysUntilPurge(entry: DeletedArticle): number | null {
  const target = entry.purgesAt ?? entry.deletedAt;
  if (!target) return null;
  const remaining = new Date(target).getTime() - Date.now();
  if (!Number.isFinite(remaining)) return null;
  return Math.max(0, Math.ceil(remaining / 86_400_000));
}

function isArticle(value: unknown): value is AuthoringArticle {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<AuthoringArticle>;
  return typeof item.id === "string" && typeof item.title === "string" &&
    typeof item.slug === "string" && Array.isArray(item.contentBlocks) &&
    (item.status === "draft" || item.status === "published");
}

/**
 * The account line the desk can show: who is signed in, and whether the address
 * on the account has ever been proven reachable.
 *
 * `GET /api/v1/me` grew these two fields additively (ADR 0014), so an older API
 * simply yields `null` here and the strip stays hidden rather than guessing.
 */
type Account = { email: string; emailVerifiedAt: string | null };

function isAccount(value: unknown): value is Account {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<Account>;
  return typeof item.email === "string" &&
    (item.emailVerifiedAt === null || typeof item.emailVerifiedAt === "string");
}

function dataOf(payload: unknown): unknown {
  return typeof payload === "object" && payload !== null && "data" in payload
    ? (payload as { data?: unknown }).data
    : null;
}

function messageOf(payload: unknown): string {
  if (typeof payload === "object" && payload !== null && "error" in payload) {
    const error = (payload as { error?: { message?: unknown } }).error;
    if (error && typeof error.message === "string") return error.message;
  }
  return "暂时无法载入写作台，请稍后重试。";
}

export function AuthoringWorkspace() {
  const [state, setState] = useState<WorkspaceState>("loading");
  const [articles, setArticles] = useState<AuthoringArticle[]>([]);
  const [selected, setSelected] = useState<AuthoringArticle | null>(null);
  // The editor is keyed by its own state rather than by `selected`. Keying by
  // the selected article re-mounted the editor the moment a save selected the
  // saved article, which discarded the very status line the save had rendered
  // ("草稿已保存。作品地址：…") together with everything the author had typed.
  // The key now changes only when the author actually changes document: opening
  // a different work must reload it, saving the current one must not.
  const [editorKey, setEditorKey] = useState("new-0");
  const [newCounter, setNewCounter] = useState(0);
  const [error, setError] = useState("");
  // A line about the desk as a whole rather than about the open document: the
  // message that follows a deletion outlives the editor, which is remounted.
  const [notice, setNotice] = useState("");
  // The recycle bin. A deleted work is recoverable only while the author can see
  // it, so the tombstones are part of the desk rather than a separate screen.
  const [deleted, setDeleted] = useState<DeletedArticle[]>([]);
  const [trashError, setTrashError] = useState("");
  // Who is signed in, read from the session call the desk already makes: the
  // response used to be discarded, and the writing desk is the only signed-in
  // surface this app has — the `/account` page is still a deliberate redirect.
  const [account, setAccount] = useState<Account | null>(null);
  const [verificationBusy, setVerificationBusy] = useState(false);
  const [verificationStatus, setVerificationStatus] = useState("");

  async function reloadArticles() {
    const response = await fetch("/api/authoring/articles", { credentials: "same-origin", cache: "no-store" });
    const payload: unknown = await response.json().catch(() => null);
    if (response.status === 401) { setState("unauthenticated"); return; }
    if (!response.ok) throw new Error(messageOf(payload));
    const data = typeof payload === "object" && payload !== null && "data" in payload ? (payload as { data?: unknown }).data : null;
    if (!Array.isArray(data)) throw new Error("作品列表响应格式不正确。");
    setArticles(data.filter(isArticle));
    setState("ready");
  }

  /**
   * The recycle bin is loaded separately and never blocks the desk: a failing
   * list of deleted works must not stop the author from writing, so its error is
   * reported inside the section it belongs to.
   */
  async function reloadDeletedArticles() {
    const response = await fetch("/api/authoring/deleted-articles", { credentials: "same-origin", cache: "no-store" });
    const payload: unknown = await response.json().catch(() => null);
    if (response.status === 401) { setState("unauthenticated"); return; }
    if (!response.ok) throw new Error(messageOf(payload));
    const data = typeof payload === "object" && payload !== null && "data" in payload ? (payload as { data?: unknown }).data : null;
    if (!Array.isArray(data)) throw new Error("回收站响应格式不正确。");
    setDeleted(data.filter(isDeletedArticle));
    setTrashError("");
  }

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const response = await fetch("/api/authoring/session", { credentials: "same-origin", cache: "no-store" });
        if (!active) return;
        if (response.status === 401) { setState("unauthenticated"); return; }
        if (!response.ok) throw new Error("无法验证登录状态。");
        // Best effort in both directions: the desk works without the account
        // line, and an unreadable session body is not a reason to lose the desk.
        const session: unknown = await response.json().catch(() => null);
        if (active) setAccount(isAccount(dataOf(session)) ? (dataOf(session) as Account) : null);
        await reloadArticles();
        // Best effort: the desk is usable without the recycle bin.
        await reloadDeletedArticles().catch(() => { if (active) setTrashError("回收站暂时无法载入。"); });
      } catch (caught) {
        if (active) { setError(caught instanceof Error ? caught.message : "暂时无法载入写作台。"); setState("error"); }
      }
    }
    void load();
    return () => { active = false; };
  }, []);

  function openNewDocument() {
    const next = newCounter + 1;
    setNewCounter(next);
    setSelected(null);
    setEditorKey(`new-${next}`);
    setNotice("");
  }

  function openDocument(article: AuthoringArticle) {
    setSelected(article);
    setEditorKey(article.id);
    setNotice("");
  }

  /**
   * A deleted work is gone from the desk, so the editor is reset to a new
   * document: keeping it mounted would show a work the API no longer returns,
   * and the next save would try to update a tombstone.
   */
  async function afterDelete(article: AuthoringArticle) {
    const next = newCounter + 1;
    setNewCounter(next);
    setSelected(null);
    setEditorKey(`deleted-${next}`);
    setError("");
    // The notice names the recycle bin because that is where the work now is:
    // "deleted" has to read as "moved", not as "gone".
    setNotice(`《${article.title}》已删除，可在回收站还原。`);
    setArticles((current) => current.filter((item) => item.id !== article.id));
    try { await reloadArticles(); } catch { /* the list is already correct locally */ }
    try { await reloadDeletedArticles(); } catch { setTrashError("回收站暂时无法载入。"); }
  }

  /**
   * Restore a tombstone without touching the open editor: the author may be
   * mid-sentence in another document, and a restore is not a request to switch
   * documents. The work comes back as a draft, which is what the API returns.
   */
  async function restoreDeleted(entry: DeletedArticle) {
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/authoring/articles/${entry.id}/restore`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(messageOf(payload));
      setNotice(`《${entry.title}》已还原为草稿。`);
      setDeleted((current) => current.filter((item) => item.id !== entry.id));
      try { await reloadArticles(); } catch (caught) {
        setError(caught instanceof Error ? caught.message : "作品已还原，但列表刷新失败。");
      }
      try { await reloadDeletedArticles(); } catch { setTrashError("回收站暂时无法载入。"); }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "暂时无法还原这个作品。");
    }
  }

  async function afterSave(article: AuthoringArticle) {
    // Selecting the saved article keeps the editor mounted: it is the same
    // document the author is looking at, and it now knows its own id, so the
    // next save updates it instead of creating a second one.
    setSelected(article);
    setError("");
    setNotice("");
    setArticles((current) => [article, ...current.filter((item) => item.id !== article.id)].slice(0, 100));
    try { await reloadArticles(); } catch (caught) {
      setError(caught instanceof Error ? caught.message : "作品已保存，但列表刷新失败。");
    }
  }

  async function signOut() {
    try {
      await fetch("/api/auth/logout", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", cache: "no-store", body: "{}" });
    } finally {
      setSelected(null);
      setEditorKey("signed-out");
      setState("unauthenticated");
    }
  }

  /**
   * Ask for a verification link for the signed-in account's own address.
   *
   * No address is sent: the API mails whatever address the session belongs to,
   * so this can never be aimed at somebody else's mailbox.
   */
  async function requestVerification() {
    if (verificationBusy) return;
    setVerificationBusy(true);
    setVerificationStatus("");
    try {
      const response = await fetch("/api/authoring/email-verification", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: "{}",
      });
      const payload: unknown = await response.json().catch(() => null);
      if (response.status === 401) { setState("unauthenticated"); return; }
      if (!response.ok) throw new Error(messageOf(payload));
      const data = dataOf(payload);
      const already = typeof data === "object" && data !== null &&
        (data as { alreadyVerified?: unknown }).alreadyVerified === true;
      setVerificationStatus(already ? "这个邮箱已经验证过了。" : "验证邮件已发送，请查收（链接 24 小时内有效）。");
    } catch (caught) {
      setVerificationStatus(caught instanceof Error ? caught.message : "暂时无法发送验证邮件，请稍后重试。");
    } finally {
      setVerificationBusy(false);
    }
  }

  if (state === "loading") return <p role="status">正在验证登录状态并载入草稿……</p>;
  if (state === "unauthenticated") {
    return <section className="nw-auth-panel"><h1><span className="nw-zh">先登录</span> <i>Sign in</i></h1><p>写作、保存草稿与发布功能需要有效的登录会话。</p><Link className="nw-btn nw-pri" href="/sign-in?next=%2Fwrite">登录或创建账户</Link></section>;
  }
  if (state === "error") return <section><p className="nw-auth-error" role="alert">{error}</p><button className="nw-btn" type="button" onClick={() => { setError(""); setState("loading"); window.location.reload(); }}>重新载入</button></section>;

  return (
    <section className="nw-authoring">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <h1><span className="nw-zh">写作台</span> <i>Authoring</i></h1>
        <button className="nw-btn" type="button" onClick={() => void signOut()}>退出登录</button>
      </div>
      <p className="nw-ep" style={{ marginTop: 18 }}>草稿与发布状态由 API 持久化；关闭页面后，可从作品列表继续编辑。</p>
      {account ? (
        <p className="nw-auth-status" role="status">
          已登录：{account.email} · 邮箱{account.emailVerifiedAt ? "已验证" : "未验证"}
          {/* Verification gates nothing, so the button is an offer, not a
              blocked state: an unverified author can still write and publish. */}
          {account.emailVerifiedAt ? null : (
            <>{" "}<button className="nw-btn" type="button" disabled={verificationBusy} onClick={() => void requestVerification()}>
              {verificationBusy ? "发送中…" : "发送验证邮件"}
            </button></>
          )}
          {verificationStatus ? <span> {verificationStatus}</span> : null}
        </p>
      ) : null}
      {error ? <p className="nw-auth-error" role="alert">{error}</p> : null}
      {notice ? <p className="nw-auth-status" role="status">{notice}</p> : null}
      {/* The inbox sits above the editor because what it says is about someone
          else's work: the notice a commenter gets when a work they commented on
          is deleted is the only way they hear about it at all. */}
      <NotificationInbox />
      <div className="nw-authoring-grid">
        <aside className="nw-authoring-sidebar" aria-label="我的作品">
          <h2>我的作品（{articles.length}）</h2>
          <button className="nw-btn nw-pri" type="button" onClick={openNewDocument}>新建作品 +</button>
          {articles.length === 0 ? <p className="nw-m">还没有草稿或已发布作品。</p> : articles.map((article) => (
            <button className="nw-authoring-article" key={article.id} type="button" aria-current={selected?.id === article.id ? "true" : undefined} onClick={() => openDocument(article)}>
              <span>{article.title}</span>
              <small>{article.status === "published" ? "已发布" : "草稿"} · {article.updatedAt ? new Date(article.updatedAt).toLocaleDateString("zh-CN") : article.slug}</small>
            </button>
          ))}
        </aside>
        <div>
          <ArticleEditor
            key={editorKey}
            article={selected}
            onSaved={(article) => void afterSave(article)}
            onDeleted={(article) => void afterDelete(article)}
          />
        </div>
      </div>
      <section className="nw-authoring-trash" aria-label="回收站">
        <h2>回收站（{deleted.length}）</h2>
        {trashError ? <p className="nw-auth-error" role="alert">{trashError}</p> : null}
        {deleted.length === 0 && !trashError
          ? <p className="nw-m">没有已删除的作品。</p>
          : deleted.map((entry) => {
            const days = daysUntilPurge(entry);
            return (
              <div className="nw-authoring-trash-row" key={entry.id}>
                <span>{entry.title}</span>
                <small>
                  {entry.deletedAt ? `删除于 ${new Date(entry.deletedAt).toLocaleDateString("zh-CN")}` : "已删除"}
                  {days === null ? null : days === 0 ? " · 即将自动清除" : ` · 将在 ${days} 天后自动清除`}
                  {/* The one thing a restore cannot give back to a third party:
                      the sweep takes the comments with it, so the row says how
                      many rather than leaving the author to imagine it. */}
                  {entry.commentCount ? ` · 连同 ${entry.commentCount} 条评论` : null}
                </small>
                <button className="nw-btn" type="button" onClick={() => void restoreDeleted(entry)}>
                  还原《{entry.title}》
                </button>
              </div>
            );
          })}
      </section>
    </section>
  );
}
