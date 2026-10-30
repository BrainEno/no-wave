"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type VerifyEmailPanelProps = { token: string };
type ApiErrorPayload = { error?: { message?: unknown } };
type Outcome = "verifying" | "verified" | "failed";

function errorMessage(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) return "链接已失效或已被使用。";
  const error = (payload as ApiErrorPayload).error;
  return error && typeof error.message === "string" ? error.message : "链接已失效或已被使用。";
}

export function VerifyEmailPanel({ token }: VerifyEmailPanelProps) {
  const [outcome, setOutcome] = useState<Outcome>("verifying");
  const [error, setError] = useState("");
  const submitted = useRef<string | null>(null);

  /**
   * Redeemed once, on arrival: the visitor clicked a link in a mail, and asking
   * them to press a button to use it is a step that only exists to be forgotten.
   * The ref is what keeps that from becoming a loop — React's development-mode
   * double effect would otherwise spend the token on the first render and fail
   * on the second, which looks exactly like a broken link.
   */
  useEffect(() => {
    if (!token || submitted.current === token) return;
    submitted.current = token;
    let active = true;
    void (async () => {
      try {
        const response = await fetch("/api/auth/verify-email", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          credentials: "same-origin",
          cache: "no-store",
          body: JSON.stringify({ token }),
        });
        const payload: unknown = await response.json().catch(() => null);
        if (!active) return;
        if (!response.ok) {
          setError(errorMessage(payload));
          setOutcome("failed");
          return;
        }
        setOutcome("verified");
      } catch {
        if (active) {
          setError("暂时无法连接服务器，请稍后重试。");
          setOutcome("failed");
        }
      }
    })();
    return () => { active = false; };
  }, [token]);

  if (!token) {
    return (
      <section className="nw-auth-panel" aria-labelledby="nw-verify-broken">
        <h1 id="nw-verify-broken"><span className="nw-zh">链接不完整</span> <i>Incomplete link</i></h1>
        <p className="nw-ep" style={{ marginTop: 24 }}>
          这个地址里没有验证令牌。验证邮件只发给已登录的账号本人：登录后在写作台请求一封新的即可。
        </p>
        <div className="nw-auth-switch">
          <Link className="nw-btn nw-pri" href="/sign-in">前往登录</Link>
        </div>
      </section>
    );
  }

  if (outcome === "verifying") {
    return (
      <section className="nw-auth-panel" aria-labelledby="nw-verify-busy">
        <h1 id="nw-verify-busy"><span className="nw-zh">正在验证</span> <i>Verifying</i></h1>
        <p className="nw-auth-status" role="status" style={{ marginTop: 24 }}>正在使用邮件中的链接验证这个邮箱，请稍候……</p>
      </section>
    );
  }

  if (outcome === "verified") {
    return (
      <section className="nw-auth-panel" aria-labelledby="nw-verify-done">
        <h1 id="nw-verify-done"><span className="nw-zh">邮箱已验证</span> <i>Verified</i></h1>
        <p className="nw-ep" style={{ marginTop: 24 }}>
          这个地址已经标记为已验证。它只记录这个邮箱曾经可达，<strong>不会限制你的任何操作</strong>：未验证的账号同样可以登录、写作和发布。
        </p>
        <div className="nw-auth-switch">
          <Link className="nw-btn nw-pri" href="/write">回到写作台</Link>
        </div>
      </section>
    );
  }

  return (
    <section className="nw-auth-panel" aria-labelledby="nw-verify-failed">
      <h1 id="nw-verify-failed"><span className="nw-zh">验证未完成</span> <i>Not verified</i></h1>
      <p className="nw-auth-error" role="alert" style={{ marginTop: 24 }}>{error}</p>
      <p className="nw-ep">
        验证链接 24 小时内有效，且只能使用一次；申请新的链接会让旧的那个立即失效。
      </p>
      <div className="nw-auth-switch">
        <Link className="nw-btn nw-pri" href="/write">在写作台重新发送</Link>
        <Link className="nw-btn" href="/sign-in">前往登录</Link>
      </div>
    </section>
  );
}
