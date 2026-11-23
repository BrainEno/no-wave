import { archivePath, getMessages, type ArticleView, type Locale } from "./content.ts";
import type { PublicContentSource } from "./api-content.ts";
import { feedButtonLabel, feedFileName, feedMimeTypes, renderArticleFeed, type FeedFormat } from "./article-feed.ts";

/**
 * The site-wide feed: the newest published works in one locale.
 *
 * It lives under the archive (`/articles/feed.atom`, `/articles/feed.xml`) for
 * the same reason a tag's feed lives under the tag: the HTML page it mirrors is
 * the archive, and `/feed` is already the signed-in reader's private following
 * feed — a public subscription next to a private page of the same name would
 * read as the same thing.
 *
 * Same size as a tag feed and the archive's first page. A feed is a "what is
 * new" signal, not a backlog: readers poll it, and every poll is one bounded
 * anonymous API read.
 */
export const SITE_FEED_LIMIT = 20;

export function siteFeedPath(locale: Locale, format: FeedFormat): string {
  return `${archivePath(locale)}/${feedFileName(format)}`;
}

export function siteFeedLinks(locale: Locale) {
  return (["atom", "rss"] as const).map((format) => ({
    href: siteFeedPath(locale, format), type: feedMimeTypes[format],
    // `title` names the feed in the head's alternate link; `label` is the
    // visible button, worded like a tag page's.
    title: `${locale === "en" ? "No Wave: latest writing" : "无浪潮：最新作品"} (${format === "atom" ? "Atom" : "RSS"})`,
    label: feedButtonLabel(locale, format),
  }));
}

export type SiteFeedInput = { articles: readonly ArticleView[]; locale: Locale; siteUrl: string; format: FeedFormat };

export function renderSiteFeed({ articles, locale, siteUrl, format }: SiteFeedInput) {
  const labels = getMessages(locale).workTypeLabels;
  return renderArticleFeed({
    articles, locale, siteUrl, format, limit: SITE_FEED_LIMIT,
    title: locale === "en" ? "No Wave: latest writing" : "无浪潮：最新作品",
    subtitle: locale === "en" ? "The newest fiction, poetry and other writing published on No Wave." : "无浪潮最近发表的小说、诗歌与其他文体作品。",
    alternatePath: archivePath(locale), selfPath: siteFeedPath(locale, format),
    // The genre (ADR 0054) is the one classification every work has.
    category: (article) => labels[article.workType],
  });
}

/** One anonymous read; a failure propagates so the route can answer 503, never an empty feed. */
export async function loadSiteFeedArticles(locale: Locale, source: Pick<PublicContentSource, "listPublicArticles">): Promise<ArticleView[]> {
  return source.listPublicArticles({ locale, sort: "latest", limit: SITE_FEED_LIMIT });
}
