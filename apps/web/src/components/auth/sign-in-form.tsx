"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

type SignInFormProps = {
  nextPath: string;
  /**
   * Whether this deployment can mail anybody.
   *
   * Read on the server and handed down: a "forgot your password?" link that
   * leads to a page which cannot send anything is a promise the site cannot
   * keep, so it is not rendered. The API would refuse the request anyway with
   * 503 `MAIL_DISABLED`; this just stops offering it.
   */
  mailEnabled: boolean;
};
type ApiErrorPayload = { error?: { message?: unknown } };

function errorMessage(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) return "请求失败，请稍后重试。";
  const error = (payload as ApiErrorPayload).error;
  return error && typeof error.message === "string" ? error.message : "请求失败，请稍后重试。";
}

export function SignInForm({ nextPath, mailEnabled }: SignInFormProps) {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ email, password }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(payload));
      setStatus(mode === "register" ? "账户已创建，正在打开写作台……" : "登录成功，正在打开写作台……");
      router.replace(nextPath);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "请求失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="nw-auth-panel" aria-labelledby="nw-auth-title">
      <h1 id="nw-auth-title"><span className="nw-zh">{mode === "login" ? "进入写作" : "创建账户"}</span> <i>{mode === "login" ? "Sign in" : "Join"}</i></h1>
      <p className="nw-ep" style={{ marginTop: 24 }}>
        {mode === "login" ? "登录后可以继续编辑草稿、保存修改并发布作品。" : "使用邮箱与至少 12 个字符的密码创建账户。"}
      </p>
      <form className="nw-auth-form" onSubmit={submit}>
        <label>邮箱
          <input type="email" name="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required maxLength={254} />
        </label>
        <label>密码
          <input type="password" name="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} required minLength={mode === "register" ? 12 : 1} maxLength={128} />
        </label>
        {error ? <p className="nw-auth-error" role="alert">{error}</p> : null}
        {status ? <p className="nw-auth-status" role="status">{status}</p> : null}
        <button className="nw-btn nw-pri" type="submit" disabled={busy}>{busy ? "请稍候…" : mode === "login" ? "登录并继续" : "创建账户并继续"}</button>
      </form>
      <div className="nw-auth-switch">
        <button className="nw-btn" type="button" disabled={busy} onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); setStatus(""); }}>
          {mode === "login" ? "没有账户？创建账户" : "已有账户？登录"}
        </button>
        {mailEnabled ? <Link className="nw-btn" href="/forgot-password">忘记密码？</Link> : null}
        <a className="nw-btn" href="/">返回首页</a>
      </div>
    </section>
  );
}
