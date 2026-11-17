import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleAccountOtherSessionsEndRequest, handleAccountSessionsRequest } from "@bot-thk/web-http";
import { apiProxyConfig } from "../lib/runtime.ts";

/**
 * `GET /api/authoring/sessions` — resource route, no component.
 *
 * A read: listing your own devices needs no Origin check, and the identity is
 * the session cookie the proxy attaches. `DELETE` on the same path ends every
 * *other* device, so it is gated as a write is.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  return handleAccountSessionsRequest(request, apiProxyConfig());
}

export async function action({ request }: ActionFunctionArgs) {
  return handleAccountOtherSessionsEndRequest(request, apiProxyConfig());
}
