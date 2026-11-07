import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleCommentUpdateRequest } from "@bot-thk/web-http";
import { apiProxyConfig } from "../lib/runtime.ts";

/**
 * `PATCH /api/comments/:id` — resource route, no component.
 *
 * The endpoint `ArticleComments` calls when its author corrects a comment
 * (ADR 0031). It is a separate address from the thread's
 * `/api/articles/:slug/comments` on purpose: a comment is addressed by id, and a
 * handler that accepted both shapes would have to guess which route a request is
 * aiming at from its path.
 *
 * The implementation is the shared `@bot-thk/web-http` handler: id/locale
 * validation, the exact-Origin check, the bounded body and cookie-attached
 * forwarding exist once, and the API still decides who may edit.
 */
function comment(request: Request, url: URL, id: string | undefined) {
  return handleCommentUpdateRequest(
    request,
    { id: id ?? "", locale: url.searchParams.get("locale") },
    apiProxyConfig(),
  );
}

export async function loader({ request, params, url }: LoaderFunctionArgs) {
  return comment(request, url, params.id);
}

export async function action({ request, params, url }: ActionFunctionArgs) {
  return comment(request, url, params.id);
}
