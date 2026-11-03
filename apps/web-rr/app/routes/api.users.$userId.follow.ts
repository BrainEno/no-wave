import type { ActionFunctionArgs } from "react-router";
import { handleUserFollowRequest } from "@bot-thk/web-http";
import { optionalApiBaseUrl } from "../lib/runtime.ts";

/**
 * `POST`/`DELETE /api/users/:userId/follow` — follow and unfollow (issue #168).
 *
 * Both verbs change state, so both arrive as actions; the shared handler decides
 * which upstream method a follow and an unfollow mean. The author page and the
 * end of every work link to this.
 */
export async function action({ request, params }: ActionFunctionArgs) {
  return handleUserFollowRequest(
    request,
    { userId: params.userId ?? "", locale: new URL(request.url).searchParams.get("locale") },
    { apiBaseUrl: optionalApiBaseUrl() },
  );
}
