import type { RestRouteContext, RestRouteHandler } from "./context.ts";
import { MAX_ARTICLE_OFFSET, decodeUserId, optionalViewerId, parseLocale, parsePagination, parseQuery, sendBadInput, sendJson, sendServiceError, sendUnavailable } from "../http.ts";
import { serializeRestArticles } from "../serializers.ts";

/** Public author profile and author-article routes. */
const AUTHOR_ROUTE_HANDLERS: Readonly<Record<string, RestRouteHandler>> = Object.freeze({
  "authors.articles": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, url, services, env, routeParams } = ctx;
    if (!services) {
      sendUnavailable(response);
      return;
    }
    const userId = decodeUserId(routeParams.username);
    const locale = parseLocale(url);
    const query = parseQuery(url);
    const pagination = parsePagination(url, 20, MAX_ARTICLE_OFFSET);
    if (!userId || !locale || query === null || !pagination) {
      sendBadInput(response, "Invalid author user ID, locale, query, limit, or offset query parameter.");
      return;
    }
    try {
      const viewerId = await optionalViewerId(request, services, env);
      const author = await services.getAuthorProfile({ userId, locale, viewerId });
      if (!author) {
        sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The author was not found." } });
        return;
      }
      const articles = await services.listPublishedArticles({ authorId: userId, locale, query, ...pagination });
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
    const userId = decodeUserId(routeParams.username);
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
