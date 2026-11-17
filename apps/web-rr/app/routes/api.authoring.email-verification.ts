import type { ActionFunctionArgs } from "react-router";
import { handleAccountEmailVerificationRequest } from "@bot-thk/web-http";
import { apiProxyConfig } from "../lib/runtime.ts";

/**
 * `POST /api/authoring/email-verification` — resource route, no component.
 *
 * Asking for a verification mail is a write, so the Origin check applies; which
 * address is mailed is the API's decision, taken from the session, so the route
 * takes no input at all.
 */
export async function action({ request }: ActionFunctionArgs) {
  return handleAccountEmailVerificationRequest(request, apiProxyConfig());
}
