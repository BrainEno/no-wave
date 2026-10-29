import type { IncomingMessage, ServerResponse } from "node:http";
import { DomainError, RateLimitError } from "../../domain/errors.ts";
import { lexicalEditorStateToArticleDocument } from "../../domain/lexical-document-adapter.ts";
import { normalizeCommentContentInput } from "../../domain/comment-content.ts";
import { createAuthContext } from "../../security/authentication.ts";
import type { RateLimitStore } from "../../application/rate-limit.ts";
import type { IdentityStore } from "../../application/identity.ts";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};
const SUPPORTED_LOCALES = new Set(["zh-CN", "zh-TW", "en"]);
export const MAX_QUERY_LENGTH = 200;
export const MAX_ARTICLE_OFFSET = 100_000;
export const MAX_TAXONOMY_OFFSET = 1_000_000;
const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;

export type RestServices = Record<string, (...args: any[]) => any> & Partial<RateLimitStore> & Partial<IdentityStore>;

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

type JsonObjectResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; status: number; code: string; message: string; closeConnection?: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
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
const ARTICLE_WRITE_FIELDS = new Set([
  "slug", "title", "summary", "locale", "contentBlocks", "editorState", "contentBlocksVersion", "publish", "workType", "categoryIds", "tagIds",
]);

export function normalizeArticleWriteBody(
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

export function normalizeProfileWriteBody(
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

export function normalizeLikeWriteBody(
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

export function normalizeCommentWriteBody(
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

export function normalizeCreateTagBody(
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

export function normalizeCreateTaxonomyBody(
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

export function normalizeConversationCreateBody(
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

export function normalizeConversationParticipantsBody(
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

export function normalizeMessageWriteBody(
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

export function serializeRestNotification(notification: any): any {
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




export async function serializeRestArticle(
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

export async function serializeRestArticles(
  services: RestServices,
  articles: unknown,
  viewerId: string | null,
): Promise<unknown[]> {
  if (!Array.isArray(articles)) return [];
  return Promise.all(articles.map((article) => serializeRestArticle(services, article, viewerId)));
}

export async function serializeRestComment(
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

export async function serializeRestComments(
  services: RestServices,
  comments: unknown,
  viewerId: string | null,
): Promise<unknown[]> {
  if (!Array.isArray(comments)) return [];
  return Promise.all(comments.map((comment) => serializeRestComment(services, comment, viewerId)));
}

