import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleAuthoringNotionFetchRequest } from "@no-wave/web-http";
import { apiProxyConfig } from "../lib/runtime.ts";

/**
 * `POST /api/authoring/notion-fetch` — resource route, no component (ADR 0052).
 *
 * The body carries the author's Notion token, so only the `action` forwards it;
 * the loader answers reads with the handler's own `405` so a prefetch or a probe
 * never starts a pull and never sees anything but "only POST is supported".
 */
export async function action({ request }: ActionFunctionArgs) {
  return handleAuthoringNotionFetchRequest(request, apiProxyConfig());
}

/** Every read gets the handler's `405`; the method check lives in one place. */
export async function loader({ request }: LoaderFunctionArgs) {
  return handleAuthoringNotionFetchRequest(request, apiProxyConfig());
}
