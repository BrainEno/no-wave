import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleInboxRequest, handleStartConversationRequest } from "@bot-thk/web-http";
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
 * `POST /api/inbox` — open a conversation.
 *
 * The read handler owns every other verb and answers `405` for them, so the split
 * is on the method rather than on whether `action` was reached: React Router
 * sends a POST here and nothing else, but stating the method keeps this route
 * correct if a form ever submits to it.
 *
 * Without this `action` at all, React Router answers a POST with its own `405`
 * and a body no other endpoint produces — which is why the read half already had
 * one. Now it does something for the one verb that changes state.
 */
export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "POST") {
    return handleStartConversationRequest(request, { apiBaseUrl: optionalApiBaseUrl() });
  }
  return inbox(request);
}
