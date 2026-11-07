import type { RestRouteContext, RestRouteHandler } from "./context.ts";
import { decodeUserId, optionalViewerId, parseLocale, parseArticlePagination, parsePagination, parseQuery, parseSort, sendBadInput, sendJson, sendServiceError, sendUnavailable } from "../http.ts";
import { describeArticleOffsetLimit, maxArticleOffset } from "../../../domain/article.ts";
import { AUTHOR_OFFSET_MAX } from "../../../domain/profile.ts";
import { serializeRestArticles } from "../serializers.ts";

/**
 * Public author profile, author-article and author-directory routes.
 *
 * The directory is a read of the same catalogue the articles are: nothing here
 * is per-reader, so the response is the same for everybody and can be cached by
 * whoever is in front of it.
 */
const AUTHOR_ROUTE_HANDLERS: Readonly<Record<string, RestRouteHandler>> = Object.freeze({
  /**
   * `GET /api/v1/authors` — the author directory and its search (ADR 0024).
   *
   * `query` is optional: without it this is the directory, ordered by reach;
   * with it, names that match are ordered by relevance first. Only authors with
   * a published work in the requested locale appear — a public directory is a
   * list of people a reader can go and read, not a member list.
   */
  "authors": async (ctx: RestRouteContext): Promise<void> => {
    const { response, url, services } = ctx;
    if (!services) {
      sendUnavailable(response);
      return;
    }
    const locale = parseLocale(url);
    const query = parseQuery(url);
    const pagination = parsePagination(url, 20, AUTHOR_OFFSET_MAX);
    if (!locale || query === null || !pagination) {
      sendBadInput(response, "Invalid locale, query, limit, or offset query parameter.");
      return;
    }
    try {
      const authors = await services.searchAuthors({ query, locale, ...pagination });
      sendJson(response, 200, { data: authors });
    } catch (error: unknown) {
      sendServiceError(response, error);
    }
  },
  "authors.articles": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, url, services, env, routeParams } = ctx;
    if (!services) {
      sendUnavailable(response);
      return;
    }
    const userId = decodeUserId(routeParams.userId);
    const locale = parseLocale(url);
    const query = parseQuery(url);
    const sort = parseSort(url);
    const pagination = parseArticlePagination(url, 20, maxArticleOffset(sort ?? "latest"));
    if (!userId || !locale || query === null || sort === null || !pagination) {
      const requested = Number(url.searchParams.get("offset") ?? "0");
      sendBadInput(
        response,
        (userId && locale && query !== null && sort !== null ? describeArticleOffsetLimit(sort, requested) : null)
          ?? "Invalid author user ID, locale, query, sort, limit, offset, or cursor query parameter.",
      );
      return;
    }
    try {
      const viewerId = await optionalViewerId(request, services, env);
      const author = await services.getAuthorProfile({ userId, locale, viewerId });
      if (!author) {
        sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The author was not found." } });
        return;
      }
      const page = pagination.kind === "cursor"
        ? { limit: pagination.limit, cursor: pagination.cursor }
        : { limit: pagination.limit, offset: pagination.offset };
      const articles = await services.listPublishedArticles({ authorId: userId, locale, query, sort, ...page });
      sendJson(response, 200, { data: await serializeRestArticles(services, articles, viewerId) });
    } catch (error: unknown) {
      sendServiceError(response, error);
    }
  },
  "authors.item": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, url, services, env, routeParams } = ctx;
    if (!services) {
      sendUnavailable(response);
      return;
    }
    const userId = decodeUserId(routeParams.userId);
    const locale = parseLocale(url);
    if (!userId || !locale) {
      sendBadInput(response, "Invalid author user ID or locale.");
      return;
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
  },
});

export const AUTHOR_ROUTE_IDS: readonly string[] = Object.freeze(Object.keys(AUTHOR_ROUTE_HANDLERS));

export async function handleAuthorRoutes(ctx: RestRouteContext): Promise<boolean> {
  const handler = AUTHOR_ROUTE_HANDLERS[ctx.routeId ?? ""];
  if (!handler) return false;
  await handler(ctx);
  return true;
}
