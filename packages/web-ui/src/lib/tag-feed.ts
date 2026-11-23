import type { ArticleView, Locale } from "./content.ts";
import { tagPath, TAG_PAGE_SIZE, type TagView } from "./tag-discovery.ts";
import { feedButtonLabel, feedFileName, feedMimeTypes, parseFeedFormat, renderArticleFeed, type FeedFormat } from "./article-feed.ts";

export type TagFeedFormat = FeedFormat;
export type TagFeedInput = { tag: TagView; articles: readonly ArticleView[]; locale: Locale; siteUrl: string; format: TagFeedFormat };
export const TAG_FEED_LIMIT = TAG_PAGE_SIZE;

export const parseTagFeedFormat = parseFeedFormat;

export function tagFeedPath(slug: string, locale: Locale, format: TagFeedFormat): string {
  return `${tagPath(slug, locale)}/${feedFileName(format)}`;
}

export function tagFeedLinks(slug: string, locale: Locale) {
  return (["atom", "rss"] as const).map((format) => ({
    href: tagFeedPath(slug, locale, format), type: feedMimeTypes[format],
    title: feedButtonLabel(locale, format),
  }));
}

/** A bounded projection of an already anonymous, published, locale-specific API page. */
export function renderTagFeed({ tag, articles, locale, siteUrl, format }: TagFeedInput) {
  if (tag.locale !== locale) throw new Error("Inconsistent tag feed locale.");
  if (!tag.name.trim()) throw new Error("Invalid required feed metadata.");
  return renderArticleFeed({
    articles, locale, siteUrl, format, limit: TAG_FEED_LIMIT,
    title: `#${tag.name} | ${locale === "en" ? "No Wave" : "无浪潮"}`,
    subtitle: tag.description || (locale === "en" ? "Recent published writing under this tag." : "这个标签下最近发表的作品。"),
    alternatePath: tagPath(tag.slug, locale), selfPath: tagFeedPath(tag.slug, locale, format),
    category: () => tag.name,
  });
}
