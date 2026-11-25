import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleNotionJobsRequest } from "@no-wave/web-http";
import { apiProxyConfig } from "../lib/runtime.ts";

export function loader({ request }: LoaderFunctionArgs) {
  return handleNotionJobsRequest(request, apiProxyConfig());
}
export function action({ request }: ActionFunctionArgs) {
  return handleNotionJobsRequest(request, apiProxyConfig());
}
