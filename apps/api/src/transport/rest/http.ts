import type { IncomingMessage, ServerResponse } from "node:http";
import { writeStructuredLog } from "../../infrastructure/http-observability.ts";
import { DomainError, RateLimitError } from "../../domain/errors.ts";
import { createAuthContext } from "../../security/authentication.ts";
import type { ApplicationServices } from "../../application/services.ts";

export const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

export const SUPPORTED_LOCALES = new Set(["zh-CN", "zh-TW", "en"]);

export const NO_ROUTE_PARAMS: Readonly<Record<string, string>> = Object.freeze({});

export const MAX_QUERY_LENGTH = 200;

export const MAX_ARTICLE_OFFSET = 100_000;

export const MAX_TAXONOMY_OFFSET = 1_000_000;

export const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;

export const MAX_IMAGE_UPLOAD_BYTES = 8 * 1024 * 1024;

/**
 * The REST transport consumes the application facade, not an open-ended record of
 * functions: `ApplicationServices` is derived from the persistence port table, so
 * a mistyped method name fails `tsc` instead of failing on the one branch a test
 * happens to miss (issue #66).
 */

/**
 * The REST transport consumes the application facade, not an open-ended record of
 * functions: `ApplicationServices` is derived from the persistence port table, so
 * a mistyped method name fails `tsc` instead of failing on the one branch a test
 * happens to miss (issue #66).
 */
export type RestServices = ApplicationServices;

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, JSON_HEADERS);
  response.end(JSON.stringify(body));
}

export function sendBadInput(response: ServerResponse, message = "Invalid query parameters."): void {
  sendJson(response, 400, { error: { code: "BAD_USER_INPUT", message } });
}

export function parseInteger(params: URLSearchParams, name: string, fallback: number, min: number, max: number): number | null {
  const raw = params.get(name);
  if (raw === null) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

export function hasDuplicateQueryParameters(params: URLSearchParams): boolean {
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

export function parseLocale(url: URL): string | null {
  const locale = url.searchParams.get("locale") ?? "zh-CN";
  return SUPPORTED_LOCALES.has(locale) ? locale : null;
}

/**
 * Article discovery order: `latest` (publication date, the historical default)
 * or `popular` (how many times the work was ever saved, most first).
 */
export function parseSort(url: URL): "latest" | "popular" | null {
  const sort = url.searchParams.get("sort") ?? "latest";
  return sort === "latest" || sort === "popular" ? sort : null;
}

export function parseQuery(url: URL): string | null {
  const query = url.searchParams.get("query") ?? "";
  return query.length <= MAX_QUERY_LENGTH ? query : null;
}

export function parsePagination(url: URL, defaultLimit: number, maxOffset: number): { limit: number; offset: number } | null {
  const limit = parseInteger(url.searchParams, "limit", defaultLimit, 1, 100);
  const offset = parseInteger(url.searchParams, "offset", 0, 0, maxOffset);
  return limit === null || offset === null ? null : { limit, offset };
}

/**
 * Where a page of article discovery starts.
 *
 * Two answers, and they are not allowed at the same time: an offset counts rows
 * from the top, a cursor names the last work the reader already saw. Taking both
 * would mean silently deciding which one wins, so the request is a `400` instead.
 *
 * A cursor is passed through without being decoded: what it means is the store's
 * business, and this layer's only job is to keep it bounded and untrimmed on its
 * way there.
 */
export type ArticlePagination =
  | { kind: "offset"; limit: number; offset: number }
  | { kind: "cursor"; limit: number; cursor: string };

export function parseArticlePagination(url: URL, defaultLimit: number, maxOffset: number): ArticlePagination | null {
  const limit = parseInteger(url.searchParams, "limit", defaultLimit, 1, 100);
  if (limit === null) return null;
  const rawCursor = url.searchParams.get("cursor");
  const rawOffset = url.searchParams.get("offset");
  if (rawCursor !== null) {
    if (rawOffset !== null) return null;
    if (rawCursor.length === 0 || rawCursor.length > 512 || rawCursor !== rawCursor.trim()) return null;
    return { kind: "cursor", limit, cursor: rawCursor };
  }
  const offset = parseInteger(url.searchParams, "offset", 0, 0, maxOffset);
  return offset === null ? null : { kind: "offset", limit, offset };
}

export function decodeSlug(encodedSlug: string): string | null {
  let slug: string;
  try {
    slug = decodeURIComponent(encodedSlug);
  } catch {
    return null;
  }
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ? slug : null;
}

/**
 * Decode an opaque identifier from a path segment.
 *
 * Deliberately **not** a UUID check: this API's identifiers are opaque strings,
 * and a shape check here would reject an identifier that a future issuer is
 * entitled to mint. What is checked is what makes the value safe to hand to a
 * parameterised query and to a log line — decodable, non-empty, bounded and
 * free of surrounding whitespace. Anything the value names is resolved by the
 * store, which answers "not found" for an identifier that exists in no row.
 */
export function decodeUserId(encodedUserId: string): string | null {
  let userId: string;
  try {
    userId = decodeURIComponent(encodedUserId);
  } catch {
    return null;
  }
  if (userId.length === 0 || userId.length > 300 || userId.trim() !== userId) return null;
  return userId;
}

export type RestErrorResponse = { status: number; code: string; message: string };

export const DOMAIN_ERROR_RESPONSES: Record<string, RestErrorResponse> = {
  BAD_USER_INPUT: { status: 400, code: "BAD_USER_INPUT", message: "The request input is invalid." },
  FORBIDDEN: { status: 403, code: "FORBIDDEN", message: "You are not allowed to access this resource." },
  UNAUTHENTICATED: { status: 401, code: "UNAUTHENTICATED", message: "The credentials are invalid." },
  RATE_LIMITED: { status: 429, code: "RATE_LIMITED", message: "Too many requests. Try again later." },
  SERVICE_UNAVAILABLE: { status: 503, code: "SERVICE_UNAVAILABLE", message: "Identity is not configured." },
  // 409, deliberately not 503: a switched-off feature is not an outage, and
  // "try again later" is the wrong advice when nothing changes until an
  // operator flips a switch. Being a 4xx also means the Web proxy passes the
  // code and message through instead of replacing a 5xx body wholesale.
  MAIL_DISABLED: { status: 409, code: "MAIL_DISABLED", message: "Account mail is not enabled on this instance." },
  MEDIA_DELETE_DISABLED: { status: 409, code: "MEDIA_DELETE_DISABLED", message: "Deleting images is not enabled on this instance." },
  NOT_FOUND: { status: 404, code: "NOT_FOUND", message: "The requested resource was not found." },
  CONFLICT: { status: 409, code: "CONFLICT", message: "The request conflicts with the current resource state." },
  // Same status as `CONFLICT`, different answer to "what do I do next": the
  // address belongs to an account already, so the visitor signs in or picks
  // another one. Kept as its own code so a client can translate it.
  EMAIL_TAKEN: { status: 409, code: "EMAIL_TAKEN", message: "The email address is already registered." },
  IDEMPOTENCY_CONFLICT: {
    status: 409,
    code: "IDEMPOTENCY_CONFLICT",
    message: "The idempotency key was already used for a different request.",
  },
};

/**
 * Reduce a thrown value to something safe to write to a server log: the error
 * class and message, never the stack and never the response body. A driver
 * error can carry connection strings or row values, so the message is capped.
 */
function describeUnhandledError(error: unknown): { errorName: string; errorMessage: string } {
  if (!(error instanceof Error)) return { errorName: "NonErrorThrow", errorMessage: String(error).slice(0, 200) };
  const name = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : "Error";
  return { errorName: name, errorMessage: error.message.slice(0, 200) };
}

export function sendServiceError(response: ServerResponse, error: unknown): void {
  const mapped = error instanceof DomainError ? DOMAIN_ERROR_RESPONSES[error.code] : undefined;
  if (mapped) {
    if (error instanceof RateLimitError) response.setHeader("retry-after", String(error.retryAfterSeconds));
    sendJson(response, mapped.status, { error: { code: mapped.code, message: mapped.message } });
    return;
  }

  // Anything that is not a mapped domain error becomes an opaque 500, which
  // used to mean "the access log says 500 and nothing else". Log the cause
  // server-side so an operator can tell a stale schema (`relation
  // "featured_articles" does not exist`) from a genuine bug without attaching a
  // debugger. The client still gets no detail.
  const { errorName, errorMessage } = describeUnhandledError(error);
  const requestIdHeader = response.getHeader("x-request-id");
  const requestId = Array.isArray(requestIdHeader) ? requestIdHeader[0] : requestIdHeader;
  writeStructuredLog({
    level: "error",
    event: "rest_unhandled_error",
    requestId: typeof requestId === "string" ? requestId : null,
    errorName,
    errorMessage,
  });

  // Do not expose raw exception messages, stack traces, or database details.
  sendJson(response, 500, {
    error: { code: "INTERNAL_SERVER_ERROR", message: "The request could not be completed." },
  });
}

export function sendUnavailable(response: ServerResponse): void {
  sendJson(response, 503, { error: { code: "SERVICE_UNAVAILABLE", message: "Persistence is not configured." } });
}

export type JsonObjectResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; status: number; code: string; message: string; closeConnection?: boolean };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readJsonObject(request: IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<JsonObjectResult> {
  const contentType = request.headers["content-type"];
  const declaredLength = request.headers["content-length"];
  const hasUnconsumedBody =
    request.headers["transfer-encoding"] !== undefined ||
    (typeof declaredLength === "string" && /^\d+$/.test(declaredLength) && BigInt(declaredLength) > 0n);
  if (typeof contentType !== "string" || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return {
      ok: false,
      status: 415,
      code: "UNSUPPORTED_MEDIA_TYPE",
      message: "Content-Type must be application/json.",
      ...(hasUnconsumedBody ? { closeConnection: true } : {}),
    };
  }

  // Reject a known oversized body before reading any of its bytes.
  if (typeof declaredLength === "string" && /^\d+$/.test(declaredLength) &&
      BigInt(declaredLength) > BigInt(maxBytes)) {
    return {
      ok: false,
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
      message: "The JSON request body is too large.",
      closeConnection: true,
    };
  }

  // Count streaming bytes and stop as soon as the limit is crossed. Do not
  // drain an unbounded/chunked request just to report 413; the caller closes
  // the connection after writing the response.
  return new Promise<JsonObjectResult>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const ignoreStreamError = () => {};

    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };

    const finish = (result: JsonObjectResult, closeConnection = false) => {
      if (settled) return;
      settled = true;
      if (closeConnection) {
        request.pause();
        request.off("data", onData);
        request.off("end", onEnd);
        request.off("aborted", onAborted);
        request.off("error", onError);
        // A peer may reset the socket while the 413 response is flushing.
        request.on("error", ignoreStreamError);
        request.once("close", () => request.off("error", ignoreStreamError));
      } else {
        cleanup();
      }
      resolve(result);
    };

    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > maxBytes) {
        finish({
          ok: false,
          status: 413,
          code: "PAYLOAD_TOO_LARGE",
          message: "The JSON request body is too large.",
          closeConnection: true,
        }, true);
        return;
      }
      chunks.push(buffer);
    };

    const onEnd = () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      } catch {
        finish({ ok: false, status: 400, code: "BAD_USER_INPUT", message: "The request body must be valid JSON." });
        return;
      }
      if (!isRecord(parsed)) {
        finish({ ok: false, status: 400, code: "BAD_USER_INPUT", message: "The request body must be a JSON object." });
        return;
      }
      finish({ ok: true, value: parsed });
    };

    const onError = () => {
      finish({
        ok: false,
        status: 400,
        code: "BAD_USER_INPUT",
        message: "The request body could not be read.",
      }, true);
    };

    const onAborted = () => {
      finish({
        ok: false,
        status: 400,
        code: "BAD_USER_INPUT",
        message: "The request body was interrupted.",
      }, true);
    };

    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
  });
}

export async function authenticatedUser(
  request: IncomingMessage,
  services: RestServices,
  env: NodeJS.ProcessEnv,
): Promise<{ id: string; sessionId: string | null; accessTokenId: string; sessionExpiresAt: number } | null> {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") return null;
  const authRequest = new Request("http://localhost/", { headers: { authorization } });
  const { user } = createAuthContext(authRequest, env);
  if (!user || typeof services.isSessionRevoked !== "function") return null;
  try {
    // Revocation is recorded against the access-token id, not the session: one
    // row per token, so signing out ends the token that was presented.
    if (await services.isSessionRevoked(user.accessTokenId)) return null;
  } catch {
    // Session status cannot be established. Fail closed rather than accepting the JWT.
    return null;
  }
  return user;
}

export async function authenticatedActorId(
  request: IncomingMessage,
  services: RestServices,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  return (await authenticatedUser(request, services, env))?.id ?? null;
}

export async function optionalViewerId(
  request: IncomingMessage,
  services: RestServices,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  if (typeof request.headers.authorization !== "string") return null;
  try {
    return (await authenticatedUser(request, services, env))?.id ?? null;
  } catch {
    // Public reads stay public; malformed credentials never gain viewer privileges.
    return null;
  }
}

export function sendUnauthenticated(response: ServerResponse): void {
  sendJson(response, 401, { error: { code: "UNAUTHENTICATED", message: "Authentication is required." } });
}

export type RawImageBodyResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; status: number; code: string; message: string; closeConnection?: boolean };

export function readRawImageBody(request: IncomingMessage, maxBytes = MAX_IMAGE_UPLOAD_BYTES): Promise<RawImageBodyResult> {
  const contentType = request.headers["content-type"];
  const declaredLength = request.headers["content-length"];
  // These two checks are the same tests `readJsonObject` performs above. They
  // were once written as `/^\\d+$/`, which matches a literal backslash followed
  // by letters, not a run of digits — so neither branch ever fired: an oversized
  // upload was buffered instead of refused, and a 415 answered a request whose
  // body was never read without closing the connection.
  const hasUnconsumedBody = request.headers["transfer-encoding"] !== undefined ||
    (typeof declaredLength === "string" && /^\d+$/.test(declaredLength) && BigInt(declaredLength) > 0n);
  if (typeof contentType !== "string" || !["image/jpeg", "image/png", "image/webp"].includes(contentType.toLowerCase())) {
    return Promise.resolve({ ok: false, status: 415, code: "UNSUPPORTED_MEDIA_TYPE", message: "Content-Type must be image/jpeg, image/png or image/webp.", ...(hasUnconsumedBody ? { closeConnection: true } : {}) });
  }
  if (typeof declaredLength === "string" && /^\d+$/.test(declaredLength) && BigInt(declaredLength) > BigInt(maxBytes)) {
    return Promise.resolve({ ok: false, status: 413, code: "PAYLOAD_TOO_LARGE", message: "The image request body exceeds 8 MiB.", closeConnection: true });
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };
    const finish = (result: RawImageBodyResult, closeConnection = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (closeConnection) {
        request.pause();
        request.on("error", () => {});
      }
      resolve(result);
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > maxBytes) {
        finish({ ok: false, status: 413, code: "PAYLOAD_TOO_LARGE", message: "The image request body exceeds 8 MiB.", closeConnection: true }, true);
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => finish({ ok: true, bytes: Buffer.concat(chunks, size) });
    const onError = () => finish({ ok: false, status: 400, code: "BAD_USER_INPUT", message: "The image request body could not be read.", closeConnection: true }, true);
    const onAborted = () => finish({ ok: false, status: 400, code: "BAD_USER_INPUT", message: "The image request body was interrupted.", closeConnection: true }, true);
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
  });
}

export function sendRawImageBodyError(response: ServerResponse, result: Exclude<RawImageBodyResult, { ok: true }>): void {
  if (result.closeConnection) {
    response.shouldKeepAlive = false;
    response.setHeader("connection", "close");
  }
  sendJson(response, result.status, { error: { code: result.code, message: result.message } });
}

export type MediaAssetsPort = {
  upload(input: { ownerId: string; bytes: Buffer; contentType: string }): Promise<{ id: string; src: string; contentType: string; byteSize: number; width: number; height: number }>;
  getPublic(input: { id: string }): Promise<{ id: string; bytes: Buffer; byteSize: number; width: number; height: number; sha256: string; contentType: "image/webp" }>;
  listLibrary(input: { ownerId: string; cursor?: string | null; limit?: number }): Promise<import("../../application/media-assets.ts").MediaLibraryPage>;
  /**
   * Delete an unused asset. `orphanedStorageKey` is set when the row went but the
   * object could not be reached: the delete the reader asked for happened, and
   * the bytes left behind are a storage bill rather than a broken work.
   */
  deleteAsset(input: { ownerId: string; id: string }): Promise<{ id: string; objectDeleted: boolean; orphanedStorageKey?: string }>;
};

export function sendJsonBodyError(
  response: ServerResponse,
  request: IncomingMessage,
  result: Extract<JsonObjectResult, { ok: false }>,
): void {
  if (result.closeConnection) {
    request.pause();
    response.shouldKeepAlive = false;
    response.setHeader("connection", "close");
  }
  sendJson(response, result.status, { error: { code: result.code, message: result.message } });
}
