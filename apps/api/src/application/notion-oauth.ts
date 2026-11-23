/**
 * One-shot Notion OAuth for the desk (ADR 0053): the authorization code is
 * exchanged here, the access token is handed to the page that asked, and nothing
 * is kept.
 *
 * OAuth has to touch the server because the code is exchanged with the
 * integration's client secret, which a browser must never see. Everything else
 * follows ADR 0052: the token passes through one response and is then the
 * author's to paste, exactly like a personal access token.
 *
 * - **No OAuth state is stored.** `state` is an HMAC over the author's id, an
 *   expiry and 32 random bytes, keyed by a value derived from the client secret.
 *   The exchange recomputes it for the session that presents it, so a code
 *   obtained by someone else (or for another account) is refused, and a `state`
 *   older than ten minutes is refused. A cookie would bind it to the browser as
 *   well, but the session already does that, and a `__Host-` cookie cannot be
 *   limited to the callback path anyway. Replay inside the ten minutes is refused
 *   by an in-process set of used states; across processes Notion's own rule that
 *   a code is redeemed once is what holds.
 * - **Only the access token leaves.** Notion answers the exchange with a refresh
 *   token, a bot id, the owner and the workspace; only `access_token` and the
 *   workspace name are returned, and the refresh token is dropped unread.
 * - **Nothing secret is repeated.** No error, log line or response built here
 *   contains the code, the state, the client secret, the token or Notion's error
 *   text. Every failure is a fixed code from this module.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { NOTION_API_ORIGIN, NOTION_API_VERSION, type NotionFetch } from "../infrastructure/notion-source.ts";
import { isNotionToken } from "./notion-fetch.ts";

/** The callback route the redirect URI must name: the desk's page, nothing else. */
export const NOTION_OAUTH_CALLBACK_PATH = "/write/notion/oauth/callback";

export const NOTION_OAUTH_LIMITS = Object.freeze({
  /** How long a started authorization may take, in seconds. */
  stateTtlSeconds: 600,
  /** Used states remembered at once; far above what the rate limit lets through. */
  maxRememberedStates: 20_000,
  /** The longest code accepted. Notion's codes are UUID-sized. */
  maxCodeLength: 512,
  /** The token endpoint answers a small object. */
  maxResponseBytes: 64 * 1024,
});

export type NotionOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * The integration's settings, or `null` when the feature is off. All three
 * variables are required, the redirect URI must be an absolute `https` URL (plain
 * `http` only on loopback, for local development) whose path is exactly the
 * callback route, with no query or fragment: Notion matches it exactly, and a
 * redirect elsewhere would hand the code to a page that does not clear it.
 * Pulling must be on too (`NOTION_FETCH_ENABLED`): a token with nowhere to go
 * is not worth asking an author for.
 */
export function readNotionOAuthConfig(env: NodeJS.ProcessEnv): NotionOAuthConfig | null {
  if (env.NOTION_FETCH_ENABLED?.trim().toLowerCase() === "false") return null;
  const clientId = env.NOTION_OAUTH_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.NOTION_OAUTH_CLIENT_SECRET?.trim() ?? "";
  const redirectUri = env.NOTION_OAUTH_REDIRECT_URI?.trim() ?? "";
  if (clientId === "" || clientSecret === "" || redirectUri === "") return null;
  if (clientId.length > 200 || /[^\x21-\x7E]/.test(clientId)) return null;
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return null;
  }
  const secure = url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname));
  if (!secure || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null;
  if (url.pathname !== NOTION_OAUTH_CALLBACK_PATH) return null;
  return { clientId, clientSecret, redirectUri: url.toString() };
}

export type NotionOAuthErrorCode = "NOTION_OAUTH_STATE_INVALID" | "NOTION_OAUTH_CODE_INVALID" | "NOTION_OAUTH_MISCONFIGURED" | "NOTION_UNAVAILABLE";

const ERRORS: Readonly<Record<NotionOAuthErrorCode, { status: number; message: string }>> = Object.freeze({
  NOTION_OAUTH_STATE_INVALID: { status: 422, message: "This authorization has expired, was already used, or was started by another session. Start it again from the import page." },
  NOTION_OAUTH_CODE_INVALID: { status: 422, message: "Notion did not accept this authorization code; it may have expired or been used. Start the authorization again." },
  NOTION_OAUTH_MISCONFIGURED: { status: 502, message: "Notion refused this site's integration settings. Paste a token instead, and tell the site operator." },
  NOTION_UNAVAILABLE: { status: 502, message: "The Notion API could not be read. Try again later." },
});

/** A failed exchange; carries a stable code and nothing from the request or Notion. */
export class NotionOAuthError extends Error {
  readonly code: NotionOAuthErrorCode;
  readonly status: number;
  constructor(code: NotionOAuthErrorCode) {
    super(ERRORS[code].message);
    this.name = "NotionOAuthError";
    this.code = code;
    this.status = ERRORS[code].status;
  }
}

/** The request is not one the exchange accepts; the message names the field, never its value. */
export class NotionOAuthRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotionOAuthRequestError";
  }
}

function stateKey(config: NotionOAuthConfig): Buffer {
  return createHmac("sha256", config.clientSecret).update("no-wave/notion-oauth-state/v1").digest();
}

function stateMac(config: NotionOAuthConfig, actorId: string, expires: number, nonce: string): string {
  return createHmac("sha256", stateKey(config)).update(`${actorId}\n${expires}\n${nonce}`).digest("base64url");
}

const STATE_PATTERN = /^v1\.(\d{1,12})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/;

/** Used states and when they expire, so a replay inside the window is refused. */
export type UsedStates = Map<string, number>;

export function createUsedStates(): UsedStates {
  return new Map();
}

/**
 * Start an authorization for `actorId`: a fresh `state` and the Notion URL that
 * carries it. Nothing is written anywhere.
 */
export function startNotionOAuth(config: NotionOAuthConfig, actorId: string, nowMs: number = Date.now()): { authorizeUrl: string; state: string; expiresInSeconds: number } {
  const expires = Math.floor(nowMs / 1000) + NOTION_OAUTH_LIMITS.stateTtlSeconds;
  const nonce = randomBytes(32).toString("base64url");
  const state = `v1.${expires}.${nonce}.${stateMac(config, actorId, expires, nonce)}`;
  const url = new URL(`${NOTION_API_ORIGIN}/v1/oauth/authorize`);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("owner", "user");
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  return { authorizeUrl: url.toString(), state, expiresInSeconds: NOTION_OAUTH_LIMITS.stateTtlSeconds };
}

/** Validate the exchange body. Messages name a field and never its value. */
export function readNotionOAuthExchange(body: Record<string, unknown>): { code: string; state: string } {
  const { code, state } = body;
  if (typeof code !== "string" || code.length === 0 || code.length > NOTION_OAUTH_LIMITS.maxCodeLength || !/^[A-Za-z0-9._~+/=-]+$/.test(code)) {
    throw new NotionOAuthRequestError("`code` must be the authorization code Notion returned.");
  }
  if (typeof state !== "string" || state.length > 200) throw new NotionOAuthRequestError("`state` must be the state the authorization started with.");
  return { code, state };
}

/**
 * Check that `state` was issued to `actorId` by this integration, has not expired
 * and has not been used, and mark it used. Any failure is the same answer, so a
 * caller cannot tell an expired state from somebody else's.
 */
export function consumeNotionOAuthState(config: NotionOAuthConfig, actorId: string, state: string, used: UsedStates, nowMs: number = Date.now()): void {
  const now = Math.floor(nowMs / 1000);
  for (const [key, expires] of used) if (expires <= now) used.delete(key);
  const match = STATE_PATTERN.exec(state);
  if (!match) throw new NotionOAuthError("NOTION_OAUTH_STATE_INVALID");
  const expires = Number(match[1]);
  const nonce = match[2]!;
  if (!(expires > now && expires <= now + NOTION_OAUTH_LIMITS.stateTtlSeconds)) throw new NotionOAuthError("NOTION_OAUTH_STATE_INVALID");
  const expected = Buffer.from(stateMac(config, actorId, expires, nonce));
  const presented = Buffer.from(match[3]!);
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) throw new NotionOAuthError("NOTION_OAUTH_STATE_INVALID");
  if (used.has(nonce)) throw new NotionOAuthError("NOTION_OAUTH_STATE_INVALID");
  // A full set means far more authorizations than the rate limit admits; refusing
  // is safer than forgetting a state that could then be replayed.
  if (used.size >= NOTION_OAUTH_LIMITS.maxRememberedStates) throw new NotionOAuthError("NOTION_UNAVAILABLE");
  used.set(nonce, expires);
}

export type NotionOAuthGrant = { accessToken: string; workspaceName: string | null };

function cleanWorkspaceName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/[\u0000-\u001F\u007F]/g, "").trim();
  return name === "" ? null : name.slice(0, 200);
}

/**
 * Redeem `code` at Notion's token endpoint with HTTP Basic client credentials.
 * `redirect_uri` is sent because the authorize URL named it. Only the access
 * token and the workspace name are read from the answer.
 */
export async function exchangeNotionOAuthCode(config: NotionOAuthConfig, code: string, fetchImpl: NotionFetch): Promise<NotionOAuthGrant> {
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  let response;
  try {
    response = await fetchImpl(`${NOTION_API_ORIGIN}/v1/oauth/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/json",
        "notion-version": NOTION_API_VERSION,
      },
      body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: config.redirectUri }),
    });
  } catch {
    throw new NotionOAuthError("NOTION_UNAVAILABLE");
  }
  const parsed = await response.json().catch(() => null);
  if (!response.ok) {
    // RFC 6749 §5.2: `invalid_grant` is the code (expired, used, or for another
    // redirect URI); `invalid_client` / `unauthorized_client` are our settings.
    const error = typeof parsed === "object" && parsed !== null ? (parsed as { error?: unknown; code?: unknown }) : {};
    const reason = typeof error.error === "string" ? error.error : typeof error.code === "string" ? error.code : "";
    if (response.status === 401 || reason === "invalid_client" || reason === "unauthorized_client") throw new NotionOAuthError("NOTION_OAUTH_MISCONFIGURED");
    if (response.status === 400) throw new NotionOAuthError("NOTION_OAUTH_CODE_INVALID");
    throw new NotionOAuthError("NOTION_UNAVAILABLE");
  }
  const accessToken = typeof parsed === "object" && parsed !== null ? (parsed as { access_token?: unknown }).access_token : undefined;
  // A token the fetch endpoint would refuse is no use to the author.
  if (!isNotionToken(accessToken)) throw new NotionOAuthError("NOTION_UNAVAILABLE");
  return { accessToken, workspaceName: cleanWorkspaceName((parsed as { workspace_name?: unknown }).workspace_name) };
}
