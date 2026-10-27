import type { IncomingMessage, ServerResponse } from "node:http";
import { DomainError } from "../../domain/errors.ts";
import { createAuthContext } from "../../security/authentication.ts";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};
const SUPPORTED_LOCALES = new Set(["zh-CN"]);
const MAX_QUERY_LENGTH = 200;
const MAX_ARTICLE_OFFSET = 100_000;
const MAX_TAXONOMY_OFFSET = 1_000_000;
const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;

type RestServices = Record<string, (...args: any[]) => any>;

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
  | { ok: false; status: number; code: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonObject(request: IncomingMessage): Promise<JsonObjectResult> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return { ok: false, status: 415, code: "UNSUPPORTED_MEDIA_TYPE", message: "Content-Type must be application/json." };
  }

  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_JSON_BODY_BYTES) {
      tooLarge = true;
      continue;
    }
    chunks.push(buffer);
  }
  if (tooLarge) {
    return { ok: false, status: 413, code: "PAYLOAD_TOO_LARGE", message: "The JSON request body is too large." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return { ok: false, status: 400, code: "BAD_USER_INPUT", message: "The request body must be valid JSON." };
  }
  if (!isRecord(parsed)) {
    return { ok: false, status: 400, code: "BAD_USER_INPUT", message: "The request body must be a JSON object." };
  }
  return { ok: true, value: parsed };
}

const ARTICLE_WRITE_FIELDS = new Set([
  "slug", "title", "summary", "locale", "contentBlocks", "publish", "workType", "categoryIds", "tagIds",
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
  if (!Array.isArray(body.contentBlocks)) {
    return { input: null, error: "contentBlocks must be a JSON array." };
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
  for (const field of ["categoryIds", "tagIds"] as const) {
    if (body[field] !== undefined && !Array.isArray(body[field])) {
      return { input: null, error: field + " must be an array when supplied." };
    }
  }

  return {
    input: { ...body, locale: "zh-CN", contentBlocks: JSON.stringify(body.contentBlocks) },
    error: null,
  };
}

async function authenticatedActorId(
  request: IncomingMessage,
  services: RestServices,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const authorization = request.headers.authorization;
  const authRequest = new Request("http://localhost/", {
    headers: typeof authorization === "string" ? { authorization } : {},
  });
  const { user } = createAuthContext(authRequest, env);
  if (!user) return null;
  if (typeof services.isSessionRevoked === "function" && await services.isSessionRevoked(user.sessionId)) return null;
  return user.id;
}

function sendUnauthenticated(response: ServerResponse): void {
  sendJson(response, 401, { error: { code: "UNAUTHENTICATED", message: "Authentication is required." } });
}

function sendJsonBodyError(response: ServerResponse, result: Extract<JsonObjectResult, { ok: false }>): void {
  sendJson(response, result.status, { error: { code: result.code, message: result.message } });
}


/**
 * REST transport adapter. It calls application services directly; it never
 * makes an HTTP round-trip to GraphQL or reaches into persistence adapters.
 */
export function createRestHandler({ services, env = process.env }: { services: RestServices | null; env?: NodeJS.ProcessEnv }) {
  return async function handleRest(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/v1" && !url.pathname.startsWith("/api/v1/")) return false;

    const articleItemPath = /^\/api\/v1\/articles\/[^/]+$/.test(url.pathname);
    const isCreateArticle = request.method === "POST" && url.pathname === "/api/v1/articles";
    const isUpdateArticle = request.method === "PUT" && articleItemPath;
    if (request.method !== "GET" && !isCreateArticle && !isUpdateArticle) {
      response.setHeader("allow", url.pathname === "/api/v1/articles" ? "GET, POST" : articleItemPath ? "GET, PUT" : "GET");
      sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "The HTTP method is not supported for this endpoint." } });
      return true;
    }

    if (url.pathname === "/api/v1/health") {
      sendJson(response, 200, { status: "ok", service: "api", version: "0.1.0" });
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
        sendJson(response, 200, { data: articles });
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
        const author = await services.getAuthorProfile({ userId, locale, viewerId: null });
        if (!author) {
          sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The author was not found." } });
          return true;
        }
        const articles = await services.listPublishedArticles({ authorId: userId, locale, query, ...pagination });
        sendJson(response, 200, { data: articles });
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
        const author = await services.getAuthorProfile({ userId, locale, viewerId: null });
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
        if (!bodyResult.ok) {
          sendJsonBodyError(response, bodyResult);
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
          sendJson(response, 201, { data: article });
        } catch (error: unknown) {
          sendServiceError(response, error);
        }
        return true;
      }
      const locale = parseLocale(url);
      if (!services) {
        sendUnavailable(response);
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
        const articles = await services.listPublishedArticles({ locale, query, ...pagination });
        sendJson(response, 200, { data: articles });
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
      if (!bodyResult.ok) {
        sendJsonBodyError(response, bodyResult);
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
        sendJson(response, 200, { data: article });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return true;
    }/^\/api\/v1\/articles\/([^/]+)$/);
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
        const article = await services.getPublishedArticle({ slug, locale });
        if (!article) {
          sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The article was not found." } });
        } else {
          sendJson(response, 200, { data: article });
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
      const pagination = parsePagination(url, 20, MAX_TAXONOMY_OFFSET);
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
        const articles = await services.listTaxonomyArticles({ kind: "category", slug, locale, ...pagination });
        sendJson(response, 200, { data: articles });
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
      const pagination = parsePagination(url, 20, MAX_TAXONOMY_OFFSET);
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
        const articles = await services.listTaxonomyArticles({ kind: "tag", slug, locale, ...pagination });
        sendJson(response, 200, { data: articles });
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
