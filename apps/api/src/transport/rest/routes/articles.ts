import type { RestRouteContext, RestRouteHandler } from "./context.ts";
import { SUPPORTED_LOCALES, authenticatedActorId, decodeSlug, decodeUserId, optionalViewerId, parseInteger, parseLocale, parseArticlePagination, parsePagination, parseQuery, parseSort, readJsonObject, sendBadInput, sendJson, sendJsonBodyError, sendServiceError, sendUnauthenticated, sendUnavailable } from "../http.ts";
import { MAX_ARTICLE_OFFSET, describeArticlePageRefusal, maxArticleOffset } from "../../../domain/article.ts";
import { decodeCursor } from "../../../domain/cursor.ts";
import { normalizeArticleWriteBody, normalizeCommentWriteBody, normalizeFeaturedWriteBody, normalizeLikeWriteBody, type ArticleWriteBody } from "../bodies.ts";
import { serializeRestArticle, serializeRestArticles, serializeRestComment, serializeRestComments } from "../serializers.ts";
import { MAX_FEATURED_ARTICLES } from "../../../domain/article.ts";
import { createArticleWithSlug } from "../../../application/article-create.ts";

/**
 * Author-only lists may opt into every supported edition. The existing default
 * and `locale=` contract stay single-locale; an invalid or ambiguous selection
 * never falls back to another language. The limit applies to each locale, so
 * opting in cannot evict previously visible zh-CN works from the desk.
 */
function authoringListLocales(url: URL): string[] | null {
  const all = url.searchParams.get("allLocales");
  if (all !== null) {
    if (all !== "true" || url.searchParams.has("locale")) return null;
    return [...SUPPORTED_LOCALES];
  }
  const locale = parseLocale(url);
  return locale ? [locale] : null;
}

/** Stable newest-first ordering, with distinct editions of the same id kept. */
function newestFirst<T extends { id: string; locale: string }>(entries: T[], timestamp: (entry: T) => string | null): T[] {
  return entries.sort((a, b) => (timestamp(b) ?? "").localeCompare(timestamp(a) ?? "") ||
    b.id.localeCompare(a.id) || a.locale.localeCompare(b.locale));
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
    const locales = authoringListLocales(url);
    const limit = parseInteger(url.searchParams, "limit", 50, 1, 100);
    if (!locales || limit === null) {
      sendBadInput(response, "Invalid locale, allLocales, or limit query parameter.");
      return;
    }
    try {
      const actorId = await authenticatedActorId(request, services, env);
      if (!actorId) {
        sendUnauthenticated(response);
        return;
      }
      // Authenticate once, then read every requested locale for that same actor.
      // If any read fails, fail the whole request rather than hiding that edition.
      const pages = await Promise.all(locales.map((locale) => services.listMyArticles({ actorId, locale, limit })));
      const articles = locales.length === 1 ? pages[0] : newestFirst(pages.flat(), (article) => article.updatedAt);
      const data = await serializeRestArticles(services, articles, actorId);
      // A previous API silently ignored unknown query parameters. The marker
      // lets the desk distinguish that old, partial answer from a complete one.
      sendJson(response, 200, locales.length === 1 ? { data } : { data, meta: { locales } });
    } catch (error: unknown) {
      sendServiceError(response, error);
    }
  },
  /**
   * The following feed: newest published work from every account the viewer
   * follows.
   *
   * It is the reason `users.follow` exists. Without it, following an author only
   * lets a reader walk into that profile and look — the update never comes to
   * them, so the graph is write-only.
   */
  "me.feed": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, url, services, env } = ctx;
    if (!services) {
      sendUnavailable(response);
      return;
    }
    const locale = parseLocale(url);
    const pagination = parsePagination(url, 20, MAX_ARTICLE_OFFSET);
    if (!locale || !pagination) {
      sendBadInput(response, "Invalid locale, limit, or offset query parameter.");
      return;
    }
    try {
      const actorId = await authenticatedActorId(request, services, env);
      if (!actorId) {
        sendUnauthenticated(response);
        return;
      }
      const articles = await services.listFollowingArticles({ actorId, locale, ...pagination });
      sendJson(response, 200, { data: await serializeRestArticles(services, articles, actorId) });
    } catch (error: unknown) {
      sendServiceError(response, error);
    }
  },
  /**
   * The featured shelf: public to read, editorial to arrange.
   *
   * The whole list arrives in one write rather than as individual adds and moves,
   * so "editor A moved one thing up" and "editor B reordered three" cannot
   * interleave into a shelf neither of them asked for.
   */
  "featured": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, url, services, env } = ctx;
    if (!services) {
      sendUnavailable(response);
      return;
    }
    const locale = parseLocale(url);
    if (!locale) {
      sendBadInput(response, "Invalid locale query parameter.");
      return;
    }
    if (request.method === "GET") {
      const pagination = parsePagination(url, 20, MAX_FEATURED_ARTICLES);
      if (!pagination) {
        sendBadInput(response, "Invalid limit, or offset query parameter.");
        return;
      }
      try {
        const viewerId = await optionalViewerId(request, services, env);
        const articles = await services.listFeaturedArticles({ locale, ...pagination });
        sendJson(response, 200, { data: await serializeRestArticles(services, articles, viewerId) });
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
    const normalized = normalizeFeaturedWriteBody(bodyResult.value);
    if (!normalized.input) {
      sendBadInput(response, normalized.error ?? "Invalid featured input.");
      return;
    }
    try {
      const actorId = await authenticatedActorId(request, services, env);
      if (!actorId) {
        sendUnauthenticated(response);
        return;
      }
      const articles = await services.setFeaturedArticles({ actorId, articleIds: normalized.input.articleIds, locale });
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
        const article = await createArticleWithSlug((input) => services.createArticle(input), normalized.input, authorId, idempotencyKey);
        sendJson(response, 201, { data: await serializeRestArticle(services, article, authorId) });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
      return;
    }
    const locale = parseLocale(url);
    const query = parseQuery(url);
    const sort = parseSort(url);
    // The ceiling depends on the order: `latest` has a cursor for depth,
    // `popular` does not (see `maxArticleOffset`).
    const pagination = parseArticlePagination(url, 20, maxArticleOffset(sort ?? "latest"), sort ?? "latest");
    if (!locale || query === null || sort === null || !pagination) {
      const requested = Number(url.searchParams.get("offset") ?? "0");
      sendBadInput(
        response,
        (sort === null ? null : describeArticlePageRefusal({
          sort,
          hasCursor: url.searchParams.has("cursor"),
          offset: requested,
        }))
          ?? "Invalid locale, query, sort, limit, offset, or cursor query parameter.",
      );
      return;
    }
    try {
      const viewerId = await optionalViewerId(request, services, env);
      const page = pagination.kind === "cursor"
        ? { limit: pagination.limit, cursor: pagination.cursor }
        : { limit: pagination.limit, offset: pagination.offset };
      const articles = await services.listPublishedArticles({ locale, query, sort, ...page });
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
  /**
   * `POST /api/v1/articles/:slug/views` — one reader opened one work.
   *
   * Public and anonymous-friendly (ADR 0035): a beacon that required a session
   * would count only the people who signed in, which is the smallest and least
   * representative part of an audience. The session is optional and used for two
   * things only — keying the dedupe bucket per account, and refusing to count the
   * author's own proofreading.
   *
   * `200` covers "not counted": a second visit in the same day is an ordinary
   * answer, and a caller does not need a status code to interpret it.
   */
  "articles.views": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, url, services, env, routeParams, clientAddress } = ctx;
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
    try {
      const actorId = await optionalViewerId(request, services, env);
      const result = await services.recordArticleView({ slug, locale, actorId, address: clientAddress });
      sendJson(response, 200, { data: result });
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
      // `cursor` continues the thread after the last top-level comment already
      // shown. It is validated here because it is half of a sort key: an
      // unusable half can only fail in the database, and a client's typo is not
      // a server error.
      const rawCursor = url.searchParams.get("cursor");
      const cursor = rawCursor === null ? null : decodeCursor(rawCursor);
      if (rawCursor !== null && cursor === null) {
        sendBadInput(response, "Invalid comment cursor.");
        return;
      }
      try {
        const viewerId = await optionalViewerId(request, services, env);
        const comments = await services.listArticleComments(
          cursor === null ? { slug, locale, limit } : { slug, locale, limit, cursor },
        );
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
    const { request, response, url, services, env, routeParams } = ctx;
    if (!services) {
      sendUnavailable(response);
      return;
    }
    const commentId = decodeUserId(routeParams.id);
    if (!commentId) {
      sendBadInput(response, "Invalid comment ID.");
      return;
    }
    if (request.method === "PATCH") {
      // `locale` selects the edition to answer in, exactly as the thread read
      // does; the comment itself belongs to the work, not to one translation.
      const locale = parseLocale(url);
      if (!locale) {
        sendBadInput(response, "Invalid locale query parameter.");
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
      if (normalized.input.parentCommentId !== null) {
        // An edit replaces text. Moving a reply to another comment would rewrite
        // the thread it answered, and the create route is the only place a parent
        // is chosen.
        sendBadInput(response, "parentCommentId cannot be changed by an edit.");
        return;
      }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) {
          sendUnauthenticated(response);
          return;
        }
        const updated = await services.updateArticleComment({
          commentId, actorId, locale,
          content: normalized.input.content,
          contentBlocks: normalized.input.contentBlocks,
          contentBlocksVersion: normalized.input.contentBlocksVersion,
        });
        if (!updated) {
          sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The comment was not found." } });
          return;
        }
        sendJson(response, 200, { data: await serializeRestComment(services, updated, actorId) });
      } catch (error: unknown) {
        sendServiceError(response, error);
      }
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
      let ifMatchRevision: number | null = null;
      const rawIfMatch = request.headers["if-match"];
      if (rawIfMatch !== undefined) {
        if (typeof rawIfMatch !== "string") {
          sendBadInput(response, "Invalid If-Match header.");
          return;
        }
        const match = /^(?:W\/)?"?(\d+)"?$/.exec(rawIfMatch.trim());
        if (!match) {
          sendBadInput(response, "Invalid If-Match header.");
          return;
        }
        ifMatchRevision = Number(match[1]);
      }
      if (ifMatchRevision !== null && normalized.input.expectedRevision !== undefined && normalized.input.expectedRevision !== null) {
        if (ifMatchRevision !== normalized.input.expectedRevision) {
          sendBadInput(response, "If-Match header and expectedRevision in body must match.");
          return;
        }
      }
      const expectedRevision = normalized.input.expectedRevision ?? ifMatchRevision ?? undefined;
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) {
          sendUnauthenticated(response);
          return;
        }
        const article = await services.updateArticle({
          ...normalized.input,
          articleId,
          actorId,
          ...(expectedRevision !== undefined ? { expectedRevision } : {}),
        });
        response.setHeader("etag", `"${article.importRevision}"`);
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
        response.setHeader("etag", `"${article.importRevision}"`);
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
    const locales = authoringListLocales(url);
    const limit = parseInteger(url.searchParams, "limit", 50, 1, 100);
    if (!locales || limit === null) {
      sendBadInput(response, "Invalid locale, allLocales, or limit query parameter.");
      return;
    }
    try {
      const actorId = await authenticatedActorId(request, services, env);
      if (!actorId) {
        sendUnauthenticated(response);
        return;
      }
      // The recycle bin follows the same language selection as the active list.
      const pages = await Promise.all(locales.map((locale) => services.listMyDeletedArticles({ actorId, locale, limit })));
      const articles = locales.length === 1 ? pages[0] : newestFirst(pages.flat(), (article) => article.deletedAt);
      const data = await serializeRestArticles(services, articles, actorId);
      sendJson(response, 200, locales.length === 1 ? { data } : { data, meta: { locales } });
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
