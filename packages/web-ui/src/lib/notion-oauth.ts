/**
 * One-shot Notion OAuth on the desk (ADR 0053).
 *
 * The desk opens Notion's authorize page in a popup and stays where it is, so its
 * selection and memory survive. Notion sends the popup back to
 * `/write/notion/oauth/callback`, which clears the code from the address bar,
 * has our API redeem it, and hands the access token to the desk over a
 * same-origin `BroadcastChannel` named after the `state` this desk started — a
 * value only this desk and that callback know. `window.opener` is not used, so a
 * future `Cross-Origin-Opener-Policy` (or Notion's own) cannot break the handoff.
 *
 * From there the token is exactly a pasted one: it lives in the page's memory,
 * goes only to `notion-fetch`, and is gone on reload. Nothing here writes to
 * storage, the URL or a cookie, and no message built here contains the token or
 * the code.
 */

export const NOTION_OAUTH_STATUS_ENDPOINT = "/api/authoring/notion-oauth";
export const NOTION_OAUTH_START_ENDPOINT = "/api/authoring/notion-oauth/start";
export const NOTION_OAUTH_EXCHANGE_ENDPOINT = "/api/authoring/notion-oauth/exchange";

/** As long as the API keeps a started state valid. */
export const NOTION_OAUTH_WAIT_MS = 10 * 60 * 1000;

const CHANNEL_PREFIX = "nw-notion-oauth:";

/** The channel one authorization is answered on; derived from its state, never shared. */
export function notionOAuthChannelName(state: string): string {
  return `${CHANNEL_PREFIX}${state}`;
}

export type NotionOAuthMessage =
  | { kind: "notion-oauth"; ok: true; token: string; workspaceName: string | null }
  | { kind: "notion-oauth"; ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A message on the channel, if it has the one shape the callback sends. */
export function readNotionOAuthMessage(data: unknown): NotionOAuthMessage | null {
  if (!isRecord(data) || data.kind !== "notion-oauth") return null;
  if (data.ok === true && typeof data.token === "string" && data.token.length > 0) {
    const name = typeof data.workspaceName === "string" && data.workspaceName.trim() !== "" ? data.workspaceName.slice(0, 200) : null;
    return { kind: "notion-oauth", ok: true, token: data.token, workspaceName: name };
  }
  if (data.ok === false && typeof data.message === "string") return { kind: "notion-oauth", ok: false, message: data.message.slice(0, 300) };
  return null;
}

export type NotionOAuthCallback =
  | { kind: "code"; code: string; state: string }
  | { kind: "denied"; state: string | null }
  | { kind: "invalid" };

/** What Notion put on the callback URL: a code and state, a refusal, or nothing usable. */
export function parseNotionOAuthCallback(search: string): NotionOAuthCallback {
  const params = new URLSearchParams(search);
  const state = params.get("state");
  if (params.has("error")) return { kind: "denied", state: state !== null && state.length <= 200 ? state : null };
  const code = params.get("code");
  if (code === null || code === "" || state === null || state === "" || state.length > 200 || code.length > 512) return { kind: "invalid" };
  return { kind: "code", code, state };
}

function errorCode(payload: unknown): string | null {
  const code = isRecord(payload) && isRecord(payload.error) ? payload.error.code : null;
  return typeof code === "string" ? code : null;
}

/** A failed start or exchange in the author's words; fixed sentences keyed by the API's codes. */
export function notionOAuthFailureMessage(status: number, payload: unknown): string {
  const code = errorCode(payload);
  if (code === "NOTION_OAUTH_DISABLED") return "本站没有配置 Notion 授权，请改用粘贴令牌。";
  if (code === "NOTION_OAUTH_STATE_INVALID") return "这次授权已过期、已用过，或不是从当前登录的账户发起的。请回到导入页重新点「用 Notion 授权」。";
  if (code === "NOTION_OAUTH_CODE_INVALID") return "Notion 没有接受这次授权（可能已过期）。请重新点「用 Notion 授权」。";
  if (code === "NOTION_OAUTH_MISCONFIGURED") return "Notion 拒绝了本站的集成配置。请先改用粘贴令牌，并告知站点管理员。";
  if (code === "NOTION_UNAVAILABLE") return "暂时连不上 Notion，请稍后再试。";
  if (status === 401) return "登录状态已失效，请重新登录后再授权。";
  if (status === 429) return "授权请求过于频繁，请过几分钟再试。";
  if (status === 0) return "网络中断，授权没有完成，可以直接重试。";
  return `授权没有完成（HTTP ${status}）。可以稍后重试，或改用粘贴令牌。`;
}

export const NOTION_OAUTH_DENIED_MESSAGE = "你在 Notion 取消了授权，没有拿到任何令牌。";

/** The parts of `BroadcastChannel` used here, so a test can stand in for it. */
export type ChannelLike = {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
};
export type ChannelFactory = (name: string) => ChannelLike;

export const browserChannel: ChannelFactory = (name) => new BroadcastChannel(name) as unknown as ChannelLike;

export type NotionOAuthWait = {
  /** Resolves with the first well-formed message on this authorization's channel, or `null` when cancelled or timed out. */
  result: Promise<NotionOAuthMessage | null>;
  cancel: () => void;
};

/**
 * Listen for the answer to one authorization. Only the first well-formed message
 * on the state's channel counts; the channel is closed as soon as there is an
 * answer, a cancel, or the ten minutes a state is valid have passed.
 */
export function waitForNotionOAuth(state: string, options: { channel?: ChannelFactory; timeoutMs?: number } = {}): NotionOAuthWait {
  const channel = (options.channel ?? browserChannel)(notionOAuthChannelName(state));
  let finish!: (value: NotionOAuthMessage | null) => void;
  let done = false;
  const result = new Promise<NotionOAuthMessage | null>((resolve) => { finish = resolve; });
  const end = (value: NotionOAuthMessage | null) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    channel.onmessage = null;
    channel.close();
    finish(value);
  };
  const timer = setTimeout(() => end(null), options.timeoutMs ?? NOTION_OAUTH_WAIT_MS);
  channel.onmessage = (event) => {
    const message = readNotionOAuthMessage(event.data);
    if (message !== null) end(message);
  };
  return { result, cancel: () => end(null) };
}

/** Send the callback's outcome to the desk that started `state`, then close the channel. */
export function announceNotionOAuth(state: string, message: NotionOAuthMessage, channel: ChannelFactory = browserChannel): void {
  const sender = channel(notionOAuthChannelName(state));
  try {
    sender.postMessage(message);
  } finally {
    sender.close();
  }
}

export type JsonPost = (url: string, body: unknown) => Promise<{ status: number; payload: unknown }>;

/** Same-origin JSON POST with the session cookie; status 0 when the network failed. */
export const browserJsonPost: JsonPost = async (url, body) => {
  try {
    const response = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, payload: await response.json().catch(() => null) };
  } catch {
    return { status: 0, payload: null };
  }
};

/** Ask our API for an authorize URL; the state comes back with it. */
export async function startNotionOAuth(post: JsonPost = browserJsonPost): Promise<{ ok: true; authorizeUrl: string; state: string } | { ok: false; message: string }> {
  const { status, payload } = await post(NOTION_OAUTH_START_ENDPOINT, {});
  const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
  if (status === 200 && data && typeof data.authorizeUrl === "string" && typeof data.state === "string" && /^https:\/\/api\.notion\.com\/v1\/oauth\/authorize\?/.test(data.authorizeUrl)) {
    return { ok: true, authorizeUrl: data.authorizeUrl, state: data.state };
  }
  return { ok: false, message: notionOAuthFailureMessage(status, payload) };
}

/** Redeem the callback's code; the answer is the message the desk will receive. */
export async function exchangeNotionOAuthCode(code: string, state: string, post: JsonPost = browserJsonPost): Promise<NotionOAuthMessage> {
  const { status, payload } = await post(NOTION_OAUTH_EXCHANGE_ENDPOINT, { code, state });
  const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
  if (status === 200 && data && typeof data.accessToken === "string" && data.accessToken.length > 0) {
    return { kind: "notion-oauth", ok: true, token: data.accessToken, workspaceName: typeof data.workspaceName === "string" ? data.workspaceName : null };
  }
  return { kind: "notion-oauth", ok: false, message: notionOAuthFailureMessage(status, payload) };
}
