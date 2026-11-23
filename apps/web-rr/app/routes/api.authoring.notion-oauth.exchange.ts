import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleAuthoringNotionOAuthRequest } from "@bot-thk/web-http";
import { apiProxyConfig } from "../lib/runtime.ts";

/**
 * `POST /api/authoring/notion-oauth/exchange` — resource route, no component (ADR 0053).
 * Only the `action` forwards; reads get the handler's `405`, so a prefetch or a
 * probe never starts or finishes an authorization.
 */
export async function action({ request }: ActionFunctionArgs) {
  return handleAuthoringNotionOAuthRequest(request, "exchange", apiProxyConfig());
}

export async function loader({ request }: LoaderFunctionArgs) {
  return handleAuthoringNotionOAuthRequest(request, "exchange", apiProxyConfig());
}
