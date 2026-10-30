"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

type ResetPasswordFormProps = { token: string };
type ApiErrorPayload = { error?: { message?: unknown } };

function errorMessage(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) return "请求失败，请稍后重试。";
  const error = (payload as ApiErrorPayload).error;
  return error && typeof error.message === "string" ? error.message : "请求失败，请稍后重试。";
}

export function ResetPasswordForm({ token }: ResetPasswordFormProps) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  // Checked here as well as at the API: a mismatch is the one mistake the
  // author can make that the server can only report after the fact, and by then
  // the typing is lost.
  const mismatch = confirmation.length > 0 && confirmation !== password;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mismatch) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        // The token travels in the body, never in the path.
        body: JSON.stringify({ token, password }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(payload));
      setDone(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "请求失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <section className="nw-auth-panel" aria-labelledby="nw-reset-broken">
        <h1 id="nw-reset-broken"><span className="nw-zh">链接不完整</span> <i>Incomplete link</i></h1>
        <p className="nw-ep" style={{ marginTop: 24 }}>
          这个地址里没有重设令牌，可能是邮件客户端把链接截断了。请回到登录页重新申请一封重设邮件。
        </p>
        <div className="nw-auth-switch">
          <Link className="nw-btn nw-pri" href="/forgot-password">重新申请</Link>
          <Link className="nw-btn" href="/sign-in">返回登录</Link>
        </div>
      </section>
    );
  }

  if (done) {
    return (
      <section className="nw-auth-panel" aria-labelledby="nw-reset-done">
        <h1 id="nw-reset-done"><span className="nw-zh">密码已重设</span> <i>New password set</i></h1>
        <p className="nw-ep" style={{ marginTop: 24 }}>
          请使用新密码重新登录。<strong>你此前登录的所有设备都已退出</strong>——重设密码会吊销这个账号的全部会话，这是找回账号的意义所在。
        </p>
        <div className="nw-auth-switch">
          <Link className="nw-btn nw-pri" href="/sign-in">前往登录</Link>
        </div>
      </section>
    );
  }

  return (
    <section className="nw-auth-panel" aria-labelledby="nw-reset-new">
      <h1 id="nw-reset-new"><span className="nw-zh">设置新密码</span> <i>New password</i></h1>
      <p className="nw-ep" style={{ marginTop: 24 }}>
        新密码至少 12 个字符。这个链接只能使用一次，重设后它会立即失效。
      </p>
      <form className="nw-auth-form" onSubmit={submit}>
        <label>新密码
          <input type="password" name="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={12} maxLength={128} />
        </label>
        <label>确认新密码
          <input type="password" name="confirmation" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required minLength={12} maxLength={128} />
        </label>
        {mismatch ? <p className="nw-auth-error" role="alert">两次输入的密码不一致。</p> : null}
        {error ? <p className="nw-auth-error" role="alert">{error}</p> : null}
        <button className="nw-btn nw-pri" type="submit" disabled={busy || mismatch}>{busy ? "请稍候…" : "重设密码"}</button>
      </form>
      <div className="nw-auth-switch">
        {/* A spent or expired link is the ordinary way to land here after a
            failed attempt, so "apply again" is always within reach. */}
        <Link className="nw-btn" href="/forgot-password">重新申请重设链接</Link>
        <Link className="nw-btn" href="/sign-in">返回登录</Link>
      </div>
    </section>
  );
}
