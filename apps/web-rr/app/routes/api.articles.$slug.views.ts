import type { ActionFunctionArgs } from "react-router";
import { handleArticleViewRequest } from "@bot-thk/web-http";
import { apiProxyConfig } from "../lib/runtime.ts";

/**
 * `POST /api/articles/:slug/views` — resource route, no component (ADR 0035).
 *
 * The endpoint `ArticleViewBeacon` calls once the reading page has mounted. Only
 * an action exists: a loader here would make a `GET` move a counter, and a view
 * is a write.
 *
 * The implementation is the shared `@bot-thk/web-http` handler — the same-origin
 * check, the slug/locale validation and the cookie-attached forwarding exist once.
 */
export async function action({ request, params, url }: ActionFunctionArgs) {
  return handleArticleViewRequest(
    request,
    { slug: params.slug ?? "", locale: url.searchParams.get("locale") },
    apiProxyConfig(),
  );
}
