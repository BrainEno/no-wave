import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleMediaDeleteRequest, handleMediaLibraryRequest, handleMediaUploadRequest } from "@bot-thk/web-http";
import { apiProxyConfig } from "../lib/runtime.ts";

/**
 * Authenticated image traffic (`POST` upload, `GET` library, on
 * `/api/authoring/media`).
 *
 * The access token is an HttpOnly cookie, so the browser cannot reach the API
 * itself; the shared adapters forward with the token attached server side, after
 * enforcing the Origin check, content-type allow-list and size ceiling.
 */

/** `POST` — an upload. */
export async function action({ request }: ActionFunctionArgs) {
  return handleMediaUploadRequest(request, apiProxyConfig());
}

/**
 * `GET` — the author's own media library (ADR 0022).
 *
 * A read, so it is a loader rather than an action: the same path is the
 * collection, and which of the two a request means is the method's to say.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  return handleMediaLibraryRequest(request, apiProxyConfig());
}
