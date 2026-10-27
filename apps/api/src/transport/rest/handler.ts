import type { IncomingMessage, ServerResponse } from "node:http";
import { DomainError } from "../../domain/errors.ts";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};
const SUPPORTED_LOCALES = new Set(["zh-CN", "zh-TW", "en"]);
const MAX_QUERY_LENGTH = 200;
const MAX_ARTICLE_OFFSET = 100_000;
const MAX_TAXONOMY_OFFSET = 1_000_000;

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

/**
 * REST transport adapter. It calls application services directly; it never
 * makes an HTTP round-trip to GraphQL or reaches into persistence adapters.
 */
export function createRestHandler({ services }: { services: RestServices | null }) {
  return async function handleRest(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/v1" && !url.pathname.startsWith("/api/v1/")) return false;

    if (request.method !== "GET") {
      response.setHeader("allow", "GET");
      sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Only GET is supported for this endpoint." } });
      return true;
    }

    if (url.pathname === "/api/v1/health") {
      sendJson(response, 200, { status: "ok", service: "api", version: "0.1.0" });
      return true;
    }

    if (url.pathname === "/api/v1/articles") {
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
