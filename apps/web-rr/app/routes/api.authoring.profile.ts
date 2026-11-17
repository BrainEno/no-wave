import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleAuthoringProfileRequest } from "@bot-thk/web-http";
import { apiProxyConfig } from "../lib/runtime.ts";

/** `GET`/`PUT /api/authoring/profile` — resource route, no component. */
export async function loader({ request }: LoaderFunctionArgs) {
  return handleAuthoringProfileRequest(request, apiProxyConfig());
}

export async function action({ request }: ActionFunctionArgs) {
  return handleAuthoringProfileRequest(request, apiProxyConfig());
}
