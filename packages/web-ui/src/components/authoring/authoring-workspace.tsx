import { useEffect, useRef, useState } from "react";
import { Link } from "@/lib/framework/link.tsx";
import { useNavigationBlocker } from "@/lib/framework/navigation.ts";
import { ConfirmDialog } from "@/components/ui/confirm-dialog.tsx";
import { ArticleEditor, type AuthoringArticle } from "./article-editor.tsx";
import { AuthorProfilePanel } from "./author-profile-panel.tsx";
import { normalizeDisplayName, parseAuthorProfile, type AuthorProfile } from "@/lib/author-profile.ts";
import { NotificationInbox } from "./notification-inbox.tsx";
import { AUTHORING_LOCALES, isAuthoringLocale } from "@bot-thk/web-http";

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
    typeof item.slug === "string" && typeof item.locale === "string" && isAuthoringLocale(item.locale) &&
    Array.isArray(item.contentBlocks) && (item.status === "draft" || item.status === "published");
}

function localeLabel(locale: string): string {
  return locale === "zh-CN" ? "简体中文" : locale === "zh-TW" ? "繁體中文" : "English";
}

/** Different language editions can share an article id. */
function editionKey(article: AuthoringArticle): string {
  return `${article.id}:${article.locale}`;
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

/** Older API releases silently ignored allLocales and returned zh-CN only. */
function confirmsAllLocales(payload: unknown): boolean {
  const meta = typeof payload === "object" && payload !== null && "meta" in payload
    ? (payload as { meta?: unknown }).meta : null;
  const locales = typeof meta === "object" && meta !== null && "locales" in meta
    ? (meta as { locales?: unknown }).locales : null;
  return Array.isArray(locales) && locales.length === AUTHORING_LOCALES.length &&
    AUTHORING_LOCALES.every((locale) => locales.includes(locale));
}

function messageOf(payload: unknown): string {
  if (typeof payload === "object" && payload !== null && "error" in payload) {
    const error = (payload as { error?: { message?: unknown } }).error;
    if (error && typeof error.message === "string") return error.message;
  }
  return "暂时无法载入写作台，请稍后重试。";
}

export function AuthoringWorkspace({ mailEnabled }: { mailEnabled: boolean }) {
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
  const editorKeyRef = useRef("new-0");
  const editorRevision = useRef(0);
  const selectedRef = useRef<AuthoringArticle | null>(null);
  const [error, setError] = useState("");
  // A line about the desk as a whole rather than about the open document: the
  // message that follows a deletion outlives the editor, which is remounted.
  const [notice, setNotice] = useState("");
  // The recycle bin. A deleted work is recoverable only while the author can see
  // it, so the tombstones are part of the desk rather than a separate screen.
  const [deleted, setDeleted] = useState<DeletedArticle[]>([]);
  const [trashError, setTrashError] = useState("");
  // Who is signed in, read from the session call the desk already makes: the
  // response used to be discarded. The account page now shows the same thing
  // in full — this line stays because the desk is where the author works, and
  // asking them to open another page to be told their address is unverified
  // would be a detour, not a feature.
  const [account, setAccount] = useState<Account | null>(null);
  const [verificationBusy, setVerificationBusy] = useState(false);
  const [verificationStatus, setVerificationStatus] = useState("");
  const [profile, setProfile] = useState<AuthorProfile | null>(null);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [pendingCreate, setPendingCreate] = useState(false);
  const pendingCreateRef = useRef(false);
  const blocker = useNavigationBlocker(pendingCreate);

  function changePendingCreate(value: boolean) {
    pendingCreateRef.current = value;
    setPendingCreate(value);
  }

  function selectArticle(article: AuthoringArticle | null) {
    selectedRef.current = article;
    setSelected(article);
  }

  function switchEditor(prefix: string) {
    const key = `${prefix}-${++editorRevision.current}`;
    // Update synchronously: an older request can finish before React renders.
    editorKeyRef.current = key;
    setEditorKey(key);
  }

  // Unrelated account/profile requests can also expire while a create is in
  // flight. Do not unmount the editor and lose its pending key in that case.
  function showSignIn() {
    if (pendingCreateRef.current) {
      setError("登录状态已失效；请在新标签页登录原账户，再返回确认上次保存。");
    } else {
      setState("unauthenticated");
    }
  }

  useEffect(() => {
    if (!pendingCreate) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pendingCreate]);

  useEffect(() => {
    // The save may finish while a client-side navigation dialog is open.
    if (!pendingCreate && blocker.state === "blocked") blocker.reset();
  }, [pendingCreate, blocker]);

  async function reloadArticles() {
    const response = await fetch("/api/authoring/articles?allLocales=true", { credentials: "same-origin", cache: "no-store" });
    const payload: unknown = await response.json().catch(() => null);
    if (response.status === 401) { showSignIn(); return; }
    if (!response.ok) throw new Error(messageOf(payload));
    if (!confirmsAllLocales(payload)) throw new Error("无法确认所有语言版本，请检查 API 版本后重试。");
    const data = typeof payload === "object" && payload !== null && "data" in payload ? (payload as { data?: unknown }).data : null;
    if (!Array.isArray(data) || !data.every(isArticle)) throw new Error("作品列表响应格式不正确，无法安全显示所有语言版本。");
    setArticles(data);
    setState("ready");
  }

  /**
   * The recycle bin is loaded separately and never blocks the desk: a failing
   * list of deleted works must not stop the author from writing, so its error is
   * reported inside the section it belongs to.
   */
  async function reloadDeletedArticles() {
    const response = await fetch("/api/authoring/deleted-articles?allLocales=true", { credentials: "same-origin", cache: "no-store" });
    const payload: unknown = await response.json().catch(() => null);
    if (response.status === 401) { showSignIn(); return; }
    if (!response.ok) throw new Error(messageOf(payload));
    if (!confirmsAllLocales(payload)) throw new Error("无法确认回收站的所有语言版本。");
    const data = typeof payload === "object" && payload !== null && "data" in payload ? (payload as { data?: unknown }).data : null;
    if (!Array.isArray(data) || !data.every(isDeletedArticle)) throw new Error("回收站响应格式不正确，无法安全显示所有语言版本。");
    setDeleted(data);
    setTrashError("");
  }

  /**
   * The byline is a public fact, so the desk reads it from its own API proxy.
   * A 404 is not an outage: it is the legacy "account without a profile" case,
   * which the panel lets the author repair by saving a pen name.
   */
  async function reloadProfile() {
    const response = await fetch("/api/authoring/profile", { credentials: "same-origin", cache: "no-store" });
    const payload: unknown = await response.json().catch(() => null);
    if (response.status === 401) { showSignIn(); return; }
    if (response.status === 404) { setProfile(null); return; }
    if (!response.ok) throw new Error(messageOf(payload));
    setProfile(parseAuthorProfile(payload));
  }

  async function saveProfile(displayName: string) {
    const name = normalizeDisplayName(displayName);
    if (!name) throw new Error("笔名不能为空，且不得超过 120 个字符。");
    const response = await fetch("/api/authoring/profile", {
      method: "PUT",
      headers: { "content-type": "application/json", accept: "application/json", origin: window.location.origin },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify({ displayName: name, locale: "zh-CN" }),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (response.status === 401) { showSignIn(); throw new Error("登录状态已失效，请重新登录。"); }
    if (!response.ok) throw new Error(messageOf(payload));
    const saved = parseAuthorProfile(payload);
    if (!saved) throw new Error("作者资料响应格式不正确。");
    setProfile(saved);
  }

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const response = await fetch("/api/authoring/session", { credentials: "same-origin", cache: "no-store" });
        if (!active) return;
        if (response.status === 401) { showSignIn(); return; }
        if (!response.ok) throw new Error("无法验证登录状态。");
        // Best effort in both directions: the desk works without the account
        // line, and an unreadable session body is not a reason to lose the desk.
        const session: unknown = await response.json().catch(() => null);
        if (active) {
          const data = dataOf(session);
          setAccount(isAccount(data) ? data : null);
          const id = typeof data === "object" && data !== null && "id" in data ? (data as { id?: unknown }).id : null;
          setViewerId(typeof id === "string" && id.length > 0 && id.length <= 300 && id.trim() === id ? id : null);
        }
        await reloadArticles();
        // Best effort: a missing profile is actionable, not a reason to lose the desk.
        await reloadProfile().catch(() => { if (active) setProfile(null); });
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
    if (pendingCreateRef.current) return;
    selectArticle(null);
    switchEditor("new");
    setNotice("");
  }

  function openDocument(article: AuthoringArticle) {
    if (pendingCreateRef.current) return;
    // Re-clicking the open edition must not discard unsaved edits. A different
    // edition of the same id must remount, even after the current save changed
    // its locale and left the old editor key in place.
    if (selectedRef.current && editionKey(selectedRef.current) === editionKey(article)) return;
    selectArticle(article);
    switchEditor(`work-${editionKey(article)}`);
    setNotice("");
  }

  /**
   * A deleted work is gone from the desk, so the editor is reset to a new
   * document: keeping it mounted would show a work the API no longer returns,
   * and the next save would try to update a tombstone.
   */
  async function afterDelete(article: AuthoringArticle, sourceKey: string) {
    // A delete affects every edition. Reset only if the deleting editor is
    // still open, or if another edition of that same work is now open.
    if (editorKeyRef.current === sourceKey || selectedRef.current?.id === article.id) {
      selectArticle(null);
      switchEditor("deleted");
    }
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
      const response = await fetch(`/api/authoring/articles/${encodeURIComponent(entry.id)}/restore?locale=${encodeURIComponent(entry.locale)}`, {
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

  async function afterSave(article: AuthoringArticle, sourceKey: string) {
    // A slow PUT can resolve after a different document has opened. Refresh
    // the list, but never replace the identity beneath that new editor.
    if (editorKeyRef.current === sourceKey) {
      selectArticle(article);
      setError("");
      setNotice("");
    }
    setArticles((current) => [article, ...current.filter((item) => editionKey(item) !== editionKey(article))]);
    try { await reloadArticles(); } catch (caught) {
      setError(caught instanceof Error ? caught.message : "作品已保存，但列表刷新失败。");
    }
  }

  async function signOut() {
    if (pendingCreateRef.current) return;
    try {
      await fetch("/api/auth/logout", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", cache: "no-store", body: "{}" });
    } finally {
      if (pendingCreateRef.current) {
        showSignIn();
      } else {
        selectArticle(null);
        switchEditor("signed-out");
        setState("unauthenticated");
      }
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
      if (response.status === 401) { showSignIn(); return; }
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
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
          {/* The images an author has uploaded, and which of them nothing uses. */}
          <Link className="nw-btn" href="/write/media">媒体库</Link>
          {/* Notion as an interchange format (ADR 0036): bring a bundle in. */}
          <Link className="nw-btn" href="/write/notion">从 Notion 导入</Link>
          <button className="nw-btn" type="button" disabled={pendingCreate} onClick={() => void signOut()}>退出登录</button>
        </div>
      </div>
      <p className="nw-ep" style={{ marginTop: 18 }}>草稿与发布状态由 API 持久化；关闭页面后，可从作品列表继续编辑。</p>
      {account ? (
        <p className="nw-auth-status" role="status">
          已登录：{account.email} · 邮箱{account.emailVerifiedAt ? "已验证" : "未验证"}
          {/* Verification gates nothing, so the button is an offer, not a
              blocked state: an unverified author can still write and publish. */}
          {account.emailVerifiedAt || !mailEnabled ? null : (
            <>{" "}<button className="nw-btn" type="button" disabled={verificationBusy} onClick={() => void requestVerification()}>
              {verificationBusy ? "发送中…" : "发送验证邮件"}
            </button></>
          )}
          {verificationStatus ? <span> {verificationStatus}</span> : null}
        </p>
      ) : null}
      {error ? <p className="nw-auth-error" role="alert">{error}</p> : null}
      {notice ? <p className="nw-auth-status" role="status">{notice}</p> : null}
      <div className="nw-authoring-grid">
        <aside className="nw-authoring-sidebar" aria-label="我的作品">
          <h2>我的作品（{articles.length}）</h2>
          <button className="nw-btn nw-pri" type="button" disabled={pendingCreate} onClick={openNewDocument}>新建作品 +</button>
          <p className="nw-m">显示各语言最近 100 个版本；同一作品的不同语言分别列出。</p>
          {articles.length === 0 ? <p className="nw-m">还没有草稿或已发布作品。</p> : articles.map((article) => (
            <button className="nw-authoring-article" key={editionKey(article)} type="button" disabled={pendingCreate} aria-current={selected && editionKey(selected) === editionKey(article) ? "true" : undefined} onClick={() => openDocument(article)}>
              <span>{article.title}</span>
              <small>{article.status === "published" ? "已发布" : "草稿"} · {localeLabel(article.locale)} · {article.updatedAt ? new Date(article.updatedAt).toLocaleDateString("zh-CN") : article.slug}</small>
            </button>
          ))}
        </aside>
        <div>
          <ArticleEditor
            key={editorKey}
            article={selected}
            viewerId={viewerId}
            onSaved={(article) => void afterSave(article, editorKey)}
            onDeleted={(article) => void afterDelete(article, editorKey)}
            onPendingChange={changePendingCreate}
          />
        </div>
      </div>
      {/* Keep supporting tools mounted and reachable, without displacing the editor. */}
      <AuthorProfilePanel profile={profile} onSave={saveProfile} />
      <NotificationInbox />
      {/* Leaving with an unconfirmed request is a question, not a form: the
          answer is a route decision (`blocker.proceed()`), so it belongs in the
          confirmation dialog rather than in an empty prompt form. */}
      <ConfirmDialog
        open={blocker.state === "blocked"}
        title="上次保存尚未确认"
        description="作品可能已经创建。离开后本页的重试标识和未保存的编辑会丢失，再次保存可能产生重复作品。"
        confirmLabel="仍要离开"
        tone="danger"
        onCancel={() => { if (blocker.state === "blocked") blocker.reset(); }}
        onConfirm={() => { if (blocker.state === "blocked") blocker.proceed(); }}
      />
      <section className="nw-authoring-trash" aria-label="回收站">
        <h2>回收站（{deleted.length}）</h2>
        {trashError ? <p className="nw-auth-error" role="alert">{trashError}</p> : null}
        {deleted.length === 0 && !trashError
          ? <p className="nw-m">没有已删除的作品。</p>
          : deleted.map((entry) => {
            const days = daysUntilPurge(entry);
            return (
              <div className="nw-authoring-trash-row" key={editionKey(entry)}>
                <span>{entry.title}</span>
                <small>
                  {localeLabel(entry.locale)} · {entry.deletedAt ? `删除于 ${new Date(entry.deletedAt).toLocaleDateString("zh-CN")}` : "已删除"}
                  {days === null ? null : days === 0 ? " · 即将自动清除" : ` · 将在 ${days} 天后自动清除`}
                  {/* The one thing a restore cannot give back to a third party:
                      the sweep takes the comments with it, so the row says how
                      many rather than leaving the author to imagine it. */}
                  {entry.commentCount ? ` · 连同 ${entry.commentCount} 条评论` : null}
                </small>
                <button className="nw-btn" type="button" aria-label={`还原《${entry.title}》（${localeLabel(entry.locale)}）`} onClick={() => void restoreDeleted(entry)}>
                  还原《{entry.title}》
                </button>
              </div>
            );
          })}
      </section>
    </section>
  );
}
