import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleTagFeedRequest } from "../lib/tag-feed-response.server.ts";
import { localeFor } from "../lib/locale.ts";
import { siteUrl } from "../lib/runtime.ts";

/** A resource route, not a client navigation or an authenticated notification feed. */
export function loader({ request, params, url }: LoaderFunctionArgs) {
  return handleTagFeedRequest(request, { slug: params.slug, format: params.feed === "feed.atom" ? "atom" : params.feed === "feed.xml" ? "xml" : undefined, locale: localeFor(url), siteUrl: siteUrl() });
}

export function action({ request, params, url }: ActionFunctionArgs) {
  return handleTagFeedRequest(request, { slug: params.slug, format: params.feed === "feed.atom" ? "atom" : params.feed === "feed.xml" ? "xml" : undefined, locale: localeFor(url), siteUrl: siteUrl() });
}
