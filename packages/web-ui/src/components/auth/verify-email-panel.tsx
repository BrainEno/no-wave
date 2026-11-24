import { Link } from "@/lib/framework/link.tsx";
import { getUi } from "@/lib/ui-copy.ts";
import type { Locale } from "@/lib/content.ts";
import { useEffect, useRef, useState } from "react";

type VerifyEmailPanelProps = { token: string; locale?: Locale };
type ApiErrorPayload = { error?: { message?: unknown } };
type Outcome = "verifying" | "verified" | "failed";

function errorMessage(payload: unknown, fallback: string): string {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) return fallback;
  const error = (payload as ApiErrorPayload).error;
  return error && typeof error.message === "string" ? error.message : fallback;
}

export function VerifyEmailPanel({ token, locale = "zh-CN" }: VerifyEmailPanelProps) {
  const ui = getUi(locale);
  const v = ui.account.verifyEmail;
  // 文案是稳定字符串，抽出来后可直接作为 hook 的依赖。
  const invalid = v.invalid;
  const errServer = ui.account.errors.serverUnreachable;
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
          setError(errorMessage(payload, invalid));
          setOutcome("failed");
          return;
        }
        setOutcome("verified");
      } catch {
        if (active) {
          setError(errServer);
          setOutcome("failed");
        }
      }
    })();
    return () => { active = false; };
  }, [token, invalid, errServer]);

  if (!token) {
    return (
      <section className="nw-auth-panel" aria-labelledby="nw-verify-broken">
        <h1 id="nw-verify-broken"><span className="nw-zh">{v.brokenTitle}</span> <i>Incomplete link</i></h1>
        <p className="nw-ep nw-mt-24">
          {v.brokenBody}
        </p>
        <div className="nw-auth-switch">
          <Link className="nw-btn nw-pri" href="/sign-in">{v.goSignIn}</Link>
        </div>
      </section>
    );
  }

  if (outcome === "verifying") {
    return (
      <section className="nw-auth-panel" aria-labelledby="nw-verify-busy">
        <h1 id="nw-verify-busy"><span className="nw-zh">{v.busyTitle}</span> <i>Verifying</i></h1>
        <p className="nw-auth-status nw-mt-24" role="status">{v.busyBody}</p>
      </section>
    );
  }

  if (outcome === "verified") {
    return (
      <section className="nw-auth-panel" aria-labelledby="nw-verify-done">
        <h1 id="nw-verify-done"><span className="nw-zh">{v.doneTitle}</span> <i>Verified</i></h1>
        <p className="nw-ep nw-mt-24">
          {v.doneBody}<strong>{v.doneStrong}</strong>{v.doneTail}
        </p>
        <div className="nw-auth-switch">
          <Link className="nw-btn nw-pri" href="/write">{v.backToDesk}</Link>
        </div>
      </section>
    );
  }

  return (
    <section className="nw-auth-panel" aria-labelledby="nw-verify-failed">
      <h1 id="nw-verify-failed"><span className="nw-zh">{v.failedTitle}</span> <i>Not verified</i></h1>
      <p className="nw-auth-error nw-mt-24" role="alert">{error}</p>
      <p className="nw-ep">
        {v.failedBody}
      </p>
      <div className="nw-auth-switch">
        <Link className="nw-btn nw-pri" href="/write">{v.resend}</Link>
        <Link className="nw-btn" href="/sign-in">{v.goSignIn}</Link>
      </div>
    </section>
  );
}
