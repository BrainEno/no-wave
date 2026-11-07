import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleFeedRequest } from "@bot-thk/web-http";
import { optionalApiBaseUrl } from "../lib/runtime.ts";

/**
 * `GET /api/feed` — resource route, no component.
 *
 * The read side of following. `GET /api/v1/me/feed` has existed for as long as
 * the follow endpoint has; what was missing was this seam, so a reader who
 * followed an author had no way to see what came next.
 *
 * Read-only, so no `action` and no Origin check: a GET changes nothing, and a
 * cross-origin page cannot read the response. The session requirement is the
 * API's to enforce — this route's job is to pass the cookie through and to pass
 * the `401` back unchanged, because a signed-out caller and a caller whose
 * follow graph is empty must not look the same.
 */
function feed(request: Request, url: URL) {
  const params = url.searchParams;
  return handleFeedRequest(
    request,
    {
      locale: params.get("locale"),
      limit: params.get("limit"),
      offset: params.get("offset"),
    },
    { apiBaseUrl: optionalApiBaseUrl() },
  );
}

export async function loader({ request, url }: LoaderFunctionArgs) {
  return feed(request, url);
}

/**
 * A write verb exists here only so it reaches the handler and gets the
 * application's `405` back.
 *
 * Without it React Router answers a `POST` with a 405 of its own — right status,
 * wrong body (`{"message":"Unexpected Server Error"}` instead of
 * `{"error":{"code":"METHOD_NOT_ALLOWED",...}}`). A client parsing errors
 * uniformly would then meet a shape no other endpoint produces, for the one
 * request nobody should be making.
 */
export async function action({ request, url }: ActionFunctionArgs) {
  return feed(request, url);
}
