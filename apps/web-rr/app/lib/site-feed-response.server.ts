import type { Locale } from "../../../../packages/web-ui/src/lib/content.ts";
import type { PublicContentSource } from "../../../../packages/web-ui/src/lib/api-content.ts";
import { parseFeedFormat } from "../../../../packages/web-ui/src/lib/article-feed.ts";
import { loadSiteFeedArticles, renderSiteFeed, siteFeedPath } from "../../../../packages/web-ui/src/lib/site-feed.ts";
import { feedFailure, respondWithFeed } from "./feed-response.server.ts";

type SiteFeedOptions = { format?: string; locale: Locale; siteUrl: string };

/** `/articles/feed.atom` and `/articles/feed.xml`: the newest public works, same contract as a tag feed. */
export async function handleSiteFeedRequest(request: Request, options: SiteFeedOptions, source: () => Pick<PublicContentSource, "listPublicArticles">): Promise<Response> {
  const noun = "Feed";
  if (request.method !== "GET" && request.method !== "HEAD") return feedFailure(request, 405, noun);
  const format = parseFeedFormat(options.format);
  if (!format) return feedFailure(request, 404, noun);
  return respondWithFeed(request, {
    noun, canonicalPath: siteFeedPath(options.locale, format),
    render: async () => renderSiteFeed({ articles: await loadSiteFeedArticles(options.locale, source()), locale: options.locale, siteUrl: options.siteUrl, format }),
  });
}
