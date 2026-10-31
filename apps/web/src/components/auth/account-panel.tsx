"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

/**
 * The signed-in account page.
 *
 * The page render only knows that a session *might* exist — the token cookies
 * are scoped below `/`, so a private page cannot read them and must not. Who the
 * visitor is comes from `GET /api/authoring/session`, which is where the cookie
 * lives and where the API does the actual verification. So this component has
 * three answers, not two: signed in, signed out (redirect), and unknown
 * (the API could not be asked).
 *
 * Shared by the Next.js page and the React Router prototype route: it imports
 * only `next/link` and `next/navigation`, both of which the prototype shims.
 */

type Account = { id: string; email: string | null; emailVerifiedAt: string | null };
type ApiErrorPayload = { error?: { message?: unknown } };

type State = "checking" | "ready" | "signed-out" | "error";

function isAccount(value: unknown): value is Account {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Account>;
  return typeof candidate.id === "string" && candidate.id.length > 0 &&
    (candidate.email === null || typeof candidate.email === "string") &&
    (candidate.emailVerifiedAt === null || typeof candidate.emailVerifiedAt === "string");
}

function dataOf(payload: unknown): unknown {
  return typeof payload === "object" && payload !== null && "data" in payload
    ? (payload as { data: unknown }).data
    : null;
}

function errorMessage(payload: unknown, fallback: string): string {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) return fallback;
  const error = (payload as ApiErrorPayload).error;
  return error && typeof error.message === "string" ? error.message : fallback;
}

/** A date is rendered in the reader's own locale, so it never needs a timezone. */
function localDate(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleDateString() : "未知时间";
}

/** The address and its verification state, as the API answers them. */
function changedAddress(payload: unknown): { email: string; emailVerifiedAt: string | null } | null {
  const data = dataOf(payload);
  if (typeof data !== "object" || data === null) return null;
  const email = (data as { email?: unknown }).email;
  if (typeof email !== "string") return null;
  const emailVerifiedAt = (data as { emailVerifiedAt?: unknown }).emailVerifiedAt;
  return { email, emailVerifiedAt: typeof emailVerifiedAt === "string" ? emailVerifiedAt : null };
}

/** How many other devices were signed out, when the API says. */
function revokedCount(payload: unknown): number {
  const data = typeof payload === "object" && payload !== null && "data" in payload
    ? (payload as { data: unknown }).data
    : null;
  const count = typeof data === "object" && data !== null && "revokedSessions" in data
    ? (data as { revokedSessions: unknown }).revokedSessions
    : null;
  return typeof count === "number" && Number.isFinite(count) ? count : 0;
}

export function AccountPanel({ mailEnabled }: { mailEnabled: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<State>("checking");
  const [account, setAccount] = useState<Account | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<null | "verification" | "logout" | "password" | "email">(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [emailPassword, setEmailPassword] = useState("");

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await fetch("/api/authoring/session", { credentials: "same-origin", cache: "no-store" });
        const payload: unknown = await response.json().catch(() => null);
        if (!active) return;
        if (response.status === 401) {
          // Not an error: the session is over, and the honest thing to do is to
          // send the visitor somewhere they can start a new one.
          setState("signed-out");
          router.replace("/sign-in?next=%2Faccount");
          return;
        }
        if (!response.ok) {
          setError(errorMessage(payload, "暂时无法确认登录状态，请稍后重试。"));
          setState("error");
          return;
        }
        const data = dataOf(payload);
        if (!isAccount(data)) {
          setError("登录状态响应格式不正确。");
          setState("error");
          return;
        }
        setAccount(data);
        setState("ready");
      } catch {
        if (active) {
          setError("暂时无法连接服务器，请稍后重试。");
          setState("error");
        }
      }
    })();
    return () => { active = false; };
  }, [router]);

  async function requestVerification() {
    setBusy("verification");
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/authoring/email-verification", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: "{}",
      });
      const payload: unknown = await response.json().catch(() => null);
      if (response.status === 401) {
        setState("signed-out");
        router.replace("/sign-in?next=%2Faccount");
        return;
      }
      if (response.status === 409) {
        // The switch is off on this deployment: not a failure to retry, and not
        // something the visitor can fix. Say what it is.
        setError("这个站点没有启用邮件功能，无法发送验证邮件。");
        return;
      }
      if (!response.ok) {
        setError(errorMessage(payload, "验证邮件发送失败，请稍后重试。"));
        return;
      }
      // A 202 says the request was accepted, not that the mail arrived: the
      // relay is configured by the operator and may not be configured at all.
      setNotice("验证邮件已发出，请查收邮箱并按其中的链接完成验证。");
    } catch {
      setError("暂时无法连接服务器，请稍后重试。");
    } finally {
      setBusy(null);
    }
  }

  /**
   * Move the account to another address.
   *
   * The current password is asked for because the API asks for it, and the API
   * asks for it because whoever controls the address controls the account's
   * recovery: a session on its own must not be able to move it. The answer
   * carries the address and its verification state, so the panel can show the
   * new one without asking again.
   */
  async function changeEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("email");
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/authoring/email", {
        method: "PUT",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ password: emailPassword, email: newEmail }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (response.status === 401) {
        setState("signed-out");
        router.replace("/sign-in?next=%2Faccount");
        return;
      }
      if (response.status === 409) {
        setError("这个邮箱已经被其他账号使用，请换一个。");
        return;
      }
      if (response.status === 400) {
        setError("邮箱格式不正确，当前密码也不能为空。");
        return;
      }
      if (!response.ok) {
        setError(errorMessage(payload, "修改邮箱失败，请稍后重试。"));
        return;
      }
      const changed = changedAddress(payload);
      if (changed) setAccount((current) => current && { ...current, email: changed.email, emailVerifiedAt: changed.emailVerifiedAt });
      setNewEmail("");
      setEmailPassword("");
      setNotice(`邮箱已更新为 ${changed?.email ?? "新地址"}。这个地址还没有验证标记——验证只是留一个「曾经可达」的记录，不影响登录、写作和发布。`);
    } catch {
      setError("暂时无法连接服务器，请稍后重试。");
    } finally {
      setBusy(null);
    }
  }

  /**
   * Change the password of the account that is already signed in.
   *
   * The current password is asked for here because the API asks for it: a
   * session alone must not be enough to move the credential. What comes back is
   * how many *other* devices were signed out, and that number is worth showing
   * — it is the answer to "what happened to my phone".
   */
  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("password");
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/authoring/password", {
        method: "PUT",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (response.status === 401) {
        setState("signed-out");
        router.replace("/sign-in?next=%2Faccount");
        return;
      }
      if (response.status === 400) {
        // The API's own message is deliberately generic, so say what the rule is.
        setError("新密码需要至少 12 个字符，旧密码也不能为空。");
        return;
      }
      if (!response.ok) {
        setError(errorMessage(payload, "修改密码失败，请稍后重试。"));
        return;
      }
      setCurrentPassword("");
      setNewPassword("");
      const revoked = revokedCount(payload);
      setNotice(revoked > 0
        ? `密码已更新，其他 ${revoked} 台设备已退出登录；这个会话保持登录。`
        : "密码已更新；没有其他设备处于登录状态。");
    } catch {
      setError("暂时无法连接服务器，请稍后重试。");
    } finally {
      setBusy(null);
    }
  }

  async function signOut() {
    setBusy("logout");
    setError("");
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: "{}",
      });
    } catch {
      // Logout is local first: the cookies are cleared by the proxy even when
      // the API is unreachable, so a network failure must not keep the visitor
      // on a page that says they are signed in.
    }
    router.replace("/");
    router.refresh();
  }

  if (state === "checking") {
    return (
      <section className="nw-auth-panel" aria-labelledby="nw-account-checking">
        <h1 id="nw-account-checking"><span className="nw-zh">我的账户</span> <i>Account</i></h1>
        <p className="nw-auth-status" role="status" style={{ marginTop: 24 }}>正在确认登录状态，请稍候……</p>
      </section>
    );
  }

  if (state === "signed-out") {
    return (
      <section className="nw-auth-panel" aria-labelledby="nw-account-out">
        <h1 id="nw-account-out"><span className="nw-zh">尚未登录</span> <i>Signed out</i></h1>
        <p className="nw-ep" style={{ marginTop: 24 }}>这个会话已经结束，正在前往登录页……</p>
        <div className="nw-auth-switch">
          <Link className="nw-btn nw-pri" href="/sign-in?next=%2Faccount">前往登录</Link>
        </div>
      </section>
    );
  }

  if (state === "error") {
    return (
      <section className="nw-auth-panel" aria-labelledby="nw-account-error">
        <h1 id="nw-account-error"><span className="nw-zh">账户信息暂时无法载入</span> <i>Unavailable</i></h1>
        <p className="nw-auth-error" role="alert" style={{ marginTop: 24 }}>{error}</p>
        <div className="nw-auth-switch">
          <Link className="nw-btn nw-pri" href="/write">回到写作台</Link>
          <Link className="nw-btn" href="/sign-in?next=%2Faccount">重新登录</Link>
        </div>
      </section>
    );
  }

  const verified = Boolean(account?.emailVerifiedAt);

  return (
    <section className="nw-auth-panel" aria-labelledby="nw-account-title">
      <h1 id="nw-account-title"><span className="nw-zh">我的账户</span> <i>Account</i></h1>
      <p className="nw-ep" style={{ marginTop: 24 }}>
        这里是这个账号的身份信息。令牌只存在于 HttpOnly cookie 中，页面拿不到，也不会出现在这里。
      </p>
      {mailEnabled ? null : (
        <p className="nw-ep" data-mail-state="disabled">
          找回密码与邮箱验证需要邮件功能，而这个站点没有启用它；除此之外账号的一切照常。
        </p>
      )}
      <dl className="nw-account-fields">
        <dt>邮箱</dt>
        <dd data-account-email>{account?.email ?? "（这个账号没有绑定邮箱）"}</dd>
        <dt>验证状态</dt>
        <dd data-account-verification>
          {verified ? `已验证（${localDate(String(account?.emailVerifiedAt))}）` : mailEnabled ? "未验证" : "本站未启用邮件功能"}
        </dd>
        <dt>账号 ID</dt>
        <dd data-account-id>{account?.id}</dd>
      </dl>
      {mailEnabled === false || verified ? null : (
        <p className="nw-ep">
          未验证的账号同样可以登录、写作和发布：验证只是给这个邮箱留一个「曾经可达」的标记，用于在需要时确认你仍能收到邮件。
        </p>
      )}
      <form className="nw-auth-form" onSubmit={changeEmail} aria-labelledby="nw-account-email-title" data-account-email-form>
        <h2 id="nw-account-email-title"><span className="nw-zh">修改邮箱</span> <i>Change address</i></h2>
        <p className="nw-ep">
          这个邮箱是账号找回密码时唯一的去处，所以修改它需要输入当前密码：只有会话、没有密码的话，谁都不能把账号的找回途径搬走。
          改完之后这个地址会变成「未验证」——验证只是留一个「曾经可达」的标记，不影响登录、写作和发布。
        </p>
        <label>新邮箱
          <input
            type="email"
            name="email"
            autoComplete="email"
            value={newEmail}
            onChange={(event) => setNewEmail(event.target.value)}
            required
            maxLength={254}
          />
        </label>
        <label>当前密码
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            value={emailPassword}
            onChange={(event) => setEmailPassword(event.target.value)}
            required
            maxLength={128}
          />
        </label>
        <button className="nw-btn nw-pri" type="submit" disabled={busy !== null} data-account-email-submit>
          {busy === "email" ? "正在修改……" : "修改邮箱"}
        </button>
      </form>
      {/*
        Changing the password needs no mail. That is the point of it: the
        recovery flow is the only other way to replace a credential, and on an
        instance where mail is switched off it cannot run at all.
      */}
      <form className="nw-auth-form" onSubmit={changePassword} aria-labelledby="nw-account-password-title" data-account-password>
        <h2 id="nw-account-password-title"><span className="nw-zh">修改密码</span> <i>Change password</i></h2>
        <p className="nw-ep">
          需要输入当前密码：只有会话、没有密码的话，谁都不能改掉这个账号——包括把你锁在门外。改完之后，
          除了这台设备之外的登录都会退出，而这个会话继续保持登录状态。
        </p>
        <label>当前密码
          <input
            type="password"
            name="currentPassword"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            required
            maxLength={128}
          />
        </label>
        <label>新密码（至少 12 个字符）
          <input
            type="password"
            name="newPassword"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            required
            minLength={12}
            maxLength={128}
          />
        </label>
        <button className="nw-btn nw-pri" type="submit" disabled={busy !== null} data-account-password-submit>
          {busy === "password" ? "正在修改……" : "修改密码"}
        </button>
      </form>
      {error ? <p className="nw-auth-error" role="alert">{error}</p> : null}
      {notice ? <p className="nw-auth-status" role="status">{notice}</p> : null}
      <div className="nw-auth-switch">
        {mailEnabled === false || verified ? null : (
          <button className="nw-btn nw-pri" type="button" disabled={busy !== null} onClick={() => void requestVerification()}>
            {busy === "verification" ? "正在发送……" : "发送验证邮件"}
          </button>
        )}
        <button className="nw-btn" type="button" disabled={busy !== null} onClick={() => void signOut()}>
          {busy === "logout" ? "正在退出……" : "退出登录"}
        </button>
        <Link className="nw-btn" href="/write">回到写作台</Link>
      </div>
    </section>
  );
}
