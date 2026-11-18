import {
  apiUrl,
  applyClientAddressHeaders,
  resolveUpstreamTimeoutMs,
  type ApiProxyConfig,
} from "./api.ts";
import { accessTokenFrom, clearedTokenCookieHeaders, refreshTokenFrom, tokenCookieHeaders, type TokenSet } from "./cookies.ts";
import { NO_STORE, errorResponse } from "./http.ts";
import { setIdempotencyKeyHeader } from "./policy.ts";
import { parseRetryAfterSeconds } from "./retry-after.ts";
import { isRefreshFailure, refreshFailureResponse, resolveSessionRefresh } from "./session-refresh.ts";
import { upstreamTransportFor } from "./upstream.ts";
import { upstreamJsonText, type BufferedApiResponse } from "./upstream-response.ts";
import { UpstreamResponseError, upstreamFailureResponse } from "./upstream-errors.ts";
import { articleCollectionLimits } from "./article-collection-policy.ts";

/**
 * Authenticated API forwarder for the browser-facing authoring/session/media
 * and inbox routes.
 *
 * The access token lives in an `HttpOnly` cookie, so this function — not the
 * browser — attaches the `Authorization` header, performs one refresh-and-retry
 * when the API answers 401, and clears the cookies when the refresh token is
 * rejected. Tokens are never returned to the browser.
 */
type JobConditionals = { etag?: string; prefer?: string };
const JOB_STATUS_PATH = /^api\/v1\/imports\/notion\/jobs\/[0-9a-f-]{36}$/i;
const JOB_ETAG = /^"[A-Za-z0-9_-]{43}"$/;

export type ForwardMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * One upstream reply, fully read.
 *
 * The body is buffered inside the same deadline as the connection: a proxy that
 * forwards JSON has to finish with it, and an upstream that sends headers and
 * then stops mid-body would otherwise hold the caller exactly like a hung
 * connection. The proxied surface is JSON of bounded size, so buffering does not
 * change what this forwarder can carry.
 */
type BufferedUpstream = {
  status: number;
  contentType: string | null;
  text: string;
  /**
   * The raw upstream `Retry-After`, kept so a throttled caller can be told when
   * to come back (#244).
   *
   * It is relayed through `parseRetryAfterSeconds`, exactly like the auth
   * proxy's error path: the browser sees normalized integer seconds and nothing
   * else, so this cannot become a channel for arbitrary upstream headers.
   */
  retryAfter: string | null;
  stream?: ReadableStream<Uint8Array> | null;
  etag?: string | null;
  location?: string | null;
};

/** The `data` field of a `{ data: ... }` envelope, or `null` when unusable. */
function dataFromText(text: string): unknown {
  try {
    const payload: unknown = JSON.parse(text);
    return typeof payload === "object" && payload !== null && "data" in payload
      ? (payload as { data?: unknown }).data
      : null;
  } catch {
    return null;
  }
}

/** Preserve a resource 401 even when an optional diagnostic body is unusable. */
function unauthorizedText(response: BufferedApiResponse): string {
  try {
    const text = upstreamJsonText(response);
    JSON.parse(text);
    return text;
  } catch {
    return JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "Authentication is required." } });
  }
}

async function callApi(
  config: ApiProxyConfig,
  base: string,
  path: string,
  method: ForwardMethod,
  body: BodyInit | undefined,
  token: string | undefined,
  contentType: string,
  idempotencyKey: string | null,
  timeoutMs: number,
  callerSignal: AbortSignal,
  conditional?: JobConditionals,
): Promise<BufferedUpstream> {
  const headers = new Headers({ accept: "application/json" });
  if (method === "GET" && JOB_STATUS_PATH.test(path)) {
    if (conditional?.etag && JOB_ETAG.test(conditional.etag)) headers.set("if-none-match", conditional.etag);
    if (conditional?.prefer && /^wait=[0-5]$/.test(conditional.prefer)) headers.set("prefer", conditional.prefer);
  }
  if (body !== undefined) headers.set("content-type", contentType);
  if (token) headers.set("authorization", `Bearer ${token}`);
  setIdempotencyKeyHeader(headers, idempotencyKey);
  const target = apiUrl(base, path);
  applyClientAddressHeaders(headers, target, method, config.clientAddressHeaders);
  const collection = articleCollectionLimits(path, method);
  if (collection || path.split("?")[0] === "api/v1/imports/notion/export") {
    const transport = upstreamTransportFor(config);
    const response = collection
      ? await transport.openCollection(target, { method, headers, ...(body === undefined ? {} : { body }) }, { ...collection, timeoutMs, signal: callerSignal, preflight: true })
      : await transport.openStream(target, { method, headers }, { kind: "export", timeoutMs, signal: callerSignal });
    const common = { status: response.status, contentType: response.headers.get("content-type"), retryAfter: response.headers.get("retry-after") };
    if (response.ok) return { ...common, text: "", stream: response.body };
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (response.status >= 500) return { ...common, contentType: "application/json; charset=utf-8",
      text: JSON.stringify({ error: { code: "SERVICE_UNAVAILABLE", message: "The API service is temporarily unavailable." } }) };
    const bufferedError = { status: response.status, statusText: response.statusText, headers: response.headers, bytes };
    if (response.status === 401) return { ...common, contentType: "application/json; charset=utf-8", text: unauthorizedText(bufferedError) };
    const text = upstreamJsonText(bufferedError);
    try { JSON.parse(text); } catch { throw new UpstreamResponseError("invalid-json"); }
    return { ...common, text };
  }
  const buffered = await upstreamTransportFor(config).request(target, {
    method, headers, ...(body === undefined ? {} : { body }),
  }, { timeoutMs, signal: callerSignal, responseType: "json",
    kind: path.split("?")[0] === "api/v1/me" ? "auth" : "api" });
  const internalFailure = buffered.status >= 500;
  return {
    status: buffered.status,
    contentType: internalFailure || buffered.status === 401 ? "application/json; charset=utf-8" : buffered.headers.get("content-type"),
    text: internalFailure
      ? JSON.stringify({ error: { code: "SERVICE_UNAVAILABLE", message: "The API service is temporarily unavailable." } })
      : buffered.status === 401 ? unauthorizedText(buffered) : upstreamJsonText(buffered),
    retryAfter: buffered.headers.get("retry-after"),
    etag: method === "GET" && JOB_STATUS_PATH.test(path) ? buffered.headers.get("etag") : null,
    location: method === "POST" && path === "api/v1/imports/notion/jobs" ? buffered.headers.get("location") : null,
  };
}

export async function forwardAuthoringRequest(
  request: Request,
  path: string,
  method: ForwardMethod,
  config: ApiProxyConfig = {},
  body?: BodyInit,
  contentType = "application/json; charset=utf-8",
  expectedActorId?: string,
  verifyViewerIfPresent = false,
  conditional?: JobConditionals,
): Promise<Response> {
  const base = config.apiBaseUrl;
  if (!base) {
    return errorResponse("SERVICE_UNAVAILABLE", "The API service is not configured.", 503);
  }
  const apiBase = base;
  let timeoutMs: number;
  try {
    timeoutMs = resolveUpstreamTimeoutMs(config.upstreamTimeoutMs);
  } catch {
    // A malformed budget is a deployment error. Answer like a missing origin
    // instead of letting a typo become an unbounded wait.
    return errorResponse("SERVICE_UNAVAILABLE", "The API service is not configured correctly.", 503);
  }

  const refreshToken = refreshTokenFrom(request);
  let accessToken = accessTokenFrom(request);
  let rotated: TokenSet | null | undefined = null;
  let clearCookies = false;
  /** A complete answer that is not the resource reply (identity check, failure). */
  let reply: Response | undefined;
  let upstream: BufferedUpstream | undefined;

  // An optional restrictive precondition, never an identity supplied by the
  // client: compare the API's verified /me to the editor's expected actor using
  // the *same token* as the following write. Recheck after a refresh. Checking
  // in the browser instead would race a cross-tab cookie/account change.
  //
  // A viewer-specific field on an otherwise public read needs the same check:
  // the upstream treats expired/missing bearer tokens as anonymous and returns
  // 200, which would bypass the usual 401-triggered refresh. With any session
  // credential present, verify /me first; a genuinely anonymous read skips it.
  const verifyViewer = verifyViewerIfPresent && Boolean(accessToken || refreshToken);
  async function guardedCall(token: string | undefined): Promise<BufferedUpstream | Response> {
    if (expectedActorId !== undefined || verifyViewer) {
      const identity = await callApi(config, apiBase, "api/v1/me", "GET", undefined, token, contentType, null, timeoutMs, request.signal);
      if (identity.status < 200 || identity.status > 299) {
        return new Response(identity.text, {
          status: identity.status,
          headers: new Headers({
            "cache-control": NO_STORE,
            "content-type": identity.contentType ?? "application/json; charset=utf-8",
          }),
        });
      }
      const data = dataFromText(identity.text);
      const id = typeof data === "object" && data !== null && "id" in data
        ? (data as { id?: unknown }).id : null;
      if (typeof id !== "string" || id.length === 0) {
        return errorResponse("SERVICE_UNAVAILABLE", "The current account could not be verified.", 502);
      }
      if (expectedActorId !== undefined && id !== expectedActorId) {
        return errorResponse("ACCOUNT_CHANGED", "The signed-in account changed. Sign in to the original account.", 409);
      }
    }
    return callApi(
      config,
      apiBase,
      path,
      method,
      body,
      token,
      contentType,
      request.headers.get("idempotency-key"),
      timeoutMs,
      request.signal,
      conditional,
    );
  }

  try {
    const first = await guardedCall(accessToken);
    // Either shape can be a 401: the resource itself, or the preceding /me
    // precondition (which is answered by the identity service and can expire
    // first). Both mean "this credential is stale, try one rotation".
    if (first.status !== 401 || !refreshToken) {
      if (first instanceof Response) reply = first;
      else upstream = first;
    } else {
      // Retry exactly once: a refresh loop would hammer the identity service and
      // could replay a mutation more than once. Every request carrying this same
      // refresh credential joins one rotation instead of consuming the token
      // again — a second presentation would revoke the whole session family.
      const refreshAttempt = await resolveSessionRefresh(refreshToken, config, timeoutMs, request.signal);
      if (refreshAttempt && !isRefreshFailure(refreshAttempt)) {
        rotated = refreshAttempt;
        accessToken = refreshAttempt.accessToken;
        const retried = await guardedCall(accessToken);
        if (retried instanceof Response) reply = retried;
        else upstream = retried;
      } else if (isRefreshFailure(refreshAttempt) && (refreshAttempt.status === 429 || refreshAttempt.status === 499)) {
        reply = refreshFailureResponse(refreshAttempt);
      } else {
        if (refreshAttempt === null || (isRefreshFailure(refreshAttempt) && (refreshAttempt.status === 400 || refreshAttempt.status === 401))) {
          // A rejected refresh token means the session is over: clear it instead of
          // leaving the browser to retry with a credential the API already refused.
          clearCookies = true;
        }
        // Pass the original 401 through: it failed for a reason this proxy cannot
        // improve on, and the refresh proved nothing about the session.
        if (first instanceof Response) reply = first;
        else upstream = first;
      }
    }
  } catch (error) {
    reply = upstreamFailureResponse(error);
  }

  let response: Response;
  if (reply) {
    response = reply;
  } else if (upstream) {
    const headers = new Headers({
      "cache-control": NO_STORE,
      "content-type": upstream.contentType ?? "application/json; charset=utf-8",
    });
    // A 429 from the API carries how long the caller should wait; dropping it
    // left the browser with no way to back off except guessing (#244).
    const retryAfterSeconds = parseRetryAfterSeconds(upstream.retryAfter);
    if (retryAfterSeconds !== null) headers.set("retry-after", String(retryAfterSeconds));
    if (upstream.etag && JOB_ETAG.test(upstream.etag)) headers.set("etag", upstream.etag);
    const jobLocation = /^\/api\/v1\/imports\/notion\/jobs\/([0-9a-f-]{36})$/i.exec(upstream.location ?? "");
    if (jobLocation && upstream.status === 202) headers.set("location", `/api/authoring/notion-jobs/${jobLocation[1]}`);
    response = new Response([204, 205, 304].includes(upstream.status) ? null : upstream.stream ?? upstream.text, { status: upstream.status, headers });
  } else {
    response = errorResponse("SERVICE_UNAVAILABLE", "The API service could not be reached.", 502);
  }

  if (rotated) {
    for (const cookie of tokenCookieHeaders(request, rotated)) response.headers.append("set-cookie", cookie);
  } else if (clearCookies) {
    for (const cookie of clearedTokenCookieHeaders(request)) response.headers.append("set-cookie", cookie);
  }
  return response;
}

/**
 * Read a public resource whose response contains viewer-specific state. When a
 * session cookie is present, verify it before fetching the public resource so
 * an expired access cookie cannot be mistaken for a signed-out reader. Both the
 * verification and read use the same access token, including after refresh.
 */
export function forwardViewerRead(request: Request, path: string, config: ApiProxyConfig = {}): Promise<Response> {
  return forwardAuthoringRequest(request, path, "GET", config, undefined, undefined, undefined, true);
}
