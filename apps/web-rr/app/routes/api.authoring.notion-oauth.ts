import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleAuthoringNotionOAuthRequest } from "@bot-thk/web-http";
import { apiProxyConfig } from "../lib/runtime.ts";

/**
 * `GET /api/authoring/notion-oauth` — resource route, no component (ADR 0053):
 * whether this instance offers 「用 Notion 授权」. Writes get the handler's `405`.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  return handleAuthoringNotionOAuthRequest(request, "status", apiProxyConfig());
}

export async function action({ request }: ActionFunctionArgs) {
  return handleAuthoringNotionOAuthRequest(request, "status", apiProxyConfig());
}
