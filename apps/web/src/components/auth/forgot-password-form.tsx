"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { MAIL_DISABLED_FORM_ERROR } from "@/lib/mail-copy.ts";

type ApiErrorPayload = { error?: { message?: unknown } };

function errorMessage(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) return "请求失败，请稍后重试。";
  const error = (payload as ApiErrorPayload).error;
  return error && typeof error.message === "string" ? error.message : "请求失败，请稍后重试。";
}

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ email }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (response.status === 409) {
        // The Web switch says on, the API's says off: answer in the visitor's
        // language rather than echoing the API's English message.
        throw new Error(MAIL_DISABLED_FORM_ERROR);
      }
      if (!response.ok) throw new Error(errorMessage(payload));
      // `202` is the only answer the API gives, and it means the same thing in
      // both cases: nothing here may suggest whether the address is known.
      setSent(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "请求失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <section className="nw-auth-panel" aria-labelledby="nw-reset-sent">
        <h1 id="nw-reset-sent"><span className="nw-zh">请查收邮件</span> <i>Check your mail</i></h1>
        <p className="nw-ep" style={{ marginTop: 24 }}>
          如果这个邮箱已注册，重设链接已经发出。链接 30 分钟内有效，且只能使用一次；若几分钟后仍未收到，请检查垃圾邮件文件夹。
        </p>
        <p className="nw-auth-status" role="status">
          没有收到？可以稍后再试，或换一个邮箱地址申请。
        </p>
        <div className="nw-auth-switch">
          <button className="nw-btn" type="button" onClick={() => { setSent(false); setError(""); }}>换个邮箱申请</button>
          <Link className="nw-btn nw-pri" href="/sign-in">返回登录</Link>
        </div>
      </section>
    );
  }

  return (
    <section className="nw-auth-panel" aria-labelledby="nw-reset-title">
      <h1 id="nw-reset-title"><span className="nw-zh">找回密码</span> <i>Reset</i></h1>
      <p className="nw-ep" style={{ marginTop: 24 }}>
        输入注册时使用的邮箱。如果这个邮箱已注册，我们会向它发送一封包含重设链接的邮件。
      </p>
      <form className="nw-auth-form" onSubmit={submit}>
        <label>邮箱
          <input type="email" name="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required maxLength={254} />
        </label>
        {error ? <p className="nw-auth-error" role="alert">{error}</p> : null}
        <button className="nw-btn nw-pri" type="submit" disabled={busy}>{busy ? "请稍候…" : "发送重设链接"}</button>
      </form>
      <div className="nw-auth-switch">
        <Link className="nw-btn" href="/sign-in">返回登录</Link>
      </div>
    </section>
  );
}
