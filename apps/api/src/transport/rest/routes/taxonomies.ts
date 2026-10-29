import type { RestRouteContext } from "./context.ts";
import { MAX_TAXONOMY_OFFSET, authenticatedActorId, decodeSlug, decodeUserId, optionalViewerId, parseLocale, parsePagination, parseQuery, readJsonObject, sendBadInput, sendJson, sendJsonBodyError, sendServiceError, sendUnauthenticated, sendUnavailable } from "../http.ts";
import { normalizeCreateTagBody, normalizeCreateTaxonomyBody } from "../bodies.ts";
import { serializeRestArticles } from "../serializers.ts";

/** Tags, categories and taxonomy administration. */
export async function handleTaxonomyRoutes(ctx: RestRouteContext): Promise<boolean> {
  const { request, response, url, services, env, routeParams, routeId } = ctx;
  const onCategoryArticlesRoute = routeId === "categories.articles";
  const onCategoryRoute = routeId === "categories.item";
  const onTagArticlesRoute = routeId === "tags.articles";
  const onTagRoute = routeId === "tags.item";

    if (routeId === "tags" && request.method === "POST") {
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

    if (routeId === "taxonomies" && request.method === "POST") {
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

    if (routeId === "taxonomies.item") {
      if (!services) { sendUnavailable(response); return true; }
      const taxonomyId = decodeUserId(routeParams.id);
      if (!taxonomyId) { sendBadInput(response, "Invalid taxonomy ID."); return true; }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) { sendUnauthenticated(response); return true; }
        const deleted = await services.deleteTaxonomy({ taxonomyId, actorId });
        sendJson(response, 200, { data: deleted });
      } catch (error: unknown) { sendServiceError(response, error); }
      return true;
    }

    if (routeId === "categories") {
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

    if (onCategoryArticlesRoute) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const slug = decodeSlug(routeParams.slug);
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

    if (onCategoryRoute) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const slug = decodeSlug(routeParams.slug);
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

    if (routeId === "tags") {
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

    if (onTagArticlesRoute) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const slug = decodeSlug(routeParams.slug);
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

    if (onTagRoute) {
      if (!services) {
        sendUnavailable(response);
        return true;
      }
      const slug = decodeSlug(routeParams.slug);
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

  return false;
}
