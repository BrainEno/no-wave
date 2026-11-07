import { Link } from "@/lib/framework/link.tsx";
import { useRouter } from "@/lib/framework/navigation.ts";
import { useEffect, useState, type FormEvent } from "react";

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
 * It is shared UI (`@bot-thk/web-ui`), so it reaches the router only through
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
function localDate(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleDateString() : "未知时间";
}

/**
 * A date *and* a time, because a device list is compared in hours: "signed in
 * at 09:40" is the difference between the laptop and the phone left on a train.
 */
function localDateTime(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : "未知时间";
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

export function AccountPanel({ mailEnabled }: { mailEnabled: boolean }) {
  const router = useRouter();
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

  // Devices are asked for only once the account is known: a list fetched
  // before then would be a list for nobody.
  useEffect(() => {
    if (state !== "ready") return;
    let active = true;
    void refreshDevices(() => active);
    return () => { active = false; };
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

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
        setError("这个站点没有启用邮件功能，无法发送验证邮件。");
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
        setError("这个邮箱已经被其他账号使用，请换一个。");
        return;
      }
      if (response.status === 400) {
        setError("邮箱格式不正确，当前密码也不能为空。");
        return;
      }
      if (!response.ok) {
        setError(errorMessage(payload, "修改邮箱失败，请稍后重试。"));
        return;
      }
      const changed = changedAddress(payload);
      if (changed) setAccount((current) => current && { ...current, email: changed.email, emailVerifiedAt: changed.emailVerifiedAt });
      setNewEmail("");
      setEmailPassword("");
      setNotice(`邮箱已更新为 ${changed?.email ?? "新地址"}。这个地址还没有验证标记——验证只是留一个「曾经可达」的记录，不影响登录、写作和发布。`);
    } catch {
      setError("暂时无法连接服务器，请稍后重试。");
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
        setError("新密码需要至少 12 个字符，旧密码也不能为空。");
        return;
      }
      if (!response.ok) {
        setError(errorMessage(payload, "修改密码失败，请稍后重试。"));
        return;
      }
      setCurrentPassword("");
      setNewPassword("");
      const revoked = revokedCount(payload);
      setNotice(revoked > 0
        ? `密码已更新，其他 ${revoked} 台设备已退出登录；这个会话保持登录。`
        : "密码已更新；没有其他设备处于登录状态。");
    } catch {
      setError("暂时无法连接服务器，请稍后重试。");
    } finally {
      setBusy(null);
    }
  }

  /** The session is over: the honest answer is a sign-in page, not an error. */
  function goToSignIn() {
    setState("signed-out");
    router.replace("/sign-in?next=%2Faccount");
  }

  async function refreshDevices(active = () => true) {
    try {
      const response = await fetch("/api/authoring/sessions", { credentials: "same-origin", cache: "no-store" });
      const payload: unknown = await response.json().catch(() => null);
      if (!active()) return;
      if (response.status === 401) {
        goToSignIn();
        return;
      }
      if (!response.ok) {
        setDevicesError("暂时无法载入设备列表，请稍后重试。");
        return;
      }
      const list = deviceListOf(payload);
      if (!list) {
        setDevicesError("设备列表响应格式不正确。");
        return;
      }
      setDevices(list);
      setDevicesError("");
    } catch {
      if (active()) setDevicesError("暂时无法连接服务器，请稍后重试。");
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
    setEnding(sessionId);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/authoring/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
        headers: { accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.status === 401) {
        goToSignIn();
        return;
      }
      if (response.status === 404) {
        // Already gone — from the visitor's side the device is off either way.
        setNotice("这台设备已经不在线了。");
        await refreshDevices();
        return;
      }
      if (!response.ok) {
        setError(errorMessage(await response.json().catch(() => null), "结束这台设备失败，请稍后重试。"));
        return;
      }
      await refreshDevices();
      setNotice("这台设备已退出登录，它手里的令牌即刻失效。");
    } catch {
      setError("暂时无法连接服务器，请稍后重试。");
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
        setError(errorMessage(payload, "结束其他设备失败，请稍后重试。"));
        return;
      }
      const revoked = revokedCount(payload);
      await refreshDevices();
      setNotice(revoked > 0
        ? `已让其他 ${revoked} 台设备退出登录；这台设备保持登录。`
        : "没有其他设备处于登录状态。");
    } catch {
      setError("暂时无法连接服务器，请稍后重试。");
    } finally {
      setEndingOthers(false);
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
      {mailEnabled ? null : (
        <p className="nw-ep" data-mail-state="disabled">
          找回密码与邮箱验证需要邮件功能，而这个站点没有启用它；除此之外账号的一切照常。
        </p>
      )}
      <dl className="nw-account-fields">
        <dt>邮箱</dt>
        <dd data-account-email>{account?.email ?? "（这个账号没有绑定邮箱）"}</dd>
        <dt>验证状态</dt>
        <dd data-account-verification>
          {verified ? `已验证（${localDate(String(account?.emailVerifiedAt))}）` : mailEnabled ? "未验证" : "本站未启用邮件功能"}
        </dd>
        <dt>账号 ID</dt>
        <dd data-account-id>{account?.id}</dd>
        <dt>权限</dt>
        <dd data-account-role>{account?.isEditor ? "编辑" : "作者"}</dd>
      </dl>
      {account?.isEditor ? (
        <p className="nw-ep">
          这个账号是编辑，可以挑选首页的「精选」：<Link href="/admin/featured" data-account-curate-link>编辑精选</Link>。
        </p>
      ) : null}
      {mailEnabled === false || verified ? null : (
        <p className="nw-ep">
          未验证的账号同样可以登录、写作和发布：验证只是给这个邮箱留一个「曾经可达」的标记，用于在需要时确认你仍能收到邮件。
        </p>
      )}
      {/*
        Devices.

        The list answers the question nobody could ask before: what is signed in
        as me, and how do I stop the one I lost? It says nothing about what a
        device *is* beyond when it appeared and when it last refreshed, because
        the server collected nothing else about it — that is the bargain ADR
        0019 strikes, and the copy says so rather than pretending the labels are
        coming.
      */}
      <div className="nw-auth-form" aria-labelledby="nw-account-devices-title" data-account-devices>
        <h2 id="nw-account-devices-title"><span className="nw-zh">登录的设备</span> <i>Devices</i></h2>
        <p className="nw-ep">
          这些是正在以这个账号登录的会话。服务端只记录会话的创建时间、最近一次续期时间和失效时间——没有设备型号、浏览器和地址，
          因为项目里任何地方都不存这些；所以这里只能靠时间认出是哪一台。
        </p>
        {devices === null && devicesError === "" ? (
          <p className="nw-auth-status" role="status" data-devices-loading>正在载入设备列表……</p>
        ) : null}
        {devicesError !== "" ? (
          <p className="nw-auth-error" role="alert" data-devices-error>{devicesError}</p>
        ) : null}
        {devices && devices.length === 0 ? (
          <p className="nw-auth-status" role="status" data-devices-empty>除了这台设备，没有其他登录。</p>
        ) : null}
        {devices && devices.length > 0 ? (
          <ul className="nw-device-list" data-device-list>
            {devices.map((device) => (
              <li className="nw-device-row" key={device.sessionId} data-device={device.sessionId} data-device-current={device.current}>
                <span className="nw-device-meta">
                  <strong>{device.current ? "这台设备" : "另一台设备"}</strong>
                  <small>
                    登录于 {localDateTime(device.createdAt)}；最近活动 {device.lastUsedAt ? localDateTime(device.lastUsedAt) : "就是登录时"}
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
                    {ending === device.sessionId ? "正在结束……" : "结束这台"}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {devices && devices.length > 1 ? (
          <div className="nw-auth-switch">
            <button
              className="nw-btn nw-pri"
              type="button"
              disabled={ending !== null || endingOthers}
              onClick={() => void endOtherDevices()}
              data-devices-end-others
            >
              {endingOthers ? "正在结束……" : "结束其他全部设备"}
            </button>
          </div>
        ) : null}
      </div>
      <form className="nw-auth-form" onSubmit={changeEmail} aria-labelledby="nw-account-email-title" data-account-email-form>
        <h2 id="nw-account-email-title"><span className="nw-zh">修改邮箱</span> <i>Change address</i></h2>
        <p className="nw-ep">
          这个邮箱是账号找回密码时唯一的去处，所以修改它需要输入当前密码：只有会话、没有密码的话，谁都不能把账号的找回途径搬走。
          改完之后这个地址会变成「未验证」——验证只是留一个「曾经可达」的标记，不影响登录、写作和发布。
        </p>
        <label>新邮箱
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
        <label>当前密码
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
        <button className="nw-btn nw-pri" type="submit" disabled={busy !== null} data-account-email-submit>
          {busy === "email" ? "正在修改……" : "修改邮箱"}
        </button>
      </form>
      {/*
        Changing the password needs no mail. That is the point of it: the
        recovery flow is the only other way to replace a credential, and on an
        instance where mail is switched off it cannot run at all.
      */}
      <form className="nw-auth-form" onSubmit={changePassword} aria-labelledby="nw-account-password-title" data-account-password>
        <h2 id="nw-account-password-title"><span className="nw-zh">修改密码</span> <i>Change password</i></h2>
        <p className="nw-ep">
          需要输入当前密码：只有会话、没有密码的话，谁都不能改掉这个账号——包括把你锁在门外。改完之后，
          除了这台设备之外的登录都会退出，而这个会话继续保持登录状态。
        </p>
        <label>当前密码
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
        <label>新密码（至少 12 个字符）
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
        <button className="nw-btn nw-pri" type="submit" disabled={busy !== null} data-account-password-submit>
          {busy === "password" ? "正在修改……" : "修改密码"}
        </button>
      </form>
      {error ? <p className="nw-auth-error" role="alert">{error}</p> : null}
      {notice ? <p className="nw-auth-status" role="status">{notice}</p> : null}
      <div className="nw-auth-switch">
        {mailEnabled === false || verified ? null : (
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
