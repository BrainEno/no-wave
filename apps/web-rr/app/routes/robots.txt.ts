import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleCrawlRequest } from "../lib/crawl-response.server.ts";
import { siteUrl } from "../lib/runtime.ts";

/** No API read: crawler policy remains available during a catalog outage. */
export function loader({ request }: LoaderFunctionArgs) {
  return handleCrawlRequest(request, "robots", { siteUrl });
}

export function action({ request }: ActionFunctionArgs) {
  return handleCrawlRequest(request, "robots", { siteUrl });
}
