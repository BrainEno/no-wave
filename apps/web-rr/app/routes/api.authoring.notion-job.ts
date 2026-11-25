import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleNotionJobRequest } from "@no-wave/web-http";
import { apiProxyConfig } from "../lib/runtime.ts";

export function loader({ request, params }: LoaderFunctionArgs) {
  return handleNotionJobRequest(request, { id: params.id ?? "" }, apiProxyConfig());
}
export function action({ request, params }: ActionFunctionArgs) {
  return handleNotionJobRequest(request, { id: params.id ?? "" }, apiProxyConfig());
}
