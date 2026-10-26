const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function sendJson(response, status, body) {
  response.writeHead(status, JSON_HEADERS);
  response.end(JSON.stringify(body));
}

function parseInteger(params, name, fallback, min, max) {
  const raw = params.get(name);
  if (raw === null) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

/**
 * REST transport adapter. It calls application services directly; it never
 * makes an HTTP round-trip to GraphQL or reaches into persistence adapters.
 */
export function createRestHandler({ services }) {
  return async function handleRest(request, response) {
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
        sendJson(response, 503, { error: { code: "SERVICE_UNAVAILABLE", message: "Persistence is not configured." } });
        return true;
      }
      const limit = parseInteger(url.searchParams, "limit", 20, 1, 100);
      const offset = parseInteger(url.searchParams, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
      const locale = url.searchParams.get("locale") ?? "zh-CN";
      const query = url.searchParams.get("query") ?? "";
      if (limit === null || offset === null || !locale.trim() || locale !== locale.trim()) {
        sendJson(response, 400, { error: { code: "BAD_USER_INPUT", message: "Invalid locale, limit, or offset query parameter." } });
        return true;
      }
      try {
        const articles = await services.listPublishedArticles({ locale, query, limit, offset });
        sendJson(response, 200, { data: articles });
      } catch {
        sendJson(response, 500, { error: { code: "INTERNAL_SERVER_ERROR", message: "The request could not be completed." } });
      }
      return true;
    }

    const articleMatch = url.pathname.match(/^\/api\/v1\/articles\/([^/]+)$/);
    if (articleMatch) {
      if (!services) {
        sendJson(response, 503, { error: { code: "SERVICE_UNAVAILABLE", message: "Persistence is not configured." } });
        return true;
      }
      let slug;
      try {
        slug = decodeURIComponent(articleMatch[1]);
      } catch {
        sendJson(response, 400, { error: { code: "BAD_USER_INPUT", message: "The article slug is invalid." } });
        return true;
      }
      const locale = url.searchParams.get("locale") ?? "zh-CN";
      if (!slug || slug.trim() !== slug || !locale.trim() || locale !== locale.trim()) {
        sendJson(response, 400, { error: { code: "BAD_USER_INPUT", message: "Invalid article slug or locale." } });
        return true;
      }
      try {
        const article = await services.getPublishedArticle({ slug, locale });
        if (!article) {
          sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The article was not found." } });
        } else {
          sendJson(response, 200, { data: article });
        }
      } catch {
        sendJson(response, 500, { error: { code: "INTERNAL_SERVER_ERROR", message: "The request could not be completed." } });
      }
      return true;
    }

    sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The API route was not found." } });
    return true;
  };
}
