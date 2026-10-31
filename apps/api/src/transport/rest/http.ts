import type { IncomingMessage, ServerResponse } from "node:http";
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

export function parseQuery(url: URL): string | null {
  const query = url.searchParams.get("query") ?? "";
  return query.length <= MAX_QUERY_LENGTH ? query : null;
}

export function parsePagination(url: URL, defaultLimit: number, maxOffset: number): { limit: number; offset: number } | null {
  const limit = parseInteger(url.searchParams, "limit", defaultLimit, 1, 100);
  const offset = parseInteger(url.searchParams, "offset", 0, 0, maxOffset);
  return limit === null || offset === null ? null : { limit, offset };
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
  NOT_FOUND: { status: 404, code: "NOT_FOUND", message: "The requested resource was not found." },
  CONFLICT: { status: 409, code: "CONFLICT", message: "The request conflicts with the current resource state." },
  IDEMPOTENCY_CONFLICT: {
    status: 409,
    code: "IDEMPOTENCY_CONFLICT",
    message: "The idempotency key was already used for a different request.",
  },
};

export function sendServiceError(response: ServerResponse, error: unknown): void {
  const mapped = error instanceof DomainError ? DOMAIN_ERROR_RESPONSES[error.code] : undefined;
  if (mapped) {
    if (error instanceof RateLimitError) response.setHeader("retry-after", String(error.retryAfterSeconds));
    sendJson(response, mapped.status, { error: { code: mapped.code, message: mapped.message } });
    return;
  }

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
): Promise<{ id: string; sessionId: string; sessionExpiresAt: number } | null> {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") return null;
  const authRequest = new Request("http://localhost/", { headers: { authorization } });
  const { user } = createAuthContext(authRequest, env);
  if (!user || typeof services.isSessionRevoked !== "function") return null;
  try {
    if (await services.isSessionRevoked(user.sessionId)) return null;
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
  const hasUnconsumedBody = request.headers["transfer-encoding"] !== undefined ||
    (typeof declaredLength === "string" && /^\\d+$/.test(declaredLength) && BigInt(declaredLength) > 0n);
  if (typeof contentType !== "string" || !["image/jpeg", "image/png", "image/webp"].includes(contentType.toLowerCase())) {
    return Promise.resolve({ ok: false, status: 415, code: "UNSUPPORTED_MEDIA_TYPE", message: "Content-Type must be image/jpeg, image/png or image/webp.", ...(hasUnconsumedBody ? { closeConnection: true } : {}) });
  }
  if (typeof declaredLength === "string" && /^\\d+$/.test(declaredLength) && BigInt(declaredLength) > BigInt(maxBytes)) {
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
