import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleUserFollowRequest } from "@bot-thk/web-http";
import { optionalApiBaseUrl } from "../lib/runtime.ts";

/**
 * `POST`/`DELETE /api/users/:userId/follow` — resource route, no component.
 *
 * The endpoint `AuthorFollow` calls. Following is a relationship at the API, so
 * this route takes the two verbs that create and remove it rather than a single
 * toggle: `POST` followed twice is still followed, which is what makes the
 * button safe to retry.
 *
 * No `loader`: there is nothing to read here. The viewer's own follow state
 * arrives with the author profile as `isFollowing`, and a second read endpoint
 * would be a second answer that could disagree with the first.
 *
 * The implementation is the shared `@bot-thk/web-http` handler — the Origin
 * check, the id/locale validation and cookie-attached forwarding exist once.
 */
function follow(request: Request, url: URL, userId: string | undefined) {
  return handleUserFollowRequest(
    request,
    { targetUserId: userId ?? "", locale: url.searchParams.get("locale") },
    { apiBaseUrl: optionalApiBaseUrl() },
  );
}

/**
 * A `loader` exists only so a GET reaches the handler and gets its `405` from
 * there. Without one, React Router answers a `GET` with a 400 of its own — a
 * different status and a different shape from every other wrong-method answer in
 * this application, for a route that has no read to offer.
 */
export async function loader({ request, params, url }: LoaderFunctionArgs) {
  return follow(request, url, params.userId);
}

export async function action({ request, params, url }: ActionFunctionArgs) {
  return follow(request, url, params.userId);
}
