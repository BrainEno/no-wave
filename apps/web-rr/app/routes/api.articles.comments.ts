import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleArticleCommentsRequest } from "@bot-thk/web-http";
import { apiProxyConfig } from "../lib/runtime.ts";

/**
 * `GET`/`POST /api/articles/:slug/comments` — resource route, no component.
 *
 * This is the endpoint `ArticleComments` calls after it hydrates. The component
 * is shared UI, so the comment section *looked* right while having no backend to
 * talk to at all — a page can be perfectly server-rendered and still be dead on
 * arrival.
 *
 * The implementation is the shared `@bot-thk/web-http` handler, the same one the
 * every other route that serves it: slug/locale validation, the exact-Origin check on
 * mutations, the bounded body and cookie-attached forwarding exist once, so the
 * two frameworks cannot disagree about a comment request.
 */
function comments(request: Request, url: URL, slug: string | undefined) {
  return handleArticleCommentsRequest(
    request,
    { slug: slug ?? "", locale: url.searchParams.get("locale") },
    apiProxyConfig(),
  );
}

export async function loader({ request, params, url }: LoaderFunctionArgs) {
  return comments(request, url, params.slug);
}

export async function action({ request, params, url }: ActionFunctionArgs) {
  return comments(request, url, params.slug);
}
