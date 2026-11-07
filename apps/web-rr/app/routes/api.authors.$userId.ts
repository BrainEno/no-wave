import type { LoaderFunctionArgs } from "react-router";
import { handleAuthorProfileRequest } from "@bot-thk/web-http";
import { optionalApiBaseUrl } from "../lib/runtime.ts";

/**
 * `GET /api/authors/:userId` — resource route, no component.
 *
 * The read half of the follow control. The author page itself is server-rendered
 * from an API call that carries no session, so its `isFollowing` is `false` even
 * for a reader who follows the author; the browser asks here, with its own
 * cookie, to find out what is actually true.
 *
 * Reads only. Following and unfollowing are `POST`/`DELETE` on
 * `api.users.$userId.follow`, because the API models the relationship that way.
 */
export async function loader({ request, params, url }: LoaderFunctionArgs) {
  return handleAuthorProfileRequest(
    request,
    { userId: params.userId ?? "", locale: url.searchParams.get("locale") },
    { apiBaseUrl: optionalApiBaseUrl() },
  );
}
