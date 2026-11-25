import { Link } from "@/lib/framework/link.tsx";
import { useNotificationActions } from "@/components/chrome/notification-provider.tsx";
import { writingRecoveryBoundary } from "@/lib/writing-recovery-boundary.ts";
import { useRouter } from "@/lib/framework/navigation.ts";
import { getUi } from "@/lib/ui-copy.ts";
import type { Locale } from "@/lib/content.ts";
import { useCallback, useEffect, useState, type FormEvent } from "react";

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
 * It is shared UI (`@no-wave/web-ui`), so it reaches the router only through
 * `@/lib/framework/*` and names no framework of its own.
 */

/** `isEditor` is the assembled fact, so the panel never has to know how it is minted. */
type Account = { id: string; email: string | null; emailVerifiedAt: string | null; isEditor: boolean };
type ApiErrorPayload = { error?: { message?: unknown } };

type State = "checking" | "ready" | "signed-out" | "error";

function isAccount(value: unknown): value is Account {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Account>;
  return typeof candidate.id === "string" && candidate.id.length > 0 &&
    typeof candidate.isEditor === "boolean" &&
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
function localDate(value: string, fallback: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleDateString() : fallback;
}

/**
 * A date *and* a time, because a device list is compared in hours: "signed in
 * at 09:40" is the difference between the laptop and the phone left on a train.
 */
function localDateTime(value: string, fallback: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : fallback;
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

/**
 * A device, as the API describes one.
 *
 * Deliberately thin: an id, when it was signed in, when it last refreshed, when
 * it lapses, and whether it is the one doing the looking. No user agent, no
 * address, no geolocation — the API stores none of them (ADR 0019), so this
 * list asks the visitor to recognise a timestamp rather than to trust a
 * fingerprint the site had to collect to produce it.
 */
type Device = {
  sessionId: string; createdAt: string; lastUsedAt: string | null; expiresAt: string; current: boolean;
};

/** The device list, or `null` when the answer is not one. */
function deviceListOf(payload: unknown): Device[] | null {
  const data = dataOf(payload);
  const sessions = typeof data === "object" && data !== null && "sessions" in data
    ? (data as { sessions: unknown }).sessions
    : null;
  if (!Array.isArray(sessions)) return null;
  const devices: Device[] = [];
  for (const entry of sessions) {
    if (typeof entry !== "object" || entry === null) return null;
    const candidate = entry as Partial<Device>;
    if (typeof candidate.sessionId !== "string" || candidate.sessionId.length === 0) return null;
    if (typeof candidate.createdAt !== "string" || typeof candidate.expiresAt !== "string") return null;
    devices.push({
      sessionId: candidate.sessionId,
      createdAt: candidate.createdAt,
      lastUsedAt: typeof candidate.lastUsedAt === "string" ? candidate.lastUsedAt : null,
      expiresAt: candidate.expiresAt,
      current: candidate.current === true,
    });
  }
  return devices;
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

export function AccountPanel({ mailEnabled, locale }: { mailEnabled: boolean; locale: Locale }) {
  const router = useRouter();
  const notifications = useNotificationActions();
  const ui = getUi(locale);
  const a = ui.account;
  // 文案是稳定字符串，抽出来后可直接作为 hook 的依赖，避免每轮渲染重建对象。
  const errSession = a.errors.sessionUnavailable;
  const errSessionMalformed = a.errors.sessionMalformed;
  const errServer = a.errors.serverUnreachable;
  const errDevices = a.errors.devicesUnavailable;
  const errDevicesMalformed = a.errors.devicesMalformed;
  const [state, setState] = useState<State>("checking");
  const [account, setAccount] = useState<Account | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<null | "verification" | "logout" | "password" | "email">(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [devicesError, setDevicesError] = useState("");
  /** The device being ended, and whether "end the others" is in flight. */
  const [ending, setEnding] = useState<string | null>(null);
  const [endingOthers, setEndingOthers] = useState(false);

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
          void notifications.connect(false);
          setState("signed-out");
          router.replace("/sign-in?next=%2Faccount");
          return;
        }
        if (!response.ok) {
          setError(errorMessage(payload, errSession));
          setState("error");
          return;
        }
        const data = dataOf(payload);
        if (!isAccount(data)) {
          setError(errSessionMalformed);
          setState("error");
          return;
        }
        setAccount(data);
        setState("ready");
      } catch {
        if (active) {
          setError(errServer);
          setState("error");
        }
      }
    })();
    return () => { active = false; };
  }, [router, notifications, errSession, errSessionMalformed, errServer]);

  /** The session is over: the honest answer is a sign-in page, not an error. */
  const goToSignIn = useCallback(() => {
    void notifications.connect(false);
    setState("signed-out");
    router.replace("/sign-in?next=%2Faccount");
  }, [router, notifications]);

  const refreshDevices = useCallback(async (active: () => boolean = () => true) => {
    try {
      const response = await fetch("/api/authoring/sessions", { credentials: "same-origin", cache: "no-store" });
      const payload: unknown = await response.json().catch(() => null);
      if (!active()) return;
      if (response.status === 401) {
        goToSignIn();
        return;
      }
      if (!response.ok) {
        setDevicesError(errDevices);
        return;
      }
      const list = deviceListOf(payload);
      if (!list) {
        setDevicesError(errDevicesMalformed);
        return;
      }
      setDevices(list);
      setDevicesError("");
    } catch {
      if (active()) setDevicesError(errServer);
    }
  }, [goToSignIn, errDevices, errDevicesMalformed, errServer]);

  // Devices are asked for only once the account is known: a list fetched
  // before then would be a list for nobody.
  useEffect(() => {
    if (state !== "ready") return;
    let active = true;
    void refreshDevices(() => active);
    return () => { active = false; };
  }, [state, refreshDevices]);

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
        setError(a.errors.mailNotEnabled);
        return;
      }
      if (!response.ok) {
        setError(errorMessage(payload, a.errors.mailSendFailed));
        return;
      }
      // A 202 says the request was accepted, not that the mail arrived: the
      // relay is configured by the operator and may not be configured at all.
      setNotice(a.notices.mailSent);
    } catch {
      setError(a.errors.serverUnreachable);
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
        setError(a.errors.emailTaken);
        return;
      }
      if (response.status === 400) {
        setError(a.errors.emailInvalid);
        return;
      }
      if (!response.ok) {
        setError(errorMessage(payload, a.errors.emailChangeFailed));
        return;
      }
      const changed = changedAddress(payload);
      if (changed) setAccount((current) => current && { ...current, email: changed.email, emailVerifiedAt: changed.emailVerifiedAt });
      setNewEmail("");
      setEmailPassword("");
      setNotice(a.notices.emailUpdated(changed?.email ?? a.notices.emailNewFallback));
    } catch {
      setError(a.errors.serverUnreachable);
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
        setError(a.errors.passwordInvalid);
        return;
      }
      if (!response.ok) {
        setError(errorMessage(payload, a.errors.passwordChangeFailed));
        return;
      }
      setCurrentPassword("");
      setNewPassword("");
      const revoked = revokedCount(payload);
      setNotice(revoked > 0
        ? a.notices.passwordUpdatedOthers(revoked)
        : a.notices.passwordUpdatedNone);
    } catch {
      setError(a.errors.serverUnreachable);
    } finally {
      setBusy(null);
    }
  }

  /**
   * End one device.
   *
   * Ending the device you are holding is allowed — it is what the logout button
   * does — and the redirect afterwards falls out of the next request answering
   * 401, so there is no special case to get wrong here.
   */
  async function endDevice(sessionId: string) {
    let recoveryWarning: string | null = null;
    setEnding(sessionId);
    setError("");
    setNotice("");
    try {
      const current = devices?.find(device => device.sessionId === sessionId)?.current === true;
      const request = () => fetch(`/api/authoring/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
        headers: { accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      const response = current
        ? await writingRecoveryBoundary().runSessionChange(request, value => { recoveryWarning = value; })
        : await request();
      if (recoveryWarning) { setError(recoveryWarning); setState("signed-out"); return; }
      if (response.status === 401) {
        goToSignIn();
        return;
      }
      if (response.status === 404) {
        // Already gone — from the visitor's side the device is off either way.
        setNotice(a.notices.deviceGone);
        await refreshDevices();
        return;
      }
      if (!response.ok) {
        setError(errorMessage(await response.json().catch(() => null), a.errors.endDeviceFailed));
        return;
      }
      await refreshDevices();
      setNotice(a.notices.deviceSignedOut);
    } catch {
      setError(recoveryWarning ?? a.errors.serverUnreachable);
      if (recoveryWarning) setState("signed-out");
    } finally {
      setEnding(null);
    }
  }

  /**
   * End every other device: the lost-phone answer that does not require
   * changing the password. The one that asks is spared, which is the API's
   * decision and not this page's.
   */
  async function endOtherDevices() {
    setEndingOthers(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/authoring/sessions", {
        method: "DELETE",
        headers: { accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      const payload: unknown = await response.json().catch(() => null);
      if (response.status === 401) {
        goToSignIn();
        return;
      }
      if (!response.ok) {
        setError(errorMessage(payload, a.errors.endOthersFailed));
        return;
      }
      const revoked = revokedCount(payload);
      await refreshDevices();
      setNotice(revoked > 0
        ? a.notices.othersSignedOut(revoked)
        : a.notices.othersNone);
    } catch {
      setError(a.errors.serverUnreachable);
    } finally {
      setEndingOthers(false);
    }
  }

  async function signOut() {
    let recoveryWarning: string | null = null;
    const finishSessionChange = notifications.beginSessionChange();
    setBusy("logout");
    setError("");
    try {
      await writingRecoveryBoundary().runSessionChange(() => fetch("/api/auth/logout", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: "{}",
      }), value => { recoveryWarning = value; });
    } catch {
      // Logout is local first: the cookies are cleared by the proxy even when
      // the API is unreachable, so a network failure must not keep the visitor
      // on a page that says they are signed in.
    } finally {
      finishSessionChange();
    }
    if (recoveryWarning) { setError(recoveryWarning); setState("signed-out"); return; }
    router.replace("/");
    router.refresh();
  }

  if (state === "checking") {
    return (
      // The checking shell uses the loaded page's header so the swap does not shift layout.
      <section className="nw-auth-panel nw-acct" aria-labelledby="nw-account-checking">
        <header className="nw-acct-head">
          <div className="nw-avatar nw-acct-avatar nw-sk" aria-hidden="true" />
          <div className="nw-acct-id">
            <h1 id="nw-account-checking"><span className="nw-zh">{a.checking.title}</span> <i>Account</i></h1>
            <p className="nw-acct-sub" role="status">{a.checking.status}</p>
          </div>
        </header>
      </section>
    );
  }

  if (state === "signed-out") {
    return (
      <section className="nw-auth-panel" aria-labelledby="nw-account-out">
        <h1 id="nw-account-out"><span className="nw-zh">{a.signedOut.title}</span> <i>Signed out</i></h1>
        <p className="nw-ep nw-mt-24">{a.signedOut.body}</p>
        {error ? <p className="nw-auth-error" role="alert">{error}</p> : null}
        <div className="nw-auth-switch">
          <Link className="nw-btn nw-pri" href="/sign-in?next=%2Faccount">{a.signedOut.goSignIn}</Link>
        </div>
      </section>
    );
  }

  if (state === "error") {
    return (
      <section className="nw-auth-panel" aria-labelledby="nw-account-error">
        <h1 id="nw-account-error"><span className="nw-zh">{a.unavailable.title}</span> <i>Unavailable</i></h1>
        <p className="nw-auth-error nw-mt-24" role="alert">{error}</p>
        <div className="nw-auth-switch">
          <Link className="nw-btn nw-pri" href="/write">{a.unavailable.backToDesk}</Link>
          <Link className="nw-btn" href="/sign-in?next=%2Faccount">{a.unavailable.retrySignIn}</Link>
        </div>
      </section>
    );
  }

  const verified = Boolean(account?.emailVerifiedAt);

  return (
    <section className="nw-auth-panel nw-acct" aria-labelledby="nw-account-title">
      {/* 账户页：一张名片 + 左侧分区索引 + 右侧卡片。说明文字折叠，表单并排。 */}
      <header className="nw-acct-head">
        <div className="nw-avatar nw-acct-avatar" aria-hidden="true">{(account?.email ?? a.avatarEmpty).slice(0, 1).toUpperCase()}</div>
        <div className="nw-acct-id">
          <h1 id="nw-account-title"><span className="nw-zh">{a.checking.title}</span> <i>Account</i></h1>
          <p className="nw-acct-sub">
            <span>{account?.isEditor ? a.role.editor : a.role.author}</span>
            <span className={verified ? "nw-desk-ok" : "nw-desk-warn"}>{verified ? a.email.verified : mailEnabled ? a.email.unverified : a.email.mailOff}</span>
          </p>
        </div>
        <div className="nw-acct-head-actions">
          <Link className="nw-btn nw-sec" href="/write">{a.unavailable.backToDesk}</Link>
          <button className="nw-btn" type="button" disabled={busy !== null} onClick={() => void signOut()}>
            {busy === "logout" ? a.logout.busy : a.logout.action}
          </button>
        </div>
      </header>
      <div className="nw-acct-grid">
        <nav className="nw-acct-nav" aria-label={a.nav.aria}>
          <a href="#nw-account-identity-title"><span>01</span>{a.nav.identity}</a>
          <a href="#nw-account-devices-title"><span>02</span>{a.nav.devices}</a>
          <a href="#nw-account-email-title"><span>03</span>{a.nav.changeEmail}</a>
          <a href="#nw-account-password-title"><span>04</span>{a.nav.changePassword}</a>
        </nav>
        <div className="nw-acct-body">
      <section className="nw-acct-card" aria-labelledby="nw-account-identity-title">
      <h2 id="nw-account-identity-title"><span className="nw-zh">{a.identity.title}</span> <i>Identity</i></h2>
      <p className="nw-ep">
        {a.identity.intro}
      </p>
      {mailEnabled ? null : (
        <p className="nw-ep" data-mail-state="disabled">
          {a.identity.mailOffNote}
        </p>
      )}
      <dl className="nw-account-fields">
        <dt>{a.identity.emailLabel}</dt>
        <dd data-account-email>{account?.email ?? a.identity.emailEmpty}</dd>
        <dt>{a.identity.verifiedLabel}</dt>
        <dd data-account-verification>
          {verified ? a.identity.verifiedYes(localDate(String(account?.emailVerifiedAt), a.unknownTime)) : mailEnabled ? a.identity.verifiedNo : a.identity.verifiedMailOff}
        </dd>
        <dt>{a.identity.roleLabel}</dt>
        <dd data-account-role>{account?.isEditor ? a.role.editor : a.role.author}</dd>
      </dl>
      {account?.isEditor ? (
        <p className="nw-ep">
          {a.identity.editorIntro}<Link href="/admin/featured" data-account-curate-link>{a.identity.curateLink}</Link>{a.identity.curateTail}
        </p>
      ) : null}
      {mailEnabled === false || verified ? null : (
        <div className="nw-acct-verify">
          <p className="nw-ep">{a.identity.unverifiedNote}</p>
          <button className="nw-btn" type="button" disabled={busy !== null} onClick={() => void requestVerification()}>
            {busy === "verification" ? a.identity.sendVerification.busy : a.identity.sendVerification.action}
          </button>
          <details className="nw-account-details">
            <summary>{a.identity.verificationAbout.summary}</summary>
            <p>{a.identity.verificationAbout.body}</p>
          </details>
        </div>
      )}
      <details className="nw-account-details">
        <summary>{a.identity.advanced.summary}</summary>
        <dl className="nw-account-fields nw-account-advanced">
          <dt>{a.identity.advanced.idLabel}</dt>
          <dd data-account-id>{account?.id}</dd>
        </dl>
        <p>{a.identity.advanced.tokenNote}</p>
      </details>
      </section>
      {/*
        Devices.

        The list answers the question nobody could ask before: what is signed in
        as me, and how do I stop the one I lost? It says nothing about what a
        device *is* beyond when it appeared and when it last refreshed, because
        the server collected nothing else about it — that is the bargain ADR
        0019 strikes, and the copy says so rather than pretending the labels are
        coming.
      */}
      <div className="nw-auth-form nw-acct-card" aria-labelledby="nw-account-devices-title" data-account-devices>
        <h2 id="nw-account-devices-title"><span className="nw-zh">{a.devices.title}</span> <i>Devices</i></h2>
        <p className="nw-ep">
          {a.devices.intro}
        </p>
        <details className="nw-account-details">
          <summary>{a.devices.privacySummary}</summary>
          <p>
            {a.devices.privacyBody}
          </p>
        </details>
        {devices === null && devicesError === "" ? (
          <p className="nw-auth-status" role="status" data-devices-loading>{a.devices.loading}</p>
        ) : null}
        {devicesError !== "" ? (
          <p className="nw-auth-error" role="alert" data-devices-error>{devicesError}</p>
        ) : null}
        {devices && devices.length === 0 ? (
          <p className="nw-auth-status" role="status" data-devices-empty>{a.devices.empty}</p>
        ) : null}
        {devices && devices.length > 0 ? (
          <ul className="nw-device-list" data-device-list>
            {devices.map((device) => (
              <li className="nw-device-row" key={device.sessionId} data-device={device.sessionId} data-device-current={device.current}>
                <span className="nw-device-meta">
                  <strong>{device.current ? a.devices.current : a.devices.other}</strong>
                  <small>
                    {a.devices.signedIn} {localDateTime(device.createdAt, a.unknownTime)}；{a.devices.lastActivity} {device.lastUsedAt ? localDateTime(device.lastUsedAt, a.unknownTime) : a.devices.atLogin}
                  </small>
                </span>
                <span className="nw-device-actions">
                  <button
                    className="nw-btn"
                    type="button"
                    disabled={ending !== null || endingOthers}
                    onClick={() => void endDevice(device.sessionId)}
                    data-device-end={device.sessionId}
                  >
                    {ending === device.sessionId ? a.devices.ending.busy : a.devices.ending.thisOne}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {devices && devices.length > 1 ? (
          <div className="nw-auth-switch">
            <button
              className="nw-btn"
              type="button"
              disabled={ending !== null || endingOthers}
              onClick={() => void endOtherDevices()}
              data-devices-end-others
            >
              {endingOthers ? a.devices.endingOthers.busy : a.devices.endingOthers.action}
            </button>
          </div>
        ) : null}
      </div>
      <div className="nw-acct-pair">
      <form className="nw-auth-form nw-acct-card" onSubmit={(event) => { void changeEmail(event); }} aria-labelledby="nw-account-email-title" data-account-email-form>
        <h2 id="nw-account-email-title"><span className="nw-zh">{a.changeEmail.title}</span> <i>Change address</i></h2>
        <p className="nw-ep">
          {a.changeEmail.intro}
        </p>
        <details className="nw-account-details">
          <summary>{a.changeEmail.securitySummary}</summary>
          <p>
            {a.changeEmail.securityBody}
            {a.changeEmail.securityNote}
          </p>
        </details>
        <label>{a.changeEmail.newEmailLabel}
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
        <label>{a.changeEmail.currentPasswordLabel}
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
        <button className="nw-btn" type="submit" disabled={busy !== null} data-account-email-submit>
          {busy === "email" ? a.changeEmail.busy : a.changeEmail.action}
        </button>
      </form>
      {/*
        Changing the password needs no mail. That is the point of it: the
        recovery flow is the only other way to replace a credential, and on an
        instance where mail is switched off it cannot run at all.
      */}
      <form className="nw-auth-form nw-acct-card" onSubmit={(event) => { void changePassword(event); }} aria-labelledby="nw-account-password-title" data-account-password>
        <h2 id="nw-account-password-title"><span className="nw-zh">{a.changePassword.title}</span> <i>Change password</i></h2>
        <p className="nw-ep">
          {a.changePassword.intro}
        </p>
        <details className="nw-account-details">
          <summary>{a.changePassword.securitySummary}</summary>
          <p>
            {a.changePassword.securityBody}
            {a.changePassword.securityBodyTail}
          </p>
        </details>
        <label>{a.changePassword.currentPasswordLabel}
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
        <label>{a.changePassword.newPasswordLabel}
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
        <button className="nw-btn" type="submit" disabled={busy !== null} data-account-password-submit>
          {busy === "password" ? a.changePassword.busy : a.changePassword.action}
        </button>
      </form>
      </div>
      {error ? <p className="nw-auth-error nw-acct-flash" role="alert">{error}</p> : null}
      {notice ? <p className="nw-auth-status nw-acct-flash" role="status">{notice}</p> : null}
        </div>
      </div>
    </section>
  );
}
