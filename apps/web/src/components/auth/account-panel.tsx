"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

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

export function AccountPanel() {
  const router = useRouter();
  const [state, setState] = useState<State>("checking");
  const [account, setAccount] = useState<Account | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<null | "verification" | "logout">(null);

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
      <dl className="nw-account-fields">
        <dt>邮箱</dt>
        <dd data-account-email>{account?.email ?? "（这个账号没有绑定邮箱）"}</dd>
        <dt>验证状态</dt>
        <dd data-account-verification>
          {verified ? `已验证（${localDate(String(account?.emailVerifiedAt))}）` : "未验证"}
        </dd>
        <dt>账号 ID</dt>
        <dd data-account-id>{account?.id}</dd>
      </dl>
      {verified ? null : (
        <p className="nw-ep">
          未验证的账号同样可以登录、写作和发布：验证只是给这个邮箱留一个「曾经可达」的标记，用于在需要时确认你仍能收到邮件。
        </p>
      )}
      {error ? <p className="nw-auth-error" role="alert">{error}</p> : null}
      {notice ? <p className="nw-auth-status" role="status">{notice}</p> : null}
      <div className="nw-auth-switch">
        {verified ? null : (
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
