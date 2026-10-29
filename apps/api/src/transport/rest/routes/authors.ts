import type { RestRouteContext } from "./context.ts";
import { MAX_ARTICLE_OFFSET, decodeUserId, optionalViewerId, parseLocale, parsePagination, parseQuery, sendBadInput, sendJson, sendServiceError, sendUnavailable } from "../http.ts";
import { serializeRestArticles } from "../serializers.ts";

/** Public author profile and author-article routes. */
export async function handleAuthorRoutes(ctx: RestRouteContext): Promise<boolean> {
  const { request, response, url, services, env, routeParams, routeId } = ctx;
  const onAuthorArticlesRoute = routeId === "authors.articles";
  const onAuthorRoute = routeId === "authors.item";

    if (onAuthorArticlesRoute) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const userId = decodeUserId(routeParams.username);
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

    if (onAuthorRoute) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const userId = decodeUserId(routeParams.username);
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

  return false;
}
