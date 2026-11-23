import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleSiteFeedRequest } from "../lib/site-feed-response.server.ts";
import { localeFor } from "../lib/locale.ts";
import { publicContentSource, siteUrl } from "../lib/runtime.ts";

/** A resource route: the public newest-works feed, never a client navigation. */
function respond(request: Request, url: URL) {
  const format = url.pathname.endsWith("/feed.atom") ? "atom" : url.pathname.endsWith("/feed.xml") ? "xml" : undefined;
  return handleSiteFeedRequest(request, { format, locale: localeFor(url), siteUrl: siteUrl() }, () => publicContentSource(request));
}

export function loader({ request, url }: LoaderFunctionArgs) {
  return respond(request, url);
}

export function action({ request, url }: ActionFunctionArgs) {
  return respond(request, url);
}
