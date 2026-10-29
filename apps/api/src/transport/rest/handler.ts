import type { IncomingMessage, ServerResponse } from "node:http";
import { DomainError, RateLimitError } from "../../domain/errors.ts";
import { lexicalEditorStateToArticleDocument } from "../../domain/lexical-document-adapter.ts";
import { normalizeCommentContentInput } from "../../domain/comment-content.ts";
import { createAuthContext } from "../../security/authentication.ts";
import { createIdentityService } from "../../application/identity.ts";
import { createRateLimitService, resolveWriteRateLimitPolicy, type RateLimitBucket, type RateLimitStore } from "../../application/rate-limit.ts";
import type { IdentityStore } from "../../application/identity.ts";
import { MediaAssetNotFoundError, MediaUploadInputError } from "../../application/media-assets.ts";
import { MediaStorageUnavailableError } from "../../infrastructure/media-storage.ts";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};
const SUPPORTED_LOCALES = new Set(["zh-CN", "zh-TW", "en"]);
const MAX_QUERY_LENGTH = 200;
const MAX_ARTICLE_OFFSET = 100_000;
const MAX_TAXONOMY_OFFSET = 1_000_000;
const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_UPLOAD_BYTES = 8 * 1024 * 1024;

type RestServices = Record<string, (...args: any[]) => any> & Partial<RateLimitStore> & Partial<IdentityStore>;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, JSON_HEADERS);
  response.end(JSON.stringify(body));
}

function sendBadInput(response: ServerResponse, message = "Invalid query parameters."): void {
  sendJson(response, 400, { error: { code: "BAD_USER_INPUT", message } });
}

function parseInteger(params: URLSearchParams, name: string, fallback: number, min: number, max: number): number | null {
  const raw = params.get(name);
  if (raw === null) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

function hasDuplicateQueryParameters(params: URLSearchParams): boolean {
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

function parseLocale(url: URL): string | null {
  const locale = url.searchParams.get("locale") ?? "zh-CN";
  return SUPPORTED_LOCALES.has(locale) ? locale : null;
}

function parseQuery(url: URL): string | null {
  const query = url.searchParams.get("query") ?? "";
  return query.length <= MAX_QUERY_LENGTH ? query : null;
}

function parsePagination(url: URL, defaultLimit: number, maxOffset: number): { limit: number; offset: number } | null {
  const limit = parseInteger(url.searchParams, "limit", defaultLimit, 1, 100);
  const offset = parseInteger(url.searchParams, "offset", 0, 0, maxOffset);
  return limit === null || offset === null ? null : { limit, offset };
}

function decodeSlug(encodedSlug: string): string | null {
  let slug: string;
  try {
    slug = decodeURIComponent(encodedSlug);
  } catch {
    return null;
  }
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ? slug : null;
}

function decodeUserId(encodedUserId: string): string | null {
  let userId: string;
  try {
    userId = decodeURIComponent(encodedUserId);
  } catch {
    return null;
  }
  if (userId.length === 0 || userId.length > 300 || userId.trim() !== userId) return null;
  return userId;
}

type RestErrorResponse = { status: number; code: string; message: string };

const DOMAIN_ERROR_RESPONSES: Record<string, RestErrorResponse> = {
  BAD_USER_INPUT: { status: 400, code: "BAD_USER_INPUT", message: "The request input is invalid." },
  FORBIDDEN: { status: 403, code: "FORBIDDEN", message: "You are not allowed to access this resource." },
  UNAUTHENTICATED: { status: 401, code: "UNAUTHENTICATED", message: "The credentials are invalid." },
  RATE_LIMITED: { status: 429, code: "RATE_LIMITED", message: "Too many requests. Try again later." },
  SERVICE_UNAVAILABLE: { status: 503, code: "SERVICE_UNAVAILABLE", message: "Identity is not configured." },
  NOT_FOUND: { status: 404, code: "NOT_FOUND", message: "The requested resource was not found." },
  CONFLICT: { status: 409, code: "CONFLICT", message: "The request conflicts with the current resource state." },
  IDEMPOTENCY_CONFLICT: {
    status: 409,
    code: "IDEMPOTENCY_CONFLICT",
    message: "The idempotency key was already used for a different request.",
  },
};

function sendServiceError(response: ServerResponse, error: unknown): void {
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

function sendUnavailable(response: ServerResponse): void {
  sendJson(response, 503, { error: { code: "SERVICE_UNAVAILABLE", message: "Persistence is not configured." } });
}

type JsonObjectResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; status: number; code: string; message: string; closeConnection?: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonObject(request: IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<JsonObjectResult> {
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
const ARTICLE_WRITE_FIELDS = new Set([
  "slug", "title", "summary", "locale", "contentBlocks", "editorState", "contentBlocksVersion", "publish", "workType", "categoryIds", "tagIds",
]);

function normalizeArticleWriteBody(
  body: Record<string, unknown>,
  requirePublish: boolean,
): { input: Record<string, unknown> | null; error: string | null } {
  if (Object.keys(body).some((key) => !ARTICLE_WRITE_FIELDS.has(key))) {
    return { input: null, error: "The request contains unsupported fields." };
  }
  if (body.locale !== undefined && body.locale !== "zh-CN") {
    return { input: null, error: "The REST API currently supports only locale zh-CN." };
  }
  if (typeof body.slug !== "string" || typeof body.title !== "string") {
    return { input: null, error: "slug and title must be strings." };
  }

  // Lexical is an ingress format only. Normalize immediately to the
  // application-owned versioned block document; never persist EditorState JSON.
  const hasContentBlocks = Object.hasOwn(body, "contentBlocks");
  const hasEditorState = Object.hasOwn(body, "editorState");
  if (hasContentBlocks === hasEditorState) {
    return { input: null, error: "Supply exactly one of contentBlocks or editorState." };
  }
  let contentBlocks: unknown[];
  if (hasEditorState) {
    if (!isRecord(body.editorState)) {
      return { input: null, error: "editorState must be a serialized Lexical EditorState object." };
    }
    if (body.contentBlocksVersion !== undefined && body.contentBlocksVersion !== 1) {
      return { input: null, error: "editorState requires contentBlocksVersion 1." };
    }
    try {
      contentBlocks = lexicalEditorStateToArticleDocument(body.editorState).contentBlocks;
    } catch {
      return { input: null, error: "editorState contains invalid or unsupported article content." };
    }
  } else {
    if (!Array.isArray(body.contentBlocks)) {
      return { input: null, error: "contentBlocks must be a JSON array." };
    }
    contentBlocks = body.contentBlocks;
  }

  if (body.summary !== undefined && typeof body.summary !== "string") {
    return { input: null, error: "summary must be a string." };
  }
  if (body.workType !== undefined && typeof body.workType !== "string") {
    return { input: null, error: "workType must be a string." };
  }
  if (body.publish !== undefined && typeof body.publish !== "boolean") {
    return { input: null, error: "publish must be a boolean." };
  }
  if (requirePublish && typeof body.publish !== "boolean") {
    return { input: null, error: "publish must be supplied as a boolean for article updates." };
  }
  if (body.contentBlocksVersion !== undefined &&
      (!Number.isInteger(body.contentBlocksVersion) ||
       (body.contentBlocksVersion !== 0 && body.contentBlocksVersion !== 1))) {
    return { input: null, error: "contentBlocksVersion must be 0 or 1." };
  }
  for (const field of ["categoryIds", "tagIds"] as const) {
    if (body[field] !== undefined && !Array.isArray(body[field])) {
      return { input: null, error: field + " must be an array when supplied." };
    }
  }

  const input: Record<string, unknown> = {
    ...body,
    locale: "zh-CN",
    contentBlocks: JSON.stringify(contentBlocks),
  };
  delete input.editorState;
  if (hasEditorState) input.contentBlocksVersion = 1;
  return { input, error: null };
}


const PROFILE_WRITE_FIELDS = new Set(["displayName", "bio", "avatarUrl", "websiteUrl", "locale"]);

function normalizeProfileWriteBody(
  body: Record<string, unknown>,
): { input: Record<string, unknown> | null; error: string | null } {
  if (Object.keys(body).some((key) => !PROFILE_WRITE_FIELDS.has(key))) {
    return { input: null, error: "The request contains unsupported fields." };
  }
  if (body.locale !== undefined && body.locale !== "zh-CN") {
    return { input: null, error: "The REST API currently supports only locale zh-CN." };
  }
  if (typeof body.displayName !== "string") {
    return { input: null, error: "displayName must be a string." };
  }
  if (body.bio !== undefined && typeof body.bio !== "string") {
    return { input: null, error: "bio must be a string." };
  }
  for (const field of ["avatarUrl", "websiteUrl"] as const) {
    if (body[field] !== undefined && body[field] !== null && typeof body[field] !== "string") {
      return { input: null, error: field + " must be a string or null." };
    }
  }
  const input: Record<string, unknown> = {
    displayName: body.displayName,
    bio: body.bio ?? "",
    locale: "zh-CN",
  };
  if (Object.hasOwn(body, "avatarUrl")) input.avatarUrl = body.avatarUrl;
  if (Object.hasOwn(body, "websiteUrl")) input.websiteUrl = body.websiteUrl;
  return { input, error: null };
}

function normalizeLikeWriteBody(
  body: Record<string, unknown>,
): { liked: boolean | null; error: string | null } {
  if (Object.keys(body).some((key) => key !== "liked")) {
    return { liked: null, error: "The request contains unsupported fields." };
  }
  if (typeof body.liked !== "boolean") {
    return { liked: null, error: "liked must be a boolean." };
  }
  return { liked: body.liked, error: null };
}

function normalizeCommentWriteBody(
  body: Record<string, unknown>,
): { input: { content: string; contentBlocks: unknown[] | null; contentBlocksVersion: number; parentCommentId: string | null } | null; error: string | null } {
  if (Object.keys(body).some((key) => !["content", "contentBlocks", "editorState", "contentBlocksVersion", "parentCommentId"].includes(key))) {
    return { input: null, error: "The request contains unsupported fields." };
  }
  const parentCommentId = body.parentCommentId;
  if (parentCommentId !== undefined && parentCommentId !== null &&
      (typeof parentCommentId !== "string" || parentCommentId.length === 0 || parentCommentId.length > 300)) {
    return { input: null, error: "parentCommentId must be a comment ID or null." };
  }
  try {
    const normalizedContent = normalizeCommentContentInput(body);
    return {
      input: { ...normalizedContent, parentCommentId: typeof parentCommentId === "string" ? parentCommentId : null },
      error: null,
    };
  } catch {
    return { input: null, error: "Comment content is invalid or contains unsupported rich-text content." };
  }
}

function normalizeCreateTagBody(
  body: Record<string, unknown>,
): { input: { name: string; locale: "zh-CN" } | null; error: string | null } {
  if (Object.keys(body).some((key) => key !== "name" && key !== "locale")) {
    return { input: null, error: "The request contains unsupported fields." };
  }
  if (body.locale !== undefined && body.locale !== "zh-CN") {
    return { input: null, error: "The REST API currently supports only locale zh-CN." };
  }
  if (typeof body.name !== "string" || body.name.trim().length === 0 || body.name.length > 120) {
    return { input: null, error: "name must be non-empty and no longer than 120 characters." };
  }
  return { input: { name: body.name, locale: "zh-CN" }, error: null };
}

function normalizeCreateTaxonomyBody(
  body: Record<string, unknown>,
): { input: { kind: string; slug: string; name: string; description: string; locale: "zh-CN" } | null; error: string | null } {
  if (Object.keys(body).some((key) => !["kind", "slug", "name", "description", "locale"].includes(key))) {
    return { input: null, error: "The request contains unsupported fields." };
  }
  if (body.locale !== undefined && body.locale !== "zh-CN") {
    return { input: null, error: "The REST API currently supports only locale zh-CN." };
  }
  if (typeof body.kind !== "string" || typeof body.slug !== "string" || typeof body.name !== "string") {
    return { input: null, error: "kind, slug, and name must be strings." };
  }
  const descriptionValue = body.description;
  if (descriptionValue !== undefined && typeof descriptionValue !== "string") {
    return { input: null, error: "description must be a string." };
  }
  const description = typeof descriptionValue === "string" ? descriptionValue : "";
  if (description.length > 2000) {
    return { input: null, error: "description must be no longer than 2000 characters." };
  }
  return {
    input: {
      kind: body.kind,
      slug: body.slug,
      name: body.name,
      description,
      locale: "zh-CN",
    },
    error: null,
  };
}

function normalizeConversationCreateBody(
  body: Record<string, unknown>,
): { participantIds: string[] | null; error: string | null } {
  if (Object.keys(body).some((key) => key !== "participantIds")) {
    return { participantIds: null, error: "The request contains unsupported fields." };
  }
  if (!Array.isArray(body.participantIds) || body.participantIds.length === 0 || body.participantIds.length > 20 ||
      body.participantIds.some((id) => typeof id !== "string" || id.length === 0 || id.length > 300 || id.trim() !== id)) {
    return { participantIds: null, error: "participantIds must be a non-empty array of at most 20 user IDs." };
  }
  return { participantIds: body.participantIds as string[], error: null };
}

function normalizeConversationParticipantsBody(
  body: Record<string, unknown>,
): { input: { addUserIds: string[]; removeUserIds: string[] } | null; error: string | null } {
  if (Object.keys(body).some((key) => key !== "addUserIds" && key !== "removeUserIds")) {
    return { input: null, error: "The request contains unsupported fields." };
  }
  const addUserIds = body.addUserIds ?? [];
  const removeUserIds = body.removeUserIds ?? [];
  for (const [name, value] of [["addUserIds", addUserIds], ["removeUserIds", removeUserIds]] as const) {
    if (!Array.isArray(value) || value.length > 20 ||
        value.some((id) => typeof id !== "string" || id.length === 0 || id.length > 300 || id.trim() !== id)) {
      return { input: null, error: name + " must be an array of at most 20 user IDs." };
    }
  }
  return { input: { addUserIds: addUserIds as string[], removeUserIds: removeUserIds as string[] }, error: null };
}

function normalizeMessageWriteBody(
  body: Record<string, unknown>,
): { body: string | null; error: string | null } {
  if (Object.keys(body).some((key) => key !== "body")) {
    return { body: null, error: "The request contains unsupported fields." };
  }
  if (typeof body.body !== "string" || body.body.length === 0 || body.body.length > 20000 ||
      body.body.trim().length === 0 || body.body.trim() !== body.body) {
    return { body: null, error: "body must be non-empty, trimmed text no longer than 20000 characters." };
  }
  return { body: body.body, error: null };
}

function serializeRestNotification(notification: any): any {
  if (!notification || typeof notification !== "object") return null;
  // Match the GraphQL Notification contract; do not leak persistence-only userId.
  return {
    id: notification.id,
    eventKey: notification.eventKey,
    payload: JSON.stringify(notification.payload),
    createdAt: notification.createdAt,
    readAt: notification.readAt ?? null,
  };
}

async function authenticatedUser(
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

async function authenticatedActorId(
  request: IncomingMessage,
  services: RestServices,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  return (await authenticatedUser(request, services, env))?.id ?? null;
}

async function optionalViewerId(
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

function sendUnauthenticated(response: ServerResponse): void {
  sendJson(response, 401, { error: { code: "UNAUTHENTICATED", message: "Authentication is required." } });
}

type RawImageBodyResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; status: number; code: string; message: string; closeConnection?: boolean };

function readRawImageBody(request: IncomingMessage, maxBytes = MAX_IMAGE_UPLOAD_BYTES): Promise<RawImageBodyResult> {
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

function sendRawImageBodyError(response: ServerResponse, result: Exclude<RawImageBodyResult, { ok: true }>): void {
  if (result.closeConnection) {
    response.shouldKeepAlive = false;
    response.setHeader("connection", "close");
  }
  sendJson(response, result.status, { error: { code: result.code, message: result.message } });
}

type MediaAssetsPort = {
  upload(input: { ownerId: string; bytes: Buffer; contentType: string }): Promise<{ id: string; src: string; contentType: string; byteSize: number; width: number; height: number }>;
  getPublic(input: { id: string }): Promise<{ id: string; bytes: Buffer; byteSize: number; width: number; height: number; sha256: string; contentType: "image/webp" }>;
};

function sendJsonBodyError(
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




async function serializeRestArticle(
  services: RestServices,
  article: any,
  viewerId: string | null,
): Promise<any> {
  if (!article || typeof article !== "object") return article;
  const locale = typeof article.locale === "string" ? article.locale : "zh-CN";
  const [author, categoriesResult, tagsResult] = await Promise.all([
    article.authorId
      ? services.getAuthorProfile({ userId: article.authorId, locale, viewerId })
      : Promise.resolve(null),
    article.id
      ? services.listArticleTaxonomies({ articleId: article.id, kind: "category", locale })
      : Promise.resolve([]),
    article.id
      ? services.listArticleTaxonomies({ articleId: article.id, kind: "tag", locale })
      : Promise.resolve([]),
  ]);
  // Match the GraphQL Article contract fields. REST intentionally represents
  // contentBlocks as a JSON array rather than a JSON-encoded GraphQL string.
  return {
    ...article,
    author: author ?? null,
    categories: Array.isArray(categoriesResult) ? categoriesResult : [],
    tags: Array.isArray(tagsResult) ? tagsResult : [],
  };
}

async function serializeRestArticles(
  services: RestServices,
  articles: unknown,
  viewerId: string | null,
): Promise<unknown[]> {
  if (!Array.isArray(articles)) return [];
  return Promise.all(articles.map((article) => serializeRestArticle(services, article, viewerId)));
}

async function serializeRestComment(
  services: RestServices,
  comment: any,
  viewerId: string | null,
): Promise<any> {
  if (!comment || typeof comment !== "object") return comment;
  const author = comment.authorId
    ? await services.getAuthorProfile({
        userId: comment.authorId,
        locale: typeof comment.locale === "string" ? comment.locale : "zh-CN",
        viewerId,
      })
    : null;
  const replies = Array.isArray(comment.replies) ? comment.replies : [];
  return {
    ...comment,
    author: author ?? null,
    replies: await Promise.all(replies.map((reply) => serializeRestComment(services, reply, viewerId))),
  };
}

async function serializeRestComments(
  services: RestServices,
  comments: unknown,
  viewerId: string | null,
): Promise<unknown[]> {
  if (!Array.isArray(comments)) return [];
  return Promise.all(comments.map((comment) => serializeRestComment(services, comment, viewerId)));
}

/**
 * REST transport adapter. It calls application services directly; it never
 * makes an HTTP round-trip to GraphQL or reaches into persistence adapters.
 */
export function createRestHandler({ services, env = process.env, mediaAssets = null }: { services: RestServices | null; env?: NodeJS.ProcessEnv; mediaAssets?: MediaAssetsPort | null }) {
  // The facade is assembled dynamically from the validated persistence ports.
  const identity = services ? createIdentityService({ store: services as unknown as IdentityStore, env }) : null;
  const rateLimitStore: RateLimitStore | null = services && typeof services.consumeRateLimit === "function"
    ? {
        consumeRateLimit: (input: RateLimitBucket) => services.consumeRateLimit!(input),
        pruneExpiredIdentityState: typeof services.pruneExpiredIdentityState === "function"
          ? () => services.pruneExpiredIdentityState!()
          : undefined,
      }
    : null;
  const writeRateLimiter = rateLimitStore ? createRateLimitService({ store: rateLimitStore, env }) : null;
  return async function handleRest(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/v1" && !url.pathname.startsWith("/api/v1/")) return false;

    // Every current REST query parameter is scalar. Reject duplicates rather
    // than silently accepting URLSearchParams' first-value interpretation.
    // Close the connection because a rejected write request may still have an unread body.
    if (hasDuplicateQueryParameters(url.searchParams)) {
      request.pause();
      response.shouldKeepAlive = false;
      response.setHeader("connection", "close");
      sendBadInput(response, "Query parameters must not be repeated.");
      return true;
    }

    const identityRoute = url.pathname.match(/^\/api\/v1\/auth\/(register|login|refresh|logout)$/);
    if (identityRoute) {
      if (request.method !== "POST") {
        response.setHeader("allow", "POST");
        sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "The HTTP method is not supported for this endpoint." } });
        return true;
      }
      if (!identity) { sendUnavailable(response); return true; }
      const bodyResult = await readJsonObject(request, 4096);
      if (bodyResult.ok === false) { sendJsonBodyError(response, request, bodyResult); return true; }
      try {
        // Never trust X-Forwarded-For supplied by the client. An operator must
        // enforce additional trusted-proxy/edge throttling when behind a proxy.
        const ip = request.socket.remoteAddress ?? "unknown";
        const action = identityRoute[1] as "register" | "login" | "refresh" | "logout";
        const data = await identity[action](bodyResult.value, ip);
        sendJson(response, action === "register" ? 201 : 200, { data });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    const mePath = url.pathname === "/api/v1/me";
    const meProfilePath = url.pathname === "/api/v1/me/profile";
    const meSessionPath = url.pathname === "/api/v1/me/session";
    const meLikedArticlesPath = url.pathname === "/api/v1/me/liked-articles";
    const usersSearchPath = url.pathname === "/api/v1/users";
    const userRelationshipsMatch = url.pathname.match(/^\/api\/v1\/users\/([^/]+)\/(followers|following)$/);
    const followPathMatch = url.pathname.match(/^\/api\/v1\/users\/([^/]+)\/follow$/);
    const articleLikePathMatch = url.pathname.match(/^\/api\/v1\/articles\/([^/]+)\/like$/);
    const relatedArticlesMatch = url.pathname.match(/^\/api\/v1\/articles\/([^/]+)\/related$/);
    const articleCommentsPathMatch = url.pathname.match(/^\/api\/v1\/articles\/([^/]+)\/comments$/);
    const commentItemPathMatch = url.pathname.match(/^\/api\/v1\/comments\/([^/]+)$/);
    const tagsCollectionPath = url.pathname === "/api/v1/tags";
    const taxonomyCollectionPath = url.pathname === "/api/v1/taxonomies";
    const taxonomyItemMatch = url.pathname.match(/^\/api\/v1\/taxonomies\/([^/]+)$/);
    const conversationsPath = url.pathname === "/api/v1/conversations";
    const conversationMessagesMatch = url.pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/messages$/);
    const conversationParticipantsMatch = url.pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/participants$/);
    const conversationReadMatch = url.pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/read$/);
    const conversationItemMatch = url.pathname.match(/^\/api\/v1\/conversations\/([^/]+)$/);
    const notificationsPath = url.pathname === "/api/v1/me/notifications";
    const unreadNotificationCountPath = url.pathname === "/api/v1/me/notifications/unread-count";
    const notificationReadMatch = url.pathname.match(/^\/api\/v1\/me\/notifications\/([^/]+)\/read$/);
    const readAllNotificationsPath = url.pathname === "/api/v1/me/notifications/read-all";
    const articleItemPath = /^\/api\/v1\/articles\/[^/]+$/.test(url.pathname);
    const mediaItemMatch = url.pathname.match(/^\/api\/v1\/media\/([^/]+)$/);
    const isUploadMedia = request.method === "POST" && url.pathname === "/api/v1/me/media";
    const isCreateArticle = request.method === "POST" && url.pathname === "/api/v1/articles";
    const isUpdateArticle = request.method === "PUT" && articleItemPath;
    const isUpdateMyProfile = request.method === "PUT" && meProfilePath;
    const isRevokeSession = request.method === "DELETE" && meSessionPath;
    const isFollowUser = request.method === "POST" && followPathMatch !== null;
    const isUnfollowUser = request.method === "DELETE" && followPathMatch !== null;
    const isSetArticleLike = request.method === "PUT" && articleLikePathMatch !== null;
    const isCreateArticleComment = request.method === "POST" && articleCommentsPathMatch !== null;
    const isDeleteArticleComment = request.method === "DELETE" && commentItemPathMatch !== null;
    const isCreateTag = request.method === "POST" && tagsCollectionPath;
    const isCreateTaxonomy = request.method === "POST" && taxonomyCollectionPath;
    const isDeleteTaxonomy = request.method === "DELETE" && taxonomyItemMatch !== null;
    const isCreateConversation = request.method === "POST" && conversationsPath;
    const isSendMessage = request.method === "POST" && conversationMessagesMatch !== null;
    const isUpdateConversationParticipants = request.method === "PATCH" && conversationParticipantsMatch !== null;
    const isDeleteConversation = request.method === "DELETE" && conversationItemMatch !== null;
    const isMarkConversationRead = request.method === "PUT" && conversationReadMatch !== null;
    const isMarkNotificationRead = request.method === "PUT" && notificationReadMatch !== null;
    const isMarkAllNotificationsRead = request.method === "POST" && readAllNotificationsPath;

    const rejectMethod = (allow: string) => {
      response.setHeader("allow", allow);
      sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "The HTTP method is not supported for this endpoint." } });
    };
    if (mePath && request.method !== "GET") {
      rejectMethod("GET");
      return true;
    }
    if (meProfilePath && request.method !== "GET" && request.method !== "PUT") {
      rejectMethod("GET, PUT");
      return true;
    }
    if (meSessionPath && request.method !== "DELETE") {
      rejectMethod("DELETE");
      return true;
    }
    if (meLikedArticlesPath && request.method !== "GET") {
      rejectMethod("GET");
      return true;
    }
    if (usersSearchPath && request.method !== "GET") {
      rejectMethod("GET");
      return true;
    }
    if (userRelationshipsMatch && request.method !== "GET") {
      rejectMethod("GET");
      return true;
    }
    if (followPathMatch && request.method !== "POST" && request.method !== "DELETE") {
      rejectMethod("POST, DELETE");
      return true;
    }
    if (articleLikePathMatch && request.method !== "GET" && request.method !== "PUT") {
      rejectMethod("GET, PUT");
      return true;
    }
    if (articleCommentsPathMatch && request.method !== "GET" && request.method !== "POST") {
      rejectMethod("GET, POST");
      return true;
    }
    if (relatedArticlesMatch && request.method !== "GET") {
      rejectMethod("GET");
      return true;
    }
    if (mediaItemMatch && request.method !== "GET") {
      rejectMethod("GET");
      return true;
    }
    if (url.pathname === "/api/v1/me/media" && request.method !== "POST") {
      rejectMethod("POST");
      return true;
    }
    if (commentItemPathMatch && request.method !== "DELETE") {
      rejectMethod("DELETE");
      return true;
    }
    if (tagsCollectionPath && request.method !== "GET" && request.method !== "POST") {
      rejectMethod("GET, POST");
      return true;
    }
    if (taxonomyCollectionPath && request.method !== "POST") {
      rejectMethod("POST");
      return true;
    }
    if (taxonomyItemMatch && request.method !== "DELETE") {
      rejectMethod("DELETE");
      return true;
    }
    if (conversationsPath && request.method !== "GET" && request.method !== "POST") {
      rejectMethod("GET, POST");
      return true;
    }
    if (conversationMessagesMatch && request.method !== "GET" && request.method !== "POST") {
      rejectMethod("GET, POST");
      return true;
    }
    if (conversationParticipantsMatch && request.method !== "PATCH") {
      rejectMethod("PATCH");
      return true;
    }
    if (conversationReadMatch && request.method !== "PUT") {
      rejectMethod("PUT");
      return true;
    }
    if (conversationItemMatch && request.method !== "DELETE") {
      rejectMethod("DELETE");
      return true;
    }
    if (notificationsPath && request.method !== "GET") {
      rejectMethod("GET");
      return true;
    }
    if (unreadNotificationCountPath && request.method !== "GET") {
      rejectMethod("GET");
      return true;
    }
    if (notificationReadMatch && request.method !== "PUT") {
      rejectMethod("PUT");
      return true;
    }
    if (readAllNotificationsPath && request.method !== "POST") {
      rejectMethod("POST");
      return true;
    }
    if (request.method !== "GET" && !isUploadMedia && !isCreateArticle && !isUpdateArticle && !isUpdateMyProfile && !isRevokeSession &&
        !isFollowUser && !isUnfollowUser && !isSetArticleLike && !isCreateArticleComment && !isDeleteArticleComment &&
        !isCreateTag && !isCreateTaxonomy && !isDeleteTaxonomy && !isCreateConversation && !isSendMessage &&
        !isUpdateConversationParticipants && !isDeleteConversation && !isMarkConversationRead &&
        !isMarkNotificationRead && !isMarkAllNotificationsRead) {
      response.setHeader("allow", url.pathname === "/api/v1/articles" ? "GET, POST" : articleItemPath ? "GET, PUT" : "GET");
      sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "The HTTP method is not supported for this endpoint." } });
      return true;
    }

    const writePolicy = resolveWriteRateLimitPolicy(request.method ?? "GET", url.pathname);
    if (writePolicy && writeRateLimiter && services) {
      try {
        const actorId = await optionalViewerId(request, services, env);
        // Use only the TCP peer address. X-Forwarded-For is untrusted unless a
        // separately configured trusted proxy has already enforced this policy.
        await writeRateLimiter.checkWrite({
          method: request.method ?? "GET",
          pathname: url.pathname,
          ip: request.socket.remoteAddress ?? "unknown",
          actorId,
        });
      } catch (error: unknown) {
        sendServiceError(response, error);
        return true;
      }
    }

    if (mediaItemMatch && request.method === "GET") {
      if (!mediaAssets) { sendUnavailable(response); return true; }
      const id = decodeUserId(mediaItemMatch[1]);
      if (!id) {
        sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The requested media asset was not found." } });
        return true;
      }
      try {
        const media = await mediaAssets.getPublic({ id });
        const etag = `"${media.sha256}"`;
        const cacheHeaders = {
          "content-type": media.contentType,
          "content-length": String(media.byteSize),
          "cache-control": "public, max-age=31536000, immutable",
          "etag": etag,
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; sandbox",
        };
        if (request.headers["if-none-match"]?.split(",").map((value) => value.trim()).includes(etag)) {
          response.writeHead(304, { "cache-control": cacheHeaders["cache-control"], etag });
          response.end();
        } else {
          response.writeHead(200, cacheHeaders);
          response.end(media.bytes);
        }
      } catch (error: unknown) {
        if (error instanceof MediaAssetNotFoundError) {
          sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The requested media asset was not found." } });
        } else if (error instanceof MediaStorageUnavailableError) {
          sendJson(response, 503, { error: { code: "MEDIA_STORAGE_UNAVAILABLE", message: "The media service is temporarily unavailable." } });
        } else {
          sendServiceError(response, error);
        }
      }
      return true;
    }

    if (isUploadMedia) {
      if (!services) { sendUnavailable(response); return true; }
      if (!mediaAssets) {
        sendJson(response, 503, { error: { code: "MEDIA_STORAGE_UNAVAILABLE", message: "Image uploads are not configured for this deployment." } });
        return true;
      }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) { sendUnauthenticated(response); return true; }
        const body = await readRawImageBody(request);
        if (body.ok === false) {
          sendRawImageBodyError(response, body);
          return true;
        }
        const contentType = String(request.headers["content-type"] ?? "").toLowerCase();
        const asset = await mediaAssets.upload({ ownerId: actorId, bytes: body.bytes, contentType });
        sendJson(response, 201, { data: asset });
      } catch (error: unknown) {
        if (error instanceof MediaUploadInputError) {
          sendJson(response, 400, { error: { code: error.code, message: error.message } });
        } else if (error instanceof MediaStorageUnavailableError) {
          sendJson(response, 503, { error: { code: "MEDIA_STORAGE_UNAVAILABLE", message: "The media service is temporarily unavailable." } });
        } else {
          sendServiceError(response, error);
        }
      }
      return true;
    }

    if (url.pathname === "/api/v1/health") {
      sendJson(response, 200, { status: "ok", service: "api", version: "0.1.0" });
      return true;
    }

    if (mePath) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) {
          sendUnauthenticated(response);
          return true;
        }
        sendJson(response, 200, { data: { id: actorId } });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    if (meProfilePath && request.method === "GET") {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const locale = parseLocale(url);
      if (!locale) {
        sendBadInput(response, "Invalid locale.");
        return true;
      }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) {
          sendUnauthenticated(response);
          return true;
        }
        const profile = await services.getAuthorProfile({ userId: actorId, locale, viewerId: actorId });
        if (!profile) {
          sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The author profile was not found." } });
        } else {
          sendJson(response, 200, { data: profile });
        }
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    if (meSessionPath) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      try {
        const user = await authenticatedUser(request, services, env);
        if (!user) {
          sendUnauthenticated(response);
          return true;
        }
        await services.revokeSession({
          sessionId: user.sessionId,
          expiresAt: new Date(user.sessionExpiresAt * 1000),
        });
        sendJson(response, 200, { data: true });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }


    if (tagsCollectionPath && request.method === "POST") {
      if (!services) { sendUnavailable(response); return true; }
      const bodyResult = await readJsonObject(request);
      if (bodyResult.ok === false) { sendJsonBodyError(response, request, bodyResult); return true; }
      const normalized = normalizeCreateTagBody(bodyResult.value);
      if (!normalized.input) { sendBadInput(response, normalized.error ?? "Invalid tag input."); return true; }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) { sendUnauthenticated(response); return true; }
        const tag = await services.createTag({ ...normalized.input, actorId });
        sendJson(response, 201, { data: tag });
      } catch (error: unknown) { sendServiceError(response, error); }
      return true;
    }

    if (taxonomyCollectionPath && request.method === "POST") {
      if (!services) { sendUnavailable(response); return true; }
      const bodyResult = await readJsonObject(request);
      if (bodyResult.ok === false) { sendJsonBodyError(response, request, bodyResult); return true; }
      const normalized = normalizeCreateTaxonomyBody(bodyResult.value);
      if (!normalized.input) { sendBadInput(response, normalized.error ?? "Invalid taxonomy input."); return true; }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) { sendUnauthenticated(response); return true; }
        const taxonomy = await services.createTaxonomy({ ...normalized.input, actorId });
        sendJson(response, 201, { data: taxonomy });
      } catch (error: unknown) { sendServiceError(response, error); }
      return true;
    }

    if (taxonomyItemMatch && request.method === "DELETE") {
      if (!services) { sendUnavailable(response); return true; }
      const taxonomyId = decodeUserId(taxonomyItemMatch[1]);
      if (!taxonomyId) { sendBadInput(response, "Invalid taxonomy ID."); return true; }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) { sendUnauthenticated(response); return true; }
        const deleted = await services.deleteTaxonomy({ taxonomyId, actorId });
        sendJson(response, 200, { data: deleted });
      } catch (error: unknown) { sendServiceError(response, error); }
      return true;
    }

    if (conversationsPath) {
      if (!services) { sendUnavailable(response); return true; }
      if (request.method === "POST") {
        const bodyResult = await readJsonObject(request);
        if (bodyResult.ok === false) { sendJsonBodyError(response, request, bodyResult); return true; }
        const normalized = normalizeConversationCreateBody(bodyResult.value);
        if (!normalized.participantIds) { sendBadInput(response, normalized.error ?? "Invalid conversation input."); return true; }
        try {
          const actorId = await authenticatedActorId(request, services, env);
          if (!actorId) { sendUnauthenticated(response); return true; }
          const conversation = await services.createConversation({ actorId, participantIds: normalized.participantIds });
          sendJson(response, 201, { data: conversation });
        } catch (error: unknown) { sendServiceError(response, error); }
        return true;
      }
      const limit = parseInteger(url.searchParams, "limit", 50, 1, 100);
      if (limit === null) { sendBadInput(response, "Invalid limit query parameter."); return true; }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) { sendUnauthenticated(response); return true; }
        const conversations = await services.listConversations({ actorId, limit });
        sendJson(response, 200, { data: conversations });
      } catch (error: unknown) { sendServiceError(response, error); }
      return true;
    }

    if (conversationMessagesMatch) {
      if (!services) { sendUnavailable(response); return true; }
      const conversationId = decodeUserId(conversationMessagesMatch[1]);
      if (!conversationId) { sendBadInput(response, "Invalid conversation ID."); return true; }
      if (request.method === "GET") {
        const limit = parseInteger(url.searchParams, "limit", 100, 1, 100);
        const beforeRaw = url.searchParams.get("before");
        const before = beforeRaw === null ? null : decodeUserId(beforeRaw);
        if (limit === null || (beforeRaw !== null && !before)) {
          sendBadInput(response, "Invalid limit or before cursor query parameter.");
          return true;
        }
        try {
          const actorId = await authenticatedActorId(request, services, env);
          if (!actorId) { sendUnauthenticated(response); return true; }
          const messages = await services.listConversationMessages({ conversationId, actorId, limit, before });
          sendJson(response, 200, { data: messages });
        } catch (error: unknown) { sendServiceError(response, error); }
        return true;
      }
      const bodyResult = await readJsonObject(request);
      if (bodyResult.ok === false) { sendJsonBodyError(response, request, bodyResult); return true; }
      const normalized = normalizeMessageWriteBody(bodyResult.value);
      if (normalized.body === null) { sendBadInput(response, normalized.error ?? "Invalid message input."); return true; }
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0 ||
          idempotencyKey.length > 300 || idempotencyKey.trim() !== idempotencyKey) {
        sendBadInput(response, "A valid Idempotency-Key header is required.");
        return true;
      }
      try {
        const senderId = await authenticatedActorId(request, services, env);
        if (!senderId) { sendUnauthenticated(response); return true; }
        const message = await services.persistMessage({ conversationId, senderId, body: normalized.body, idempotencyKey });
        sendJson(response, 201, { data: message });
      } catch (error: unknown) { sendServiceError(response, error); }
      return true;
    }

    if (conversationParticipantsMatch && request.method === "PATCH") {
      if (!services) { sendUnavailable(response); return true; }
      const conversationId = decodeUserId(conversationParticipantsMatch[1]);
      if (!conversationId) { sendBadInput(response, "Invalid conversation ID."); return true; }
      const bodyResult = await readJsonObject(request);
      if (bodyResult.ok === false) { sendJsonBodyError(response, request, bodyResult); return true; }
      const normalized = normalizeConversationParticipantsBody(bodyResult.value);
      if (!normalized.input) { sendBadInput(response, normalized.error ?? "Invalid participant update input."); return true; }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) { sendUnauthenticated(response); return true; }
        await services.updateConversationParticipants({ conversationId, actorId, ...normalized.input });
        const updated = await services.getConversation({ conversationId, actorId });
        if (!updated) sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The conversation was not found." } });
        else sendJson(response, 200, { data: updated });
      } catch (error: unknown) { sendServiceError(response, error); }
      return true;
    }

    if (conversationReadMatch && request.method === "PUT") {
      if (!services) { sendUnavailable(response); return true; }
      const conversationId = decodeUserId(conversationReadMatch[1]);
      if (!conversationId) { sendBadInput(response, "Invalid conversation ID."); return true; }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) { sendUnauthenticated(response); return true; }
        const result = await services.markConversationAsRead({ conversationId, actorId });
        sendJson(response, 200, { data: result });
      } catch (error: unknown) { sendServiceError(response, error); }
      return true;
    }

    if (conversationItemMatch && request.method === "DELETE") {
      if (!services) { sendUnavailable(response); return true; }
      const conversationId = decodeUserId(conversationItemMatch[1]);
      if (!conversationId) { sendBadInput(response, "Invalid conversation ID."); return true; }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) { sendUnauthenticated(response); return true; }
        const deleted = await services.deleteConversation({ conversationId, actorId });
        sendJson(response, 200, { data: deleted });
      } catch (error: unknown) { sendServiceError(response, error); }
      return true;
    }

    if (notificationsPath) {
      if (!services) { sendUnavailable(response); return true; }
      const limit = parseInteger(url.searchParams, "limit", 50, 1, 100);
      if (limit === null) { sendBadInput(response, "Invalid limit query parameter."); return true; }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) { sendUnauthenticated(response); return true; }
        const notifications = await services.listNotifications({ actorId, limit });
        sendJson(response, 200, { data: Array.isArray(notifications) ? notifications.map(serializeRestNotification) : [] });
      } catch (error: unknown) { sendServiceError(response, error); }
      return true;
    }

    if (unreadNotificationCountPath) {
      if (!services) { sendUnavailable(response); return true; }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) { sendUnauthenticated(response); return true; }
        const count = await services.getUnreadNotificationCount({ actorId });
        sendJson(response, 200, { data: count });
      } catch (error: unknown) { sendServiceError(response, error); }
      return true;
    }

    if (notificationReadMatch && request.method === "PUT") {
      if (!services) { sendUnavailable(response); return true; }
      const notificationId = decodeUserId(notificationReadMatch[1]);
      if (!notificationId) { sendBadInput(response, "Invalid notification ID."); return true; }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) { sendUnauthenticated(response); return true; }
        const notification = await services.markNotificationRead({ notificationId, actorId });
        sendJson(response, 200, { data: serializeRestNotification(notification) });
      } catch (error: unknown) { sendServiceError(response, error); }
      return true;
    }

    if (readAllNotificationsPath && request.method === "POST") {
      if (!services) { sendUnavailable(response); return true; }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) { sendUnauthenticated(response); return true; }
        const count = await services.markAllNotificationsRead({ actorId });
        sendJson(response, 200, { data: count });
      } catch (error: unknown) { sendServiceError(response, error); }
      return true;
    }

    if (usersSearchPath) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const query = url.searchParams.get("query");
      const locale = parseLocale(url);
      const limit = parseInteger(url.searchParams, "limit", 20, 1, 100);
      if (query === null || query.length > MAX_QUERY_LENGTH || !locale || limit === null) {
        sendBadInput(response, "Invalid query, locale, or limit query parameter.");
        return true;
      }
      try {
        const viewerId = await optionalViewerId(request, services, env);
        const users = await services.searchUsers({ query, locale, limit, viewerId });
        sendJson(response, 200, { data: users });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    if (userRelationshipsMatch) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const userId = decodeUserId(userRelationshipsMatch[1]);
      const relation = userRelationshipsMatch[2];
      const locale = parseLocale(url);
      const limit = parseInteger(url.searchParams, "limit", 50, 1, 100);
      if (!userId || !locale || limit === null) {
        sendBadInput(response, "Invalid user ID, locale, or limit query parameter.");
        return true;
      }
      try {
        const viewerId = await optionalViewerId(request, services, env);
        const users = relation === "followers"
          ? await services.listFollowers({ userId, locale, limit, viewerId })
          : await services.listFollowing({ userId, locale, limit, viewerId });
        sendJson(response, 200, { data: users });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    if (meLikedArticlesPath) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const locale = parseLocale(url);
      const limit = parseInteger(url.searchParams, "limit", 50, 1, 100);
      if (!locale || limit === null) {
        sendBadInput(response, "Invalid locale or limit query parameter.");
        return true;
      }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) {
          sendUnauthenticated(response);
          return true;
        }
        const articles = await services.listLikedArticles({ actorId, locale, limit });
        sendJson(response, 200, { data: await serializeRestArticles(services, articles, actorId) });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    if (url.pathname === "/api/v1/me/articles") {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const locale = parseLocale(url);
      const limit = parseInteger(url.searchParams, "limit", 50, 1, 100);
      if (!locale || limit === null) {
        sendBadInput(response, "Invalid locale or limit query parameter.");
        return true;
      }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) {
          sendUnauthenticated(response);
          return true;
        }
        const articles = await services.listMyArticles({ actorId, locale, limit });
        sendJson(response, 200, { data: await serializeRestArticles(services, articles, actorId) });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    if (meProfilePath) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const bodyResult = await readJsonObject(request);
      if (bodyResult.ok === false) {
        sendJsonBodyError(response, request, bodyResult);
        return true;
      }
      const normalized = normalizeProfileWriteBody(bodyResult.value);
      if (!normalized.input) {
        sendBadInput(response, normalized.error ?? "Invalid profile input.");
        return true;
      }
      try {
        const userId = await authenticatedActorId(request, services, env);
        if (!userId) {
          sendUnauthenticated(response);
          return true;
        }
        await services.upsertAuthorProfile({ ...normalized.input, userId });
        const profile = await services.getAuthorProfile({ userId, locale: "zh-CN", viewerId: userId });
        if (!profile) {
          sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The author profile was not found." } });
        } else {
          sendJson(response, 200, { data: profile });
        }
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    if (followPathMatch) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const targetUserId = decodeUserId(followPathMatch[1]);
      const locale = parseLocale(url);
      if (!targetUserId || !locale) {
        sendBadInput(response, "Invalid target user ID or locale.");
        return true;
      }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) {
          sendUnauthenticated(response);
          return true;
        }
        if (request.method === "POST") {
          await services.followUser({ actorId, targetUserId });
        } else {
          await services.unfollowUser({ actorId, targetUserId });
        }
        const profile = await services.getAuthorProfile({ userId: targetUserId, locale, viewerId: actorId });
        if (!profile) {
          sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The author was not found." } });
        } else {
          sendJson(response, 200, { data: profile });
        }
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    const authorArticlesMatch = url.pathname.match(/^\/api\/v1\/authors\/([^/]+)\/articles$/);
    if (authorArticlesMatch) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const userId = decodeUserId(authorArticlesMatch[1]);
      const locale = parseLocale(url);
      const query = parseQuery(url);
      const pagination = parsePagination(url, 20, MAX_ARTICLE_OFFSET);
      if (!userId || !locale || query === null || !pagination) {
        sendBadInput(response, "Invalid author user ID, locale, query, limit, or offset query parameter.");
        return true;
      }
      try {
        const viewerId = await optionalViewerId(request, services, env);
        const author = await services.getAuthorProfile({ userId, locale, viewerId });
        if (!author) {
          sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The author was not found." } });
          return true;
        }
        const articles = await services.listPublishedArticles({ authorId: userId, locale, query, ...pagination });
        sendJson(response, 200, { data: await serializeRestArticles(services, articles, viewerId) });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    const authorMatch = url.pathname.match(/^\/api\/v1\/authors\/([^/]+)$/);
    if (authorMatch) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const userId = decodeUserId(authorMatch[1]);
      const locale = parseLocale(url);
      if (!userId || !locale) {
        sendBadInput(response, "Invalid author user ID or locale.");
        return true;
      }
      try {
        const viewerId = await optionalViewerId(request, services, env);
        const author = await services.getAuthorProfile({ userId, locale, viewerId });
        if (!author) {
          sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The author was not found." } });
        } else {
          sendJson(response, 200, { data: author });
        }
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    if (url.pathname === "/api/v1/articles") {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      if (request.method === "POST") {
        const bodyResult = await readJsonObject(request);
        if (bodyResult.ok === false) {
          sendJsonBodyError(response, request, bodyResult);
          return true;
        }
        const normalized = normalizeArticleWriteBody(bodyResult.value, false);
        if (!normalized.input) {
          sendBadInput(response, normalized.error ?? "Invalid article input.");
          return true;
        }
        try {
          const authorId = await authenticatedActorId(request, services, env);
          if (!authorId) {
            sendUnauthenticated(response);
            return true;
          }
          const article = await services.createArticle({ ...normalized.input, authorId });
          sendJson(response, 201, { data: await serializeRestArticle(services, article, authorId) });
        } catch (error: unknown) {
          sendServiceError(response, error);
        }
        return true;
      }
      const locale = parseLocale(url);
      const query = parseQuery(url);
      const pagination = parsePagination(url, 20, MAX_ARTICLE_OFFSET);
      if (!locale || query === null || !pagination) {
        sendBadInput(response, "Invalid locale, query, limit, or offset query parameter.");
        return true;
      }
      try {
        const viewerId = await optionalViewerId(request, services, env);
        const articles = await services.listPublishedArticles({ locale, query, ...pagination });
        sendJson(response, 200, { data: await serializeRestArticles(services, articles, viewerId) });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    if (relatedArticlesMatch) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const slug = decodeSlug(relatedArticlesMatch[1]);
      const locale = parseLocale(url);
      const limit = parseInteger(url.searchParams, "limit", 6, 1, 50);
      if (!slug || !locale || limit === null) {
        sendBadInput(response, "Invalid article slug, locale, or limit query parameter.");
        return true;
      }
      try {
        const viewerId = await optionalViewerId(request, services, env);
        const articles = await services.listRelatedArticles({ slug, locale, limit });
        sendJson(response, 200, { data: await serializeRestArticles(services, articles, viewerId) });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    if (articleLikePathMatch) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const slug = decodeSlug(articleLikePathMatch[1]);
      const locale = parseLocale(url);
      if (!slug || !locale) {
        sendBadInput(response, "Invalid article slug or locale.");
        return true;
      }
      if (request.method === "GET") {
        try {
          const actorId = await optionalViewerId(request, services, env);
          const result = await services.getArticleLikeInfo({ slug, locale, actorId });
          sendJson(response, 200, { data: result });
        } catch (error: unknown) {
          sendServiceError(response, error);
        }
        return true;
      }
      const bodyResult = await readJsonObject(request);
      if (bodyResult.ok === false) {
        sendJsonBodyError(response, request, bodyResult);
        return true;
      }
      const normalized = normalizeLikeWriteBody(bodyResult.value);
      if (normalized.liked === null) {
        sendBadInput(response, normalized.error ?? "Invalid like input.");
        return true;
      }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) {
          sendUnauthenticated(response);
          return true;
        }
        const result = await services.setArticleLike({ slug, locale, actorId, liked: normalized.liked });
        sendJson(response, 200, { data: result });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    if (articleCommentsPathMatch) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const slug = decodeSlug(articleCommentsPathMatch[1]);
      const locale = parseLocale(url);
      if (!slug || !locale) {
        sendBadInput(response, "Invalid article slug or locale.");
        return true;
      }
      if (request.method === "GET") {
        const limit = parseInteger(url.searchParams, "limit", 50, 1, 100);
        if (limit === null) {
          sendBadInput(response, "Invalid comment limit.");
          return true;
        }
        try {
          const viewerId = await optionalViewerId(request, services, env);
          const comments = await services.listArticleComments({ slug, locale, limit });
          sendJson(response, 200, { data: await serializeRestComments(services, comments, viewerId) });
        } catch (error: unknown) {
          sendServiceError(response, error);
        }
        return true;
      }
      const bodyResult = await readJsonObject(request);
      if (bodyResult.ok === false) {
        sendJsonBodyError(response, request, bodyResult);
        return true;
      }
      const normalized = normalizeCommentWriteBody(bodyResult.value);
      if (!normalized.input) {
        sendBadInput(response, normalized.error ?? "Invalid comment input.");
        return true;
      }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) {
          sendUnauthenticated(response);
          return true;
        }
        const comment = await services.createArticleComment({
          slug, locale, actorId, ...normalized.input,
        });
        sendJson(response, 201, { data: await serializeRestComment(services, comment, actorId) });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    if (commentItemPathMatch) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const commentId = decodeUserId(commentItemPathMatch[1]);
      if (!commentId) {
        sendBadInput(response, "Invalid comment ID.");
        return true;
      }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) {
          sendUnauthenticated(response);
          return true;
        }
        const deleted = await services.deleteArticleComment({ commentId, actorId });
        sendJson(response, 200, { data: { deleted } });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    const articleMatch = url.pathname.match(/^\/api\/v1\/articles\/([^/]+)$/);
    if (articleMatch && request.method === "PUT") {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const bodyResult = await readJsonObject(request);
      if (bodyResult.ok === false) {
        sendJsonBodyError(response, request, bodyResult);
        return true;
      }
      const normalized = normalizeArticleWriteBody(bodyResult.value, true);
      if (!normalized.input) {
        sendBadInput(response, normalized.error ?? "Invalid article input.");
        return true;
      }
      const articleId = decodeUserId(articleMatch[1]);
      if (!articleId) {
        sendBadInput(response, "Invalid article ID.");
        return true;
      }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) {
          sendUnauthenticated(response);
          return true;
        }
        const article = await services.updateArticle({ ...normalized.input, articleId, actorId });
        sendJson(response, 200, { data: await serializeRestArticle(services, article, actorId) });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }
    if (articleMatch) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const slug = decodeSlug(articleMatch[1]);
      const locale = parseLocale(url);
      if (!slug || !locale) {
        sendBadInput(response, "Invalid article slug or locale.");
        return true;
      }
      try {
        const viewerId = await optionalViewerId(request, services, env);
        const article = await services.getPublishedArticle({ slug, locale });
        if (!article) {
          sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The article was not found." } });
        } else {
          sendJson(response, 200, { data: await serializeRestArticle(services, article, viewerId) });
        }
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    if (url.pathname === "/api/v1/categories") {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const locale = parseLocale(url);
      const query = parseQuery(url);
      const pagination = parsePagination(url, 100, MAX_TAXONOMY_OFFSET);
      if (!locale || query === null || !pagination) {
        sendBadInput(response, "Invalid locale, query, limit, or offset query parameter.");
        return true;
      }
      try {
        const categories = await services.listTaxonomies({ kind: "category", locale, query, ...pagination });
        sendJson(response, 200, { data: categories });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    const categoryArticlesMatch = url.pathname.match(/^\/api\/v1\/categories\/([^/]+)\/articles$/);
    if (categoryArticlesMatch) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const slug = decodeSlug(categoryArticlesMatch[1]);
      const locale = parseLocale(url);
      const pagination = parsePagination(url, 20, MAX_TAXONOMY_OFFSET);
      if (!slug || !locale || !pagination) {
        sendBadInput(response, "Invalid category slug, locale, limit, or offset query parameter.");
        return true;
      }
      try {
        const category = await services.getTaxonomyBySlug({ kind: "category", slug, locale });
        if (!category) {
          sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The category was not found." } });
          return true;
        }
        const viewerId = await optionalViewerId(request, services, env);
        const articles = await services.listTaxonomyArticles({ kind: "category", slug, locale, ...pagination });
        sendJson(response, 200, { data: await serializeRestArticles(services, articles, viewerId) });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    const categoryMatch = url.pathname.match(/^\/api\/v1\/categories\/([^/]+)$/);
    if (categoryMatch) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const slug = decodeSlug(categoryMatch[1]);
      const locale = parseLocale(url);
      if (!slug || !locale) {
        sendBadInput(response, "Invalid category slug or locale.");
        return true;
      }
      try {
        const category = await services.getTaxonomyBySlug({ kind: "category", slug, locale });
        if (!category) {
          sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The category was not found." } });
        } else {
          sendJson(response, 200, { data: category });
        }
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    if (url.pathname === "/api/v1/tags") {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const locale = parseLocale(url);
      const query = parseQuery(url);
      const pagination = parsePagination(url, 100, MAX_TAXONOMY_OFFSET);
      if (!locale || query === null || !pagination) {
        sendBadInput(response, "Invalid locale, query, limit, or offset query parameter.");
        return true;
      }
      try {
        const tags = await services.listTaxonomies({ kind: "tag", locale, query, ...pagination });
        sendJson(response, 200, { data: tags });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    const tagArticlesMatch = url.pathname.match(/^\/api\/v1\/tags\/([^/]+)\/articles$/);
    if (tagArticlesMatch) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const slug = decodeSlug(tagArticlesMatch[1]);
      const locale = parseLocale(url);
      const pagination = parsePagination(url, 20, MAX_TAXONOMY_OFFSET);
      if (!slug || !locale || !pagination) {
        sendBadInput(response, "Invalid tag slug, locale, limit, or offset query parameter.");
        return true;
      }
      try {
        const tag = await services.getTaxonomyBySlug({ kind: "tag", slug, locale });
        if (!tag) {
          sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The tag was not found." } });
          return true;
        }
        const viewerId = await optionalViewerId(request, services, env);
        const articles = await services.listTaxonomyArticles({ kind: "tag", slug, locale, ...pagination });
        sendJson(response, 200, { data: await serializeRestArticles(services, articles, viewerId) });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    const tagMatch = url.pathname.match(/^\/api\/v1\/tags\/([^/]+)$/);
    if (tagMatch) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const slug = decodeSlug(tagMatch[1]);
      const locale = parseLocale(url);
      if (!slug || !locale) {
        sendBadInput(response, "Invalid tag slug or locale.");
        return true;
      }
      try {
        const tag = await services.getTaxonomyBySlug({ kind: "tag", slug, locale });
        if (!tag) {
          sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The tag was not found." } });
        } else {
          sendJson(response, 200, { data: tag });
        }
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }

    sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The API route was not found." } });
    return true;
  };
}
