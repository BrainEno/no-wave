import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleArticleLikeRequest } from "@bot-thk/web-http";
import { optionalApiBaseUrl } from "../lib/runtime.ts";

/**
 * `GET`/`PUT /api/articles/:slug/like` — the save button's endpoint (issue #168).
 *
 * The reading page offered no way to save a work even though `PUT
 * /api/v1/articles/:slug/like` has existed all along. The browser cannot call it
 * directly: the access token is an HttpOnly cookie, so the write has to cross
 * this proxy, exactly as comments and authoring writes do.
 *
 * A GET is a loader and a PUT is an action, so each verb reaches the same shared
 * handler through the entry point React Router has for it.
 */
function like(request: Request, slug: string | undefined) {
  return handleArticleLikeRequest(
    request,
    { slug: slug ?? "", locale: new URL(request.url).searchParams.get("locale") },
    { apiBaseUrl: optionalApiBaseUrl() },
  );
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  return like(request, params.slug);
}

export async function action({ request, params }: ActionFunctionArgs) {
  return like(request, params.slug);
}
