import type { RestRouteContext, RestRouteHandler } from "./context.ts";
import { MAX_ARTICLE_OFFSET, authenticatedActorId, decodeSlug, decodeUserId, optionalViewerId, parseInteger, parseLocale, parsePagination, parseQuery, readJsonObject, sendBadInput, sendJson, sendJsonBodyError, sendServiceError, sendUnauthenticated, sendUnavailable } from "../http.ts";
import { normalizeArticleWriteBody, normalizeCommentWriteBody, normalizeLikeWriteBody } from "../bodies.ts";
import { serializeRestArticle, serializeRestArticles, serializeRestComment, serializeRestComments } from "../serializers.ts";
import { slugifyArticleTitle, uniquifyArticleSlug } from "../../../domain/article-slug.ts";
import { ArticleSlugConflictError } from "../../../domain/errors.ts";

const MAX_AUTO_SLUG_ATTEMPTS = 25;

/**
 * Create an article, deriving its slug from the title when the client did not
 * supply one.
 *
 * Uniqueness is owned by the database (a unique index on `articles.slug`), so a
 * generated slug that is already taken is re-suffixed rather than surfacing a
 * conflict the author cannot act on: the author never typed it. A
 * client-supplied slug is never rewritten and keeps its 409 conflict.
 */
/**
 * Create a work, uniquifying the slug while the address is taken.
 *
 * `idempotencyKey` is forwarded on every attempt: the store replays the work a
 * retried request already created, and without it the uniquifier would hand a
 * retry a new address and quietly publish a second copy.
 */
async function createArticleWithSlug(
  services: NonNullable<RestRouteContext["services"]>,
  input: Record<string, unknown>,
  authorId: string,
  idempotencyKey: string | null,
): Promise<unknown> {
  const requestedSlug = typeof input.slug === "string" && input.slug.length > 0 ? input.slug : null;
  const baseSlug = requestedSlug ?? slugifyArticleTitle(input.title);
  for (let attempt = 1; ; attempt += 1) {
    const slug = attempt === 1 ? baseSlug : uniquifyArticleSlug(baseSlug, attempt);
    try {
      return await services.createArticle({ ...input, slug, authorId, idempotencyKey });
    } catch (error: unknown) {
      const retryable = requestedSlug === null && error instanceof ArticleSlugConflictError && attempt < MAX_AUTO_SLUG_ATTEMPTS;
      if (!retryable) throw error;
    }
  }
}

/** Article collection/detail writes, related/like/comment reads and the current
 * user's own article lists. */
const ARTICLE_ROUTE_HANDLERS: Readonly<Record<string, RestRouteHandler>> = Object.freeze({
  "me.liked-articles": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, url, services, env } = ctx;
    if (!services) {
      sendUnavailable(response);
      return;
    }
    const locale = parseLocale(url);
    const limit = parseInteger(url.searchParams, "limit", 50, 1, 100);
    if (!locale || limit === null) {
      sendBadInput(response, "Invalid locale or limit query parameter.");
      return;
    }
    try {
      const actorId = await authenticatedActorId(request, services, env);
      if (!actorId) {
        sendUnauthenticated(response);
        return;
      }
      const articles = await services.listLikedArticles({ actorId, locale, limit });
      sendJson(response, 200, { data: await serializeRestArticles(services, articles, actorId) });
    } catch (error: unknown) {
      sendServiceError(response, error);
    }
  },
  "me.articles": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, url, services, env } = ctx;
    if (!services) {
      sendUnavailable(response);
      return;
    }
    const locale = parseLocale(url);
    const limit = parseInteger(url.searchParams, "limit", 50, 1, 100);
    if (!locale || limit === null) {
      sendBadInput(response, "Invalid locale or limit query parameter.");
      return;
    }
    try {
      const actorId = await authenticatedActorId(request, services, env);
      if (!actorId) {
        sendUnauthenticated(response);
        return;
      }
      const articles = await services.listMyArticles({ actorId, locale, limit });
      sendJson(response, 200, { data: await serializeRestArticles(services, articles, actorId) });
    } catch (error: unknown) {
      sendServiceError(response, error);
    }
  },
  "articles": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, url, services, env } = ctx;
    if (!services) {
      sendUnavailable(response);
      return;
    }
    if (request.method === "POST") {
      const bodyResult = await readJsonObject(request);
      if (bodyResult.ok === false) {
        sendJsonBodyError(response, request, bodyResult);
        return;
      }
      const normalized = normalizeArticleWriteBody(bodyResult.value, false);
      if (!normalized.input) {
        sendBadInput(response, normalized.error ?? "Invalid article input.");
        return;
      }
      const rawIdempotencyKey = request.headers["idempotency-key"] ?? null;
      if (rawIdempotencyKey !== null && (typeof rawIdempotencyKey !== "string" || rawIdempotencyKey.length === 0 ||
          rawIdempotencyKey.length > 300 || rawIdempotencyKey.trim() !== rawIdempotencyKey)) {
        sendBadInput(response, "An Idempotency-Key header must be a non-empty trimmed string no longer than 300 characters.");
        return;
      }
      const idempotencyKey = typeof rawIdempotencyKey === "string" ? rawIdempotencyKey : null;
      try {
        const authorId = await authenticatedActorId(request, services, env);
        if (!authorId) {
          sendUnauthenticated(response);
          return;
        }
        const article = await createArticleWithSlug(services, normalized.input, authorId, idempotencyKey);
        sendJson(response, 201, { data: await serializeRestArticle(services, article, authorId) });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return;
    }
    const locale = parseLocale(url);
    const query = parseQuery(url);
    const pagination = parsePagination(url, 20, MAX_ARTICLE_OFFSET);
    if (!locale || query === null || !pagination) {
      sendBadInput(response, "Invalid locale, query, limit, or offset query parameter.");
      return;
    }
    try {
      const viewerId = await optionalViewerId(request, services, env);
      const articles = await services.listPublishedArticles({ locale, query, ...pagination });
      sendJson(response, 200, { data: await serializeRestArticles(services, articles, viewerId) });
    } catch (error: unknown) {
      sendServiceError(response, error);
    }
  },
  "articles.related": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, url, services, env, routeParams } = ctx;
    if (!services) {
      sendUnavailable(response);
      return;
    }
    const slug = decodeSlug(routeParams.slug);
    const locale = parseLocale(url);
    const limit = parseInteger(url.searchParams, "limit", 6, 1, 50);
    if (!slug || !locale || limit === null) {
      sendBadInput(response, "Invalid article slug, locale, or limit query parameter.");
      return;
    }
    try {
      const viewerId = await optionalViewerId(request, services, env);
      const articles = await services.listRelatedArticles({ slug, locale, limit });
      sendJson(response, 200, { data: await serializeRestArticles(services, articles, viewerId) });
    } catch (error: unknown) {
      sendServiceError(response, error);
    }
  },
  "articles.like": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, url, services, env, routeParams } = ctx;
    if (!services) {
      sendUnavailable(response);
      return;
    }
    const slug = decodeSlug(routeParams.slug);
    const locale = parseLocale(url);
    if (!slug || !locale) {
      sendBadInput(response, "Invalid article slug or locale.");
      return;
    }
    if (request.method === "GET") {
      try {
        const actorId = await optionalViewerId(request, services, env);
        const result = await services.getArticleLikeInfo({ slug, locale, actorId });
        sendJson(response, 200, { data: result });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return;
    }
    const bodyResult = await readJsonObject(request);
    if (bodyResult.ok === false) {
      sendJsonBodyError(response, request, bodyResult);
      return;
    }
    const normalized = normalizeLikeWriteBody(bodyResult.value);
    if (normalized.liked === null) {
      sendBadInput(response, normalized.error ?? "Invalid like input.");
      return;
    }
    try {
      const actorId = await authenticatedActorId(request, services, env);
      if (!actorId) {
        sendUnauthenticated(response);
        return;
      }
      const result = await services.setArticleLike({ slug, locale, actorId, liked: normalized.liked });
      sendJson(response, 200, { data: result });
    } catch (error: unknown) {
      sendServiceError(response, error);
    }
  },
  "articles.comments": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, url, services, env, routeParams } = ctx;
    if (!services) {
      sendUnavailable(response);
      return;
    }
    const slug = decodeSlug(routeParams.slug);
    const locale = parseLocale(url);
    if (!slug || !locale) {
      sendBadInput(response, "Invalid article slug or locale.");
      return;
    }
    if (request.method === "GET") {
      const limit = parseInteger(url.searchParams, "limit", 50, 1, 100);
      if (limit === null) {
        sendBadInput(response, "Invalid comment limit.");
        return;
      }
      try {
        const viewerId = await optionalViewerId(request, services, env);
        const comments = await services.listArticleComments({ slug, locale, limit });
        sendJson(response, 200, { data: await serializeRestComments(services, comments, viewerId) });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return;
    }
    const bodyResult = await readJsonObject(request);
    if (bodyResult.ok === false) {
      sendJsonBodyError(response, request, bodyResult);
      return;
    }
    const normalized = normalizeCommentWriteBody(bodyResult.value);
    if (!normalized.input) {
      sendBadInput(response, normalized.error ?? "Invalid comment input.");
      return;
    }
    const rawIdempotencyKey = request.headers["idempotency-key"];
    if (rawIdempotencyKey !== undefined &&
        (typeof rawIdempotencyKey !== "string" || rawIdempotencyKey.length === 0 ||
         rawIdempotencyKey.length > 300 || rawIdempotencyKey.trim() !== rawIdempotencyKey)) {
      sendBadInput(response, "Idempotency-Key must be a non-empty trimmed string no longer than 300 characters.");
      return;
    }
    try {
      const actorId = await authenticatedActorId(request, services, env);
      if (!actorId) {
        sendUnauthenticated(response);
        return;
      }
      const comment = await services.createArticleComment({
        slug, locale, actorId, ...normalized.input,
        ...(typeof rawIdempotencyKey === "string" ? { idempotencyKey: rawIdempotencyKey } : {}),
      });
      sendJson(response, 201, { data: await serializeRestComment(services, comment, actorId) });
    } catch (error: unknown) {
      sendServiceError(response, error);
    }
  },
  "comments.item": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, services, env, routeParams } = ctx;
    if (!services) {
      sendUnavailable(response);
      return;
    }
    const commentId = decodeUserId(routeParams.id);
    if (!commentId) {
      sendBadInput(response, "Invalid comment ID.");
      return;
    }
    try {
      const actorId = await authenticatedActorId(request, services, env);
      if (!actorId) {
        sendUnauthenticated(response);
        return;
      }
      const deleted = await services.deleteArticleComment({ commentId, actorId });
      sendJson(response, 200, { data: { deleted } });
    } catch (error: unknown) {
      sendServiceError(response, error);
    }
  },
  "articles.item": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, url, services, env, routeParams } = ctx;
    if (request.method === "DELETE") {
      if (!services) {
        sendUnavailable(response);
        return;
      }
      const articleId = decodeUserId(routeParams.article);
      if (!articleId) {
        sendBadInput(response, "Invalid article ID.");
        return;
      }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) {
          sendUnauthenticated(response);
          return;
        }
        // Soft delete: the row stays, the work leaves every list it was in.
        const result = await services.deleteArticle({ articleId, actorId });
        sendJson(response, 200, { data: result });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return;
    }
    if (request.method === "PUT") {
      if (!services) {
        sendUnavailable(response);
        return;
      }
      const bodyResult = await readJsonObject(request);
      if (bodyResult.ok === false) {
        sendJsonBodyError(response, request, bodyResult);
        return;
      }
      const normalized = normalizeArticleWriteBody(bodyResult.value, true);
      if (!normalized.input) {
        sendBadInput(response, normalized.error ?? "Invalid article input.");
        return;
      }
      const articleId = decodeUserId(routeParams.article);
      if (!articleId) {
        sendBadInput(response, "Invalid article ID.");
        return;
      }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) {
          sendUnauthenticated(response);
          return;
        }
        const article = await services.updateArticle({ ...normalized.input, articleId, actorId });
        sendJson(response, 200, { data: await serializeRestArticle(services, article, actorId) });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return;
    }
    if (!services) {
      sendUnavailable(response);
      return;
    }
    const slug = decodeSlug(routeParams.article);
    const locale = parseLocale(url);
    if (!slug || !locale) {
      sendBadInput(response, "Invalid article slug or locale.");
      return;
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
  },
  "me.deleted-articles": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, url, services, env } = ctx;
    if (!services) {
      sendUnavailable(response);
      return;
    }
    const locale = parseLocale(url);
    const limit = parseInteger(url.searchParams, "limit", 50, 1, 100);
    if (!locale || limit === null) {
      sendBadInput(response, "Invalid locale or limit query parameter.");
      return;
    }
    try {
      const actorId = await authenticatedActorId(request, services, env);
      if (!actorId) {
        sendUnauthenticated(response);
        return;
      }
      // The recycle bin: the author's own tombstones, each carrying the moment
      // it was deleted and the moment the sweep will make that irreversible.
      const articles = await services.listMyDeletedArticles({ actorId, locale, limit });
      sendJson(response, 200, { data: await serializeRestArticles(services, articles, actorId) });
    } catch (error: unknown) {
      sendServiceError(response, error);
    }
  },
  "articles.restore": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, url, services, env, routeParams } = ctx;
    if (!services) {
      sendUnavailable(response);
      return;
    }
    const articleId = decodeUserId(routeParams.id);
    if (!articleId) {
      sendBadInput(response, "Invalid article ID.");
      return;
    }
    const locale = parseLocale(url);
    if (!locale) {
      sendBadInput(response, "Invalid locale query parameter.");
      return;
    }
    try {
      const actorId = await authenticatedActorId(request, services, env);
      if (!actorId) {
        sendUnauthenticated(response);
        return;
      }
      const article = await services.restoreArticle({ articleId, actorId, locale });
      sendJson(response, 200, { data: await serializeRestArticle(services, article, actorId) });
    } catch (error: unknown) {
      sendServiceError(response, error);
    }
  },
});

export const ARTICLE_ROUTE_IDS: readonly string[] = Object.freeze(Object.keys(ARTICLE_ROUTE_HANDLERS));

export async function handleArticleRoutes(ctx: RestRouteContext): Promise<boolean> {
  const handler = ARTICLE_ROUTE_HANDLERS[ctx.routeId ?? ""];
  if (!handler) return false;
  await handler(ctx);
  return true;
}
