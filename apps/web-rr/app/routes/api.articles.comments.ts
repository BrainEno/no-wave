import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleArticleCommentsRequest } from "@bot-thk/web-http";
import { optionalApiBaseUrl } from "../lib/runtime.ts";

/**
 * `GET`/`POST /api/articles/:slug/comments` — resource route, no component.
 *
 * This is the endpoint `ArticleComments` calls after it hydrates. The component
 * is shared with the App Router and renders in both frameworks, so the comment
 * section *looked* right in the prototype while having no backend to talk to at
 * all — a page can be perfectly server-rendered and still be dead on arrival.
 *
 * The implementation is the shared `@bot-thk/web-http` handler, the same one the
 * Next.js route handler calls: slug/locale validation, the exact-Origin check on
 * mutations, the bounded body and cookie-attached forwarding exist once, so the
 * two frameworks cannot disagree about a comment request.
 */
function comments(request: Request, slug: string | undefined) {
  return handleArticleCommentsRequest(
    request,
    { slug: slug ?? "", locale: new URL(request.url).searchParams.get("locale") },
    { apiBaseUrl: optionalApiBaseUrl() },
  );
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  return comments(request, params.slug);
}

export async function action({ request, params }: ActionFunctionArgs) {
  return comments(request, params.slug);
}
