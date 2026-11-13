import type { ArticleView, Locale } from "./content.ts";
import { getPublicTag, listPublicTagArticles, listPublicTags, type TagListOptions } from "./api-content.ts";
import { isTagSlug, tagPage, tagSearchQuery, TAG_MAX_PAGE, TAG_PAGE_SIZE, type TagView } from "./tag-discovery.ts";

/** Small read-only seam. Tests can verify budgets without mutating process.env or fetch. */
export type TagPageSource = {
  listTags(options: TagListOptions): Promise<TagView[]>;
  getTag(slug: string, locale: Locale): Promise<TagView | null>;
  listArticles(slug: string, locale: Locale, limit: number, offset: number): Promise<ArticleView[] | null>;
};
const publicSource: TagPageSource = { listTags: listPublicTags, getTag: getPublicTag, listArticles: listPublicTagArticles };

export type TagIndexData = {
  locale: Locale;
  query: string;
  page: number;
  tags: TagView[];
  hasNextPage: boolean;
};
export type TagDetailData = {
  locale: Locale;
  page: number;
  tag: TagView | null;
  articles: ArticleView[];
  hasNextPage: boolean;
};

export async function loadTagIndexPage(
  options: { locale: Locale; query?: string; page?: number }, source: TagPageSource = publicSource,
): Promise<TagIndexData> {
  const { locale } = options;
  const query = tagSearchQuery(options.query ?? "");
  const page = tagPage(options.page);
  // One extra row answers "next?" without a count request or loading every tag.
  const results = await source.listTags({ locale, query, limit: TAG_PAGE_SIZE + 1, offset: (page - 1) * TAG_PAGE_SIZE });
  return { locale, query, page, tags: results.slice(0, TAG_PAGE_SIZE), hasNextPage: page < TAG_MAX_PAGE && results.length > TAG_PAGE_SIZE };
}

export async function loadTagDetailPage(
  options: { locale: Locale; slug: string; page?: number }, source: TagPageSource = publicSource,
): Promise<TagDetailData> {
  const { locale, slug } = options;
  const page = tagPage(options.page);
  const missing: TagDetailData = { locale, page, tag: null, articles: [], hasNextPage: false };
  if (!isTagSlug(slug)) return missing;
  const tag = await source.getTag(slug, locale);
  if (!tag) return missing;
  // The second read only starts once the identity exists. An absent tag is one
  // request, and a removal between these two reads remains a genuine 404.
  const results = await source.listArticles(slug, locale, TAG_PAGE_SIZE + 1, (page - 1) * TAG_PAGE_SIZE);
  if (results === null) return missing;
  return { locale, page, tag, articles: results.slice(0, TAG_PAGE_SIZE), hasNextPage: page < TAG_MAX_PAGE && results.length > TAG_PAGE_SIZE };
}
