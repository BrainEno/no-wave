import { Link } from "@/lib/framework/link.tsx";
import { useNotificationActions } from "@/components/chrome/notification-provider.tsx";
import { useState, type FormEvent } from "react";
import { useRouter } from "@/lib/framework/navigation.ts";
import { writingRecoveryBoundary } from "@/lib/writing-recovery-boundary.ts";
import { apiErrorCode } from "@/lib/api-error.ts";
import { signInFailureMessage } from "@/lib/rate-limit.ts";
import { signInSuccessMessage } from "@/lib/auth-navigation.ts";
import { getUi } from "@/lib/ui-copy.ts";
import type { Locale } from "@/lib/content.ts";

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
  /** Defaults to Simplified Chinese: the sign-in page is served in it today. */
  locale?: Locale;
};

export function SignInForm({ nextPath, mailEnabled, locale = "zh-CN" }: SignInFormProps) {
  const router = useRouter();
  const notifications = useNotificationActions();
  const ui = getUi(locale);
  const s = ui.account.signIn;
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [recoveryWarning, setRecoveryWarning] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const finishSessionChange = notifications.beginSessionChange();
    setBusy(true);
    setError("");
    setStatus("");
    try {
      let warning: string | null = null;
      const response = await writingRecoveryBoundary().runSessionChange(() => fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ email, password }),
      }), value => { warning = value; setRecoveryWarning(value); });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        // A taken address is not a failure to report but a next step: the
        // account exists, so hand the reader the form that opens it, with the
        // address and password they just typed still in the fields.
        if (apiErrorCode(payload) === "EMAIL_TAKEN") setMode("login");
        throw new Error(signInFailureMessage(payload, locale, response.headers.get("retry-after")));
      }
      finishSessionChange();
      void notifications.connect(true);
      setStatus(signInSuccessMessage(nextPath, mode, locale));
      if (warning) { setSignedIn(true); return; }
      router.replace(nextPath);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : ui.auth.failed);
    } finally {
      finishSessionChange();
      setBusy(false);
    }
  }

  return (
    <section className="nw-auth-panel" aria-labelledby="nw-auth-title">
      <h1 id="nw-auth-title"><span className="nw-zh">{mode === "login" ? s.loginTitle : s.registerTitle}</span> <i>{mode === "login" ? "Sign in" : "Join"}</i></h1>
      <p className="nw-ep nw-mt-24">
        {mode === "login" ? s.loginIntro : s.registerIntro}
      </p>
      {recoveryWarning ? <p className="nw-auth-error" role="alert">{recoveryWarning}</p> : null}
      {signedIn ? <Link className="nw-btn" href={nextPath}>{s.continue}</Link> : null}
      <form className="nw-auth-form" onSubmit={(event) => { void submit(event); }}>
        <label>{s.emailLabel}
          <input type="email" name="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required maxLength={254} />
        </label>
        <label>{s.passwordLabel}
          <input type="password" name="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} required minLength={mode === "register" ? 12 : 1} maxLength={128} />
        </label>
        {error ? <p className="nw-auth-error" role="alert">{error}</p> : null}
        {status ? <p className="nw-auth-status" role="status">{status}</p> : null}
        <button className="nw-btn nw-pri" type="submit" disabled={busy}>{busy ? s.busy : mode === "login" ? s.loginAction : s.registerAction}</button>
      </form>
      <div className="nw-auth-switch">
        <button className="nw-btn" type="button" disabled={busy} onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); setStatus(""); }}>
          {mode === "login" ? s.switchToRegister : s.switchToLogin}
        </button>
        {mailEnabled ? <Link className="nw-btn" href="/forgot-password">{s.forgotPassword}</Link> : null}
        <a className="nw-btn" href="/">{s.backHome}</a>
      </div>
    </section>
  );
}
