import { writingRecoveryBoundary } from "@/lib/writing-recovery-boundary.ts";
import { Link } from "@/lib/framework/link.tsx";
import { getUi } from "@/lib/ui-copy.ts";
import type { Locale } from "@/lib/content.ts";
import { useState, type FormEvent } from "react";

type ResetPasswordFormProps = { token: string; locale?: Locale };
type ApiErrorPayload = { error?: { message?: unknown } };

function errorMessage(payload: unknown, fallback: string): string {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) return fallback;
  const error = (payload as ApiErrorPayload).error;
  return error && typeof error.message === "string" ? error.message : fallback;
}

export function ResetPasswordForm({ token, locale = "zh-CN" }: ResetPasswordFormProps) {
  const a = getUi(locale).account.resetPassword;
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [recoveryWarning, setRecoveryWarning] = useState<string | null>(null);

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
      const response = await writingRecoveryBoundary().runSessionChange(() => fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        // The token travels in the body, never in the path.
        body: JSON.stringify({ token, password }),
      }), setRecoveryWarning);
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(payload, a.failed));
      setDone(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : a.failed);
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <section className="nw-auth-panel" aria-labelledby="nw-reset-broken">
        <h1 id="nw-reset-broken"><span className="nw-zh">{a.brokenTitle}</span> <i>Incomplete link</i></h1>
        <p className="nw-ep nw-mt-24">
          {a.brokenBody}
        </p>
        <div className="nw-auth-switch">
          <Link className="nw-btn nw-pri" href="/forgot-password">{a.reapply}</Link>
          <Link className="nw-btn" href="/sign-in">{a.backToSignIn}</Link>
        </div>
      </section>
    );
  }

  if (done) {
    return (
      <section className="nw-auth-panel" aria-labelledby="nw-reset-done">
        <h1 id="nw-reset-done"><span className="nw-zh">{a.doneTitle}</span> <i>New password set</i></h1>
        <p className="nw-ep nw-mt-24">
          {a.doneBody}<strong>{a.doneStrong}</strong>{a.doneTail}
        </p>
        {recoveryWarning ? <p className="nw-auth-error" role="alert">{recoveryWarning}</p> : null}
        <div className="nw-auth-switch">
          <Link className="nw-btn nw-pri" href="/sign-in">{a.goSignIn}</Link>
        </div>
      </section>
    );
  }

  return (
    <section className="nw-auth-panel" aria-labelledby="nw-reset-new">
      <h1 id="nw-reset-new"><span className="nw-zh">{a.newTitle}</span> <i>New password</i></h1>
      <p className="nw-ep nw-mt-24">
        {a.intro}
      </p>
      <form className="nw-auth-form" onSubmit={(event) => { void submit(event); }}>
        <label>{a.newPasswordLabel}
          <input type="password" name="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={12} maxLength={128} />
        </label>
        <label>{a.confirmLabel}
          <input type="password" name="confirmation" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required minLength={12} maxLength={128} />
        </label>
        {mismatch ? <p className="nw-auth-error" role="alert">{a.mismatch}</p> : null}
        {error ? <p className="nw-auth-error" role="alert">{error}</p> : null}
        {recoveryWarning ? <p className="nw-auth-error" role="alert">{recoveryWarning}</p> : null}
        <button className="nw-btn nw-pri" type="submit" disabled={busy || mismatch}>{busy ? a.busy : a.action}</button>
      </form>
      <div className="nw-auth-switch">
        {/* A spent or expired link is the ordinary way to land here after a
            failed attempt, so "apply again" is always within reach. */}
        <Link className="nw-btn" href="/forgot-password">{a.reapplyLink}</Link>
        <Link className="nw-btn" href="/sign-in">{a.backToSignIn}</Link>
      </div>
    </section>
  );
}
