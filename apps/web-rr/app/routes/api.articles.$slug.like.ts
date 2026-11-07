import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleArticleLikeRequest } from "@bot-thk/web-http";
import { apiProxyConfig } from "../lib/runtime.ts";

/**
 * `GET`/`PUT /api/articles/:slug/like` — resource route, no component.
 *
 * The endpoint `ArticleLike` calls once it hydrates. The API has served this
 * since long before the Web app had any use for it, which is why nothing here
 * looks new: the reader-facing half was simply missing, and a capability that
 * only exists for clients that already know about it is not a shipped feature.
 *
 * The implementation is the shared `@bot-thk/web-http` handler — slug/locale
 * validation, the exact-Origin check on the mutation, the bounded body and
 * cookie-attached forwarding exist once.
 */
function like(request: Request, url: URL, slug: string | undefined) {
  return handleArticleLikeRequest(
    request,
    { slug: slug ?? "", locale: url.searchParams.get("locale") },
    apiProxyConfig(),
  );
}

export async function loader({ request, params, url }: LoaderFunctionArgs) {
  return like(request, url, params.slug);
}

export async function action({ request, params, url }: ActionFunctionArgs) {
  return like(request, url, params.slug);
}
