import { parseArticleCatalogueQuery } from "../../../domain/article-catalogue.ts";
import { SUPPORTED_ARTICLE_LOCALES } from "../../../domain/article.ts";
import { isUuid } from "../../../domain/validation.ts";
import { authenticatedActorId, sendBadInput, sendJson, sendServiceError, sendUnauthenticated, sendUnavailable } from "../http.ts";
import { serializeRestArticle } from "../serializers.ts";
import type { RestRouteGroup } from "./context.ts";

export const CATALOGUE_ROUTE_IDS = Object.freeze(["me.article-catalogue", "me.article-catalogue-item", "me.article-catalogue-editions"]);

export const handleCatalogueRoutes: RestRouteGroup = async ctx => {
  if (!ctx.routeId || !CATALOGUE_ROUTE_IDS.includes(ctx.routeId)) return false;
  const { services, request, response, env, url } = ctx;
  if (!services) { sendUnavailable(response); return true; }
  try {
    const actorId = await authenticatedActorId(request, services, env);
    if (!actorId) { sendUnauthenticated(response); return true; }
    if (ctx.routeId === "me.article-catalogue") {
      const query = parseArticleCatalogueQuery(url.searchParams);
      const page = await services.listMyArticleCatalogue({ actorId, ...query });
      sendJson(response, 200, { data: page });
    } else if (ctx.routeId === "me.article-catalogue-editions") {
      const scope = url.searchParams.get("scope") ?? "active";
      if (!isUuid(ctx.routeParams.id) || scope !== "active" && scope !== "trash" || url.searchParams.getAll("scope").length > 1 || [...url.searchParams.keys()].some(key => key !== "scope")) {
        sendBadInput(response, "A valid catalogue work and scope are required.");
        return true;
      }
      const data = await services.listMyCatalogueEditions({ actorId, articleId: ctx.routeParams.id, scope });
      if (!data.length) sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The catalogue work was not found." } });
      else sendJson(response, 200, { data });
    } else {
      const locale = url.searchParams.get("locale");
      if (!isUuid(ctx.routeParams.id) || !locale || !SUPPORTED_ARTICLE_LOCALES.has(locale) ||
          url.searchParams.getAll("locale").length !== 1 || [...url.searchParams.keys()].some(key => key !== "locale")) {
        sendBadInput(response, "Exactly one supported locale and a valid article ID are required.");
        return true;
      }
      // The same null for another author's id, a tombstone, an absent edition,
      // and a nonexistent work: an id supplied by a browser is not permission.
      const article = await services.getMyArticle({ actorId, articleId: ctx.routeParams.id, locale });
      if (!article) sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The editable work was not found." } });
      else sendJson(response, 200, { data: await serializeRestArticle(services, article, actorId) });
    }
  } catch (error) { sendServiceError(response, error); }
  return true;
};
