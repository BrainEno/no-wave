import type { ActionFunctionArgs } from "react-router";
import { handleAuthRequest } from "../lib/auth-proxy.ts";

/**
 * Resource route adapter: the entire behavior lives in the framework-neutral
 * `handleAuthRequest`, so this file stays a one-liner and the handler is testable
 * (and later reusable) without React Router.
 */
export async function action({ request, params }: ActionFunctionArgs) {
  return handleAuthRequest(request, params.action);
}

export async function loader() {
  return new Response(JSON.stringify({ error: { code: "METHOD_NOT_ALLOWED", message: "Use POST." } }), {
    status: 405,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", allow: "POST" },
  });
}
