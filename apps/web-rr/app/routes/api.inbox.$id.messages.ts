import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleConversationMessagesRequest, handleSendMessageRequest } from "@bot-thk/web-http";
import { optionalApiBaseUrl } from "../lib/runtime.ts";

/**
 * `GET /api/inbox/:id/messages` — one page of a conversation, oldest first.
 *
 * `before` is an opaque cursor: the API reads everything older than that message
 * row. Absent means "the newest page", which is a different request from an
 * explicit empty cursor — this route passes `null` rather than `""` so the proxy
 * can tell them apart.
 */
function messages(request: Request, id: string | undefined) {
  const params = new URL(request.url).searchParams;
  return handleConversationMessagesRequest(
    request,
    { conversationId: id ?? "", limit: params.get("limit"), before: params.get("before") },
    { apiBaseUrl: optionalApiBaseUrl() },
  );
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  return messages(request, params.id);
}

/**
 * Sending needs the `Idempotency-Key` header to reach the handler untouched, and
 * it does: the action receives the browser's `Request` as-is. The handler is the
 * only place that decides whether the key is usable, and it refuses rather than
 * inventing one — a key minted here would differ per request and turn every retry
 * into a second message.
 */
export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method === "POST") {
    return handleSendMessageRequest(
      request,
      { conversationId: params.id ?? "" },
      { apiBaseUrl: optionalApiBaseUrl() },
    );
  }
  return messages(request, params.id);
}
