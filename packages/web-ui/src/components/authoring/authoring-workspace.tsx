import { useCallback, useEffect, useRef, useState } from "react";
import { writingRecoveryBoundary } from "@/lib/writing-recovery-boundary.ts";
import { Link } from "@/lib/framework/link.tsx";
import { useNavigationBlocker, usePageLocation } from "@/lib/framework/navigation.ts";
import { ConfirmDialog } from "@/components/ui/confirm-dialog.tsx";
import { bindWritingUnload, canLeaveWriting, type WritingGuard, type WritingLeaveToken } from "@/lib/writing-session.ts";
import { ArticleEditor, type AuthoringArticle } from "./article-editor.tsx";
import { AuthorProfilePanel } from "./author-profile-panel.tsx";
import { normalizeDisplayName, parseAuthorProfile, type AuthorProfile } from "@/lib/author-profile.ts";
import { NotificationInbox } from "./notification-inbox.tsx";
import { useNotificationActions } from "@/components/chrome/notification-provider.tsx";
import { CatalogueDocumentReader } from "@/lib/authoring-catalogue-open.ts";
import { parseCatalogueOpenIntent, type CatalogueOpenIntent } from "@/lib/authoring-catalogue.ts";
import { AUTHORING_LOCALES, isAuthoringLocale } from "@bot-thk/web-http";

type WorkspaceState = "loading" | "unauthenticated" | "ready" | "error";
type DocumentAction = { kind: "catalogue"; intent: CatalogueOpenIntent } | { kind: "new" } | { kind: "open"; article: AuthoringArticle } | { kind: "sign-out" };
type DocumentLeave = { token: WritingLeaveToken; action: DocumentAction };

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
  const notifications = useNotificationActions();
  const pageLocation = usePageLocation();
  const [catalogueReader] = useState(() => new CatalogueDocumentReader());
  const [catalogueLoading, setCatalogueLoading] = useState(false);
  const [catalogueIntent, setCatalogueIntent] = useState<CatalogueOpenIntent | null>(null);
  const catalogueRequest = useRef(0);
  const catalogueRouteApproval = useRef<(WritingLeaveToken & { search: string }) | null>(null);
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
  const [guard, setGuard] = useState<WritingGuard>({ dirty: false, revision: 0 });
  const guardRef = useRef(guard);
  const [leave, setLeave] = useState<DocumentLeave | null>(null);
  const routeLeave = useRef<(WritingLeaveToken & { pending: boolean }) | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [recoveryWarning, setRecoveryWarning] = useState<string | null>(null);
  const signingOutRef = useRef(false);
  const shouldBlock = useCallback(() => pendingCreateRef.current || guardRef.current.dirty, []);
  const blocker = useNavigationBlocker(shouldBlock);
  const guarded = pendingCreate || guard.dirty;

  function changeGuard(value: WritingGuard, sourceKey: string) {
    if (editorKeyRef.current !== sourceKey) return;
    guardRef.current = value;
    setGuard(value);
    if (!value.dirty) setLeave(null);
  }

  function leaveToken(): WritingLeaveToken {
    return { editorKey: editorKeyRef.current, revision: guardRef.current.revision };
  }

  function changePendingCreate(value: boolean) {
    pendingCreateRef.current = value;
    setPendingCreate(value);
  }

  const selectArticle = useCallback((article: AuthoringArticle | null) => {
    selectedRef.current = article;
    setSelected(article);
  }, []);

  const switchEditor = useCallback((prefix: string) => {
    catalogueRequest.current++;
    catalogueReader.cancel();
    setCatalogueLoading(false);
    const key = `${prefix}-${++editorRevision.current}`;
    // Update synchronously: an older request can finish before React renders.
    editorKeyRef.current = key;
    guardRef.current = { dirty: false, revision: 0 };
    setGuard(guardRef.current);
    setLeave(null);
    setEditorKey(key);
  }, [catalogueReader]);

  // Unrelated account/profile requests can also expire while a create is in
  // flight. Do not unmount the editor and lose its pending key in that case.
  const showSignIn = useCallback(() => {
    void notifications.connect(false);
    if (pendingCreateRef.current) {
      setError("登录状态已失效；请在新标签页登录原账户，再返回确认上次保存。");
    } else if (guardRef.current.dirty) {
      setError("登录状态已失效，当前未保存输入仍保留；请先下载本机备份，在新标签页登录原账户后再保存。");
    } else {
      setState("unauthenticated");
    }
  }, [notifications]);

  useEffect(() => bindWritingUnload(shouldBlock, window), [shouldBlock]);

  useEffect(() => {
    if (blocker.state === "blocked" && !routeLeave.current) {
      routeLeave.current = { editorKey: editorKeyRef.current, revision: guardRef.current.revision, pending: pendingCreateRef.current };
    } else if (blocker.state !== "blocked") routeLeave.current = null;
  }, [blocker.state]);

  useEffect(() => {
    // The save may finish while a client-side navigation dialog is open.
    if (!guarded && blocker.state === "blocked") blocker.reset();
  }, [guarded, blocker]);

  const reloadArticles = useCallback(async () => {
    const response = await fetch("/api/authoring/articles?allLocales=true", { credentials: "same-origin", cache: "no-store" });
    const payload: unknown = await response.json().catch(() => null);
    if (response.status === 401) { showSignIn(); return; }
    if (!response.ok) throw new Error(messageOf(payload));
    if (!confirmsAllLocales(payload)) throw new Error("无法确认所有语言版本，请检查 API 版本后重试。");
    const data = typeof payload === "object" && payload !== null && "data" in payload ? (payload as { data?: unknown }).data : null;
    if (!Array.isArray(data) || !data.every(isArticle)) throw new Error("作品列表响应格式不正确，无法安全显示所有语言版本。");
    setArticles(data);
    setState("ready");
  }, [showSignIn]);

  /**
   * The recycle bin is loaded separately and never blocks the desk: a failing
   * list of deleted works must not stop the author from writing, so its error is
   * reported inside the section it belongs to.
   */
  const reloadDeletedArticles = useCallback(async () => {
    const response = await fetch("/api/authoring/deleted-articles?allLocales=true", { credentials: "same-origin", cache: "no-store" });
    const payload: unknown = await response.json().catch(() => null);
    if (response.status === 401) { showSignIn(); return; }
    if (!response.ok) throw new Error(messageOf(payload));
    if (!confirmsAllLocales(payload)) throw new Error("无法确认回收站的所有语言版本。");
    const data = typeof payload === "object" && payload !== null && "data" in payload ? (payload as { data?: unknown }).data : null;
    if (!Array.isArray(data) || !data.every(isDeletedArticle)) throw new Error("回收站响应格式不正确，无法安全显示所有语言版本。");
    setDeleted(data);
    setTrashError("");
  }, [showSignIn]);

  /**
   * The byline is a public fact, so the desk reads it from its own API proxy.
   * A 404 is not an outage: it is the legacy "account without a profile" case,
   * which the panel lets the author repair by saving a pen name.
   */
  const reloadProfile = useCallback(async () => {
    const response = await fetch("/api/authoring/profile", { credentials: "same-origin", cache: "no-store" });
    const payload: unknown = await response.json().catch(() => null);
    if (response.status === 401) { showSignIn(); return; }
    if (response.status === 404) { setProfile(null); return; }
    if (!response.ok) throw new Error(messageOf(payload));
    setProfile(parseAuthorProfile(payload));
  }, [showSignIn]);

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
  }, [showSignIn, reloadArticles, reloadProfile, reloadDeletedArticles]);

  const openCatalogueDocument = useCallback(async (intent: CatalogueOpenIntent, token: WritingLeaveToken) => {
    if (intent.actor !== viewerId || !canLeaveWriting(token, editorKeyRef.current, guardRef.current, pendingCreateRef.current)) {
      setNotice("账户、文稿或保存状态已变化，未读取目录所选版本；请重新选择。");
      return;
    }
    const request = ++catalogueRequest.current;
    setCatalogueLoading(true);
    setError("");
    try {
      const article = await catalogueReader.read(intent, () => request === catalogueRequest.current &&
        canLeaveWriting(token, editorKeyRef.current, guardRef.current, pendingCreateRef.current));
      if (request !== catalogueRequest.current) return;
      if (!article) { setNotice("读取期间文稿或保存状态已变化，目录响应没有替换当前输入；可手动重新打开。"); return; }
      selectArticle(article);
      switchEditor(`catalogue-${editionKey(article)}`);
      setNotice(`已从全量目录打开《${article.title}》 · ${localeLabel(article.locale)}。保存仍使用原作品及修订，不会新建副本。`);
    } catch (caught) {
      if (request === catalogueRequest.current) setError(caught instanceof Error ? caught.message : "目录作品读取失败，编辑区未改变。");
    } finally {
      if (request === catalogueRequest.current) setCatalogueLoading(false);
    }
  }, [catalogueReader, selectArticle, switchEditor, viewerId]);

  useEffect(() => {
    if (state !== "ready" || !viewerId) return;
    const cleanup = () => { catalogueRequest.current++; catalogueReader.cancel(); };
    let intent: CatalogueOpenIntent | null;
    try { intent = parseCatalogueOpenIntent(pageLocation.search); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "目录链接无效。"); setCatalogueIntent(null); return cleanup; }
    setCatalogueIntent(intent);
    const approval = catalogueRouteApproval.current;
    catalogueRouteApproval.current = null;
    if (!intent) return cleanup;
    if (intent.actor !== viewerId) { setError("目录链接属于另一登录账户，请返回全部作品目录重新选择；当前编辑区未改变。"); return cleanup; }
    const token = { editorKey: editorKeyRef.current, revision: guardRef.current.revision };
    if (pendingCreateRef.current) setNotice("上次保存尚未确认，目录链接没有切换文稿。请先核对保存，再手动打开所选版本。");
    else if (guardRef.current.dirty && !(approval && approval.search === pageLocation.search && canLeaveWriting(approval, editorKeyRef.current, guardRef.current, false))) setLeave({ token, action: { kind: "catalogue", intent } });
    else void openCatalogueDocument(intent, token);
    return cleanup;
  }, [catalogueReader, openCatalogueDocument, pageLocation.key, pageLocation.search, state, viewerId]);

  function performDocumentAction(action: DocumentAction, token: WritingLeaveToken) {
    if (action.kind === "catalogue") { void openCatalogueDocument(action.intent, token); return; }
    if (action.kind === "sign-out") { void signOut(token); return; }
    selectArticle(action.kind === "open" ? action.article : null);
    switchEditor(action.kind === "open" ? `work-${editionKey(action.article)}` : "new");
    setNotice("");
  }

  function requestDocumentAction(action: DocumentAction) {
    if (pendingCreateRef.current) return;
    if (action.kind === "open" && selectedRef.current && editionKey(selectedRef.current) === editionKey(action.article)) return;
    const token = leaveToken();
    if (guardRef.current.dirty) setLeave({ token, action });
    else performDocumentAction(action, token);
  }

  function confirmDocumentAction() {
    if (!leave) return;
    setLeave(null);
    if (!canLeaveWriting(leave.token, editorKeyRef.current, guardRef.current, pendingCreateRef.current)) {
      setNotice("文稿或保存状态已变化，请重新确认离开；当前输入仍保留。");
      return;
    }
    performDocumentAction(leave.action, leave.token);
  }

  function openNewDocument() { requestDocumentAction({ kind: "new" }); }
  function openDocument(article: AuthoringArticle) { requestDocumentAction({ kind: "open", article }); }

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

  async function signOut(token: WritingLeaveToken) {
    if (signingOutRef.current || !canLeaveWriting(token, editorKeyRef.current, guardRef.current, pendingCreateRef.current)) return;
    signingOutRef.current = true;
    setSigningOut(true);
    const finishSessionChange = notifications.beginSessionChange();
    try {
      await writingRecoveryBoundary().runSessionChange(() => fetch("/api/auth/logout", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", cache: "no-store", body: "{}" }), setRecoveryWarning);
    } finally {
      finishSessionChange();
      signingOutRef.current = false;
      setSigningOut(false);
      if (!canLeaveWriting(token, editorKeyRef.current, guardRef.current, pendingCreateRef.current)) {
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
    return <section className="nw-auth-panel"><h1><span className="nw-zh">先登录</span> <i>Sign in</i></h1><p>写作、保存草稿与发布功能需要有效的登录会话。</p>{recoveryWarning ? <p className="nw-auth-error" role="alert">{recoveryWarning}</p> : null}<Link className="nw-btn nw-pri" href="/sign-in?next=%2Fwrite">登录或创建账户</Link></section>;
  }
  if (state === "error") return <section><p className="nw-auth-error" role="alert">{error}</p><button className="nw-btn" type="button" onClick={() => { setError(""); setState("loading"); window.location.reload(); }}>重新载入</button></section>;

  return (
    <section className="nw-authoring">
      <header className="nw-authoring-header">
        <div>
          <h1><span className="nw-zh">写作台</span> <i>Authoring</i></h1>
          <p className="nw-m">专注文学创作与纯粹写作</p>
        </div>
        <div className="nw-authoring-actions">
          <Link className="nw-btn" href="/write/library" style={{ fontWeight: 600 }}>全部作品目录</Link>
          <Link className="nw-btn" href="/write/media">媒体库</Link>
          <button className="nw-btn" type="button" disabled={pendingCreate || signingOut} onClick={() => requestDocumentAction({ kind: "sign-out" })}>退出登录</button>
        </div>
      </header>
      <details className="nw-authoring-help" style={{ margin: "12px 0 16px" }}>
        <summary className="nw-m" style={{ cursor: "pointer" }}>文稿存储说明：草稿与发布由服务器保存，请及时保存或下载备份 ▾</summary>
        <p className="nw-ep" style={{ marginTop: 8 }}>保存成功的草稿与发布状态由 API 持久化；未保存输入默认只在本页；只有明确启用下方本机恢复才会缓存。请保存服务器草稿或下载备份。</p>
      </details>
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
      {catalogueLoading ? <p role="status">正在核对目录所选作品的精确语言版本；继续输入或新建会使本次读取失效……</p> : null}
      {catalogueIntent ? <div className="nw-authoring-actions"><button className="nw-btn" type="button" disabled={pendingCreate || catalogueLoading} onClick={() => requestDocumentAction({ kind: "catalogue", intent: catalogueIntent })}>重新读取目录所选版本</button>{catalogueLoading ? <button className="nw-btn" type="button" onClick={() => { catalogueRequest.current++; catalogueReader.cancel(); setCatalogueLoading(false); }}>取消目录读取</button> : null}</div> : null}
      <div className="nw-authoring-grid">
        <aside className="nw-authoring-sidebar" aria-label="我的作品">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
            <h2 style={{ fontSize: 18, margin: 0 }}>我的作品（{articles.length}）</h2>
            <Link className="nw-m" href="/write/library">作品管理 →</Link>
          </div>
          <button className="nw-btn nw-pri" type="button" disabled={pendingCreate} onClick={openNewDocument} style={{ width: "100%", marginBottom: 12 }}>新建作品 +</button>
          <p className="nw-m">显示各语言最近 100 个版本；更早作品或批量导入请到<Link href="/write/library">作品管理</Link>。</p>
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
            onGuardChange={(guard) => changeGuard(guard, editorKey)}
          />
        </div>
      </div>
      {/* Leaving with an unconfirmed request is a question, not a form: the
          answer is a route decision (`blocker.proceed()`), so it belongs in the
          confirmation dialog rather than in an empty prompt form. */}
      <ConfirmDialog
        open={blocker.state === "blocked"}
        title={pendingCreate ? "上次保存尚未确认" : "离开未保存的文稿？"}
        description={pendingCreate ? "作品可能已经创建。离开后本页的重试标识和未保存的编辑会丢失，再次保存可能产生重复作品。" : "当前修改尚未保存，离开可能丢失最后输入；可选本机缓存不保证完整。建议先取消并保存，或在文稿工具中下载本机备份。"}
        confirmLabel="仍要离开"
        tone="danger"
        onCancel={() => { if (blocker.state === "blocked") blocker.reset(); }}
        onConfirm={() => {
          if (blocker.state !== "blocked") return;
          const token = routeLeave.current;
          if (!token || token.editorKey !== editorKeyRef.current || token.revision !== guardRef.current.revision || token.pending !== pendingCreateRef.current) {
            blocker.reset();
            setNotice("文稿或保存状态已变化，请重新发起导航并确认。");
          } else {
            if (blocker.location.pathname === pageLocation.pathname) catalogueRouteApproval.current = { editorKey: token.editorKey, revision: token.revision, search: blocker.location.search };
            blocker.proceed();
          }
        }}
      />
      <ConfirmDialog
        open={leave !== null}
        title="放弃未保存的修改？"
        description="当前修改尚未保存，继续可能丢失最后输入；本机缓存不保证完整，退出还会清除缓存。您可以取消，先保存或下载本机文稿备份。"
        confirmLabel={leave?.action.kind === "sign-out" ? "放弃修改并退出" : "放弃修改并切换"}
        tone="danger"
        onCancel={() => setLeave(null)}
        onConfirm={confirmDocumentAction}
      />
      {/* Keep supporting tools mounted and reachable, in a visual auxiliary area without displacing the writing flow. */}
      <div className="nw-authoring-auxiliary" aria-label="写作台辅助工具">
        <div className="nw-authoring-auxiliary-intro">
          <h2><span className="nw-zh">辅助功能与账户资料</span> <i>Auxiliary</i></h2>
          <p className="nw-m">作者公开署名资料、通知同步与回收站。正常创作与发布均可在上方主编辑区完成。</p>
        </div>
        <AuthorProfilePanel profile={profile} onSave={saveProfile} />
        <NotificationInbox locale="zh-CN" />
        <section className="nw-authoring-trash" aria-label="回收站">
          <h2>回收站（{deleted.length}）</h2>
          <p className="nw-m">这里只列出最近的已删除版本；<Link href="/write/library">到全量目录筛选回收站</Link>可分页核对更早作品并在还原前确认全部语言的影响。</p>
          {trashError ? <p className="nw-auth-error" role="alert">{trashError}</p> : null}
          {deleted.length === 0 && !trashError
            ? <p className="nw-m">没有已删除的作品。</p>
            : <div className="nw-authoring-trash-list">
                {deleted.map((entry) => {
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
              </div>}
        </section>
      </div>
    </section>
  );
}
