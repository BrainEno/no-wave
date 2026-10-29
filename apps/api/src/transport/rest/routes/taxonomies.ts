import type { RestRouteContext, RestRouteHandler } from "./context.ts";
import { MAX_TAXONOMY_OFFSET, authenticatedActorId, decodeSlug, decodeUserId, optionalViewerId, parseLocale, parsePagination, parseQuery, readJsonObject, sendBadInput, sendJson, sendJsonBodyError, sendServiceError, sendUnauthenticated, sendUnavailable } from "../http.ts";
import { normalizeCreateTagBody, normalizeCreateTaxonomyBody } from "../bodies.ts";
import { serializeRestArticles } from "../serializers.ts";

/** Tags, categories and taxonomy administration. */
const TAXONOMY_ROUTE_HANDLERS: Readonly<Record<string, RestRouteHandler>> = Object.freeze({
  "tags": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, url, services, env } = ctx;
    if (request.method === "POST") {
      if (!services) { sendUnavailable(response); return; }
      const bodyResult = await readJsonObject(request);
      if (bodyResult.ok === false) { sendJsonBodyError(response, request, bodyResult); return; }
      const normalized = normalizeCreateTagBody(bodyResult.value);
      if (!normalized.input) { sendBadInput(response, normalized.error ?? "Invalid tag input."); return; }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) { sendUnauthenticated(response); return; }
        const tag = await services.createTag({ ...normalized.input, actorId });
        sendJson(response, 201, { data: tag });
      } catch (error: unknown) { sendServiceError(response, error); }
      return;
    }
    if (!services) {
      sendUnavailable(response);
      return;
    }
    const locale = parseLocale(url);
    const query = parseQuery(url);
    const pagination = parsePagination(url, 100, MAX_TAXONOMY_OFFSET);
    if (!locale || query === null || !pagination) {
      sendBadInput(response, "Invalid locale, query, limit, or offset query parameter.");
      return;
    }
    try {
      const tags = await services.listTaxonomies({ kind: "tag", locale, query, ...pagination });
      sendJson(response, 200, { data: tags });
    } catch (error: unknown) {
      sendServiceError(response, error);
    }
  },
  "taxonomies": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, services, env } = ctx;
    if (request.method === "POST") {
      if (!services) { sendUnavailable(response); return; }
      const bodyResult = await readJsonObject(request);
      if (bodyResult.ok === false) { sendJsonBodyError(response, request, bodyResult); return; }
      const normalized = normalizeCreateTaxonomyBody(bodyResult.value);
      if (!normalized.input) { sendBadInput(response, normalized.error ?? "Invalid taxonomy input."); return; }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) { sendUnauthenticated(response); return; }
        const taxonomy = await services.createTaxonomy({ ...normalized.input, actorId });
        sendJson(response, 201, { data: taxonomy });
      } catch (error: unknown) { sendServiceError(response, error); }
      return;
    }
  },
  "taxonomies.item": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, services, env, routeParams } = ctx;
    if (!services) { sendUnavailable(response); return; }
    const taxonomyId = decodeUserId(routeParams.id);
    if (!taxonomyId) { sendBadInput(response, "Invalid taxonomy ID."); return; }
    try {
      const actorId = await authenticatedActorId(request, services, env);
      if (!actorId) { sendUnauthenticated(response); return; }
      const deleted = await services.deleteTaxonomy({ taxonomyId, actorId });
      sendJson(response, 200, { data: deleted });
    } catch (error: unknown) { sendServiceError(response, error); }
  },
  "categories": async (ctx: RestRouteContext): Promise<void> => {
    const { response, url, services } = ctx;
    if (!services) {
      sendUnavailable(response);
      return;
    }
    const locale = parseLocale(url);
    const query = parseQuery(url);
    const pagination = parsePagination(url, 100, MAX_TAXONOMY_OFFSET);
    if (!locale || query === null || !pagination) {
      sendBadInput(response, "Invalid locale, query, limit, or offset query parameter.");
      return;
    }
    try {
      const categories = await services.listTaxonomies({ kind: "category", locale, query, ...pagination });
      sendJson(response, 200, { data: categories });
    } catch (error: unknown) {
      sendServiceError(response, error);
    }
  },
  "categories.articles": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, url, services, env, routeParams } = ctx;
    if (!services) {
      sendUnavailable(response);
      return;
    }
    const slug = decodeSlug(routeParams.slug);
    const locale = parseLocale(url);
    const pagination = parsePagination(url, 20, MAX_TAXONOMY_OFFSET);
    if (!slug || !locale || !pagination) {
      sendBadInput(response, "Invalid category slug, locale, limit, or offset query parameter.");
      return;
    }
    try {
      const category = await services.getTaxonomyBySlug({ kind: "category", slug, locale });
      if (!category) {
        sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The category was not found." } });
        return;
      }
      const viewerId = await optionalViewerId(request, services, env);
      const articles = await services.listTaxonomyArticles({ kind: "category", slug, locale, ...pagination });
      sendJson(response, 200, { data: await serializeRestArticles(services, articles, viewerId) });
    } catch (error: unknown) {
      sendServiceError(response, error);
    }
  },
  "categories.item": async (ctx: RestRouteContext): Promise<void> => {
    const { response, url, services, routeParams } = ctx;
    if (!services) {
      sendUnavailable(response);
      return;
    }
    const slug = decodeSlug(routeParams.slug);
    const locale = parseLocale(url);
    if (!slug || !locale) {
      sendBadInput(response, "Invalid category slug or locale.");
      return;
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
  },
  "tags.articles": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, url, services, env, routeParams } = ctx;
    if (!services) {
      sendUnavailable(response);
      return;
    }
    const slug = decodeSlug(routeParams.slug);
    const locale = parseLocale(url);
    const pagination = parsePagination(url, 20, MAX_TAXONOMY_OFFSET);
    if (!slug || !locale || !pagination) {
      sendBadInput(response, "Invalid tag slug, locale, limit, or offset query parameter.");
      return;
    }
    try {
      const tag = await services.getTaxonomyBySlug({ kind: "tag", slug, locale });
      if (!tag) {
        sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The tag was not found." } });
        return;
      }
      const viewerId = await optionalViewerId(request, services, env);
      const articles = await services.listTaxonomyArticles({ kind: "tag", slug, locale, ...pagination });
      sendJson(response, 200, { data: await serializeRestArticles(services, articles, viewerId) });
    } catch (error: unknown) {
      sendServiceError(response, error);
    }
  },
  "tags.item": async (ctx: RestRouteContext): Promise<void> => {
    const { response, url, services, routeParams } = ctx;
    if (!services) {
      sendUnavailable(response);
      return;
    }
    const slug = decodeSlug(routeParams.slug);
    const locale = parseLocale(url);
    if (!slug || !locale) {
      sendBadInput(response, "Invalid tag slug or locale.");
      return;
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
  },
});

export const TAXONOMY_ROUTE_IDS: readonly string[] = Object.freeze(Object.keys(TAXONOMY_ROUTE_HANDLERS));

export async function handleTaxonomyRoutes(ctx: RestRouteContext): Promise<boolean> {
  const handler = TAXONOMY_ROUTE_HANDLERS[ctx.routeId ?? ""];
  if (!handler) return false;
  await handler(ctx);
  return true;
}
