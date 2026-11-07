import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleConversationRequest } from "@bot-thk/web-http";
import { apiProxyConfig } from "../lib/runtime.ts";

/**
 * `GET /api/inbox/:id` — one conversation's header.
 *
 * Participants, unread count and last message. The API answers `404` for both
 * "no such conversation" and "not a member", and that is forwarded as-is:
 * membership should not be discoverable by guessing ids.
 */
function conversation(request: Request, id: string | undefined) {
  return handleConversationRequest(
    request,
    { conversationId: id ?? "" },
    apiProxyConfig(),
  );
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  return conversation(request, params.id);
}

export async function action({ request, params }: ActionFunctionArgs) {
  return conversation(request, params.id);
}
