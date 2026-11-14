import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleCrawlRequest } from "../lib/crawl-response.server.ts";
import { siteUrl } from "../lib/runtime.ts";

/** One bounded, anonymous public sitemap, with shared GET/HEAD/cache/error semantics. */
export function loader({ request }: LoaderFunctionArgs) {
  return handleCrawlRequest(request, "sitemap", { siteUrl });
}

export function action({ request }: ActionFunctionArgs) {
  return handleCrawlRequest(request, "sitemap", { siteUrl });
}
