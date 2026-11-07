import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleConversationReadRequest } from "@bot-thk/web-http";
import { apiProxyConfig } from "../lib/runtime.ts";

/** Both aliases use the shared method, Origin and ID checks. */
function markRead(request: Request, id: string | undefined) {
  return handleConversationReadRequest(request, { conversationId: id ?? "" }, apiProxyConfig());
}

export function loader({ request, params }: LoaderFunctionArgs) {
  return markRead(request, params.id);
}

export function action({ request, params }: ActionFunctionArgs) {
  return markRead(request, params.id);
}
