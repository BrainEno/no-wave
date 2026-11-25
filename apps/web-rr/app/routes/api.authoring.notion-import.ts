import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleAuthoringNotionImportRequest } from "@no-wave/web-http";
import { apiProxyConfig } from "../lib/runtime.ts";

/**
 * `POST /api/authoring/notion-import` — resource route, no component.
 *
 * Only the `action` performs an import; the loader rejects reads so browser
 * prefetches cannot start one. The dry run travels the same route as
 * the write on purpose — the only difference is the `apply` flag in the body, so
 * the plan an author reads came from the same code path as the write they confirm.
 */
export async function action({ request }: ActionFunctionArgs) {
  return handleAuthoringNotionImportRequest(request, apiProxyConfig());
}

/**
 * A `loader` that answers every read with the handler's own `405`.
 *
 * Without it React Router answers a `GET` with its generic error, which is both
 * less accurate than "only POST is supported" and indistinguishable from a crash
 * in a client that probes the route. It calls the same handler, so the method
 * check lives in exactly one place.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  return handleAuthoringNotionImportRequest(request, apiProxyConfig());
}
