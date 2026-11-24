import { Link } from "@/lib/framework/link.tsx";
import { useState, type FormEvent } from "react";
import { MAIL_DISABLED_FORM_ERROR } from "@/lib/mail-copy.ts";
import { getUi } from "@/lib/ui-copy.ts";
import type { Locale } from "@/lib/content.ts";

type ApiErrorPayload = { error?: { message?: unknown } };

function errorMessage(payload: unknown, fallback: string): string {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) return fallback;
  const error = (payload as ApiErrorPayload).error;
  return error && typeof error.message === "string" ? error.message : fallback;
}

export function ForgotPasswordForm({ locale = "zh-CN" }: { locale?: Locale }) {
  const a = getUi(locale).account.forgotPassword;
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
      if (!response.ok) throw new Error(errorMessage(payload, a.failed));
      // `202` is the only answer the API gives, and it means the same thing in
      // both cases: nothing here may suggest whether the address is known.
      setSent(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : a.failed);
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <section className="nw-auth-panel" aria-labelledby="nw-reset-sent">
        <h1 id="nw-reset-sent"><span className="nw-zh">{a.sentTitle}</span> <i>Check your mail</i></h1>
        <p className="nw-ep nw-mt-24">
          {a.sentBody}
        </p>
        <p className="nw-auth-status" role="status">
          {a.sentHint}
        </p>
        <div className="nw-auth-switch">
          <button className="nw-btn" type="button" onClick={() => { setSent(false); setError(""); }}>{a.anotherEmail}</button>
          <Link className="nw-btn nw-pri" href="/sign-in">{a.backToSignIn}</Link>
        </div>
      </section>
    );
  }

  return (
    <section className="nw-auth-panel" aria-labelledby="nw-reset-title">
      <h1 id="nw-reset-title"><span className="nw-zh">{a.title}</span> <i>Reset</i></h1>
      <p className="nw-ep nw-mt-24">
        {a.intro}
      </p>
      <form className="nw-auth-form" onSubmit={(event) => { void submit(event); }}>
        <label>{a.emailLabel}
          <input type="email" name="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required maxLength={254} />
        </label>
        {error ? <p className="nw-auth-error" role="alert">{error}</p> : null}
        <button className="nw-btn nw-pri" type="submit" disabled={busy}>{busy ? a.busy : a.action}</button>
      </form>
      <div className="nw-auth-switch">
        <Link className="nw-btn" href="/sign-in">{a.backToSignIn}</Link>
      </div>
    </section>
  );
}
