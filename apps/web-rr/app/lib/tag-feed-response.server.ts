import type { Locale } from "../../../../packages/web-ui/src/lib/content.ts";
import { isTagSlug } from "../../../../packages/web-ui/src/lib/tag-discovery.ts";
import { loadTagDetailPage, type TagPageSource } from "../../../../packages/web-ui/src/lib/tag-pages.ts";
import { parseTagFeedFormat, renderTagFeed, tagFeedPath } from "../../../../packages/web-ui/src/lib/tag-feed.ts";
import { feedFailure, respondWithFeed } from "./feed-response.server.ts";

export { matchesResourceEtag as matchesFeedEtag } from "./resource-etag.server.ts";

type FeedOptions = { slug?: string; format?: string; locale: Locale; siteUrl: string };

/** No viewer/session read and no process-local cache. The anonymous API owns visibility. */
export async function handleTagFeedRequest(request: Request, options: FeedOptions, source?: TagPageSource | (() => TagPageSource)): Promise<Response> {
  const noun = "Tag feed";
  if (request.method !== "GET" && request.method !== "HEAD") return feedFailure(request, 405, noun);
  const format = parseTagFeedFormat(options.format);
  const slug = options.slug;
  if (!isTagSlug(slug) || !format) return feedFailure(request, 404, noun);
  return respondWithFeed(request, {
    noun, canonicalPath: tagFeedPath(slug, options.locale, format),
    render: async () => {
      const loaded = await loadTagDetailPage({ locale: options.locale, slug, page: 1 }, typeof source === "function" ? source() : source);
      return loaded.tag ? renderTagFeed({ ...loaded, tag: loaded.tag, siteUrl: options.siteUrl, format }) : null;
    },
  });
}
