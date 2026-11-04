import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleInboxRequest } from "@bot-thk/web-http";
import { optionalApiBaseUrl } from "../lib/runtime.ts";

/**
 * `GET /api/inbox` — resource route, no component.
 *
 * The conversations API has been complete for a while with no Web surface
 * calling it. This is the inbox half of the read side; the thread is
 * `api.inbox.$id` and its message page.
 *
 * Read-only, so no Origin check. The session requirement is the API's to
 * enforce, and this route's job is to pass the cookie through and to hand back
 * the `401` unchanged: a signed-out reader and a reader whose inbox is empty
 * must not look the same.
 */
function inbox(request: Request) {
  return handleInboxRequest(
    request,
    { limit: new URL(request.url).searchParams.get("limit") },
    { apiBaseUrl: optionalApiBaseUrl() },
  );
}

export async function loader({ request }: LoaderFunctionArgs) {
  return inbox(request);
}

/**
 * A write verb exists here only so it reaches the handler and gets the
 * application's own `405`. Without it React Router answers with a 405 of its own
 * and a body no other endpoint produces.
 */
export async function action({ request }: ActionFunctionArgs) {
  return inbox(request);
}
