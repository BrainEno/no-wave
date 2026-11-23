import { articleReadingPreview } from "./article-reading.ts";
import type { ArticleListPageInput, ContentPersistencePort, StoredArticle } from "./persistence-ports.ts";

/**
 * Derives the readable word count (English) or character count (CJK)
 * for an article using canonical reading preview rules.
 */
export function getArticleWordCount(
  article: Pick<StoredArticle, "contentBlocks" | "locale"> & { readingPreview?: { length: number } },
): number {
  if (article.readingPreview && typeof article.readingPreview.length === "number") {
    return article.readingPreview.length;
  }
  try {
    return articleReadingPreview(article.contentBlocks, article.locale).length;
  } catch {
    return 0;
  }
}

/**
 * Ranks published articles by word count descending (longest first).
 * Ties are broken by publishedAt descending (most recent first), then by id descending.
 * Does not mutate the source array.
 */
export function rankArticlesByWordCount(articles: readonly StoredArticle[]): StoredArticle[] {
  return [...articles].sort((a, b) => {
    const lenA = getArticleWordCount(a);
    const lenB = getArticleWordCount(b);
    if (lenB !== lenA) {
      return lenB - lenA;
    }
    const timeA = a.publishedAt ? Date.parse(a.publishedAt) : 0;
    const timeB = b.publishedAt ? Date.parse(b.publishedAt) : 0;
    if (timeB !== timeA) {
      return timeB - timeA;
    }
    return b.id.localeCompare(a.id);
  });
}

/** Max candidate articles scanned across the published catalogue when computing the default shelf. */
export const DEFAULT_FEATURED_CANDIDATE_SCAN_LIMIT = 500;

/** Batch size when walking published articles for default featured candidate selection. */
export const DEFAULT_FEATURED_BATCH_SIZE = 100;

/**
 * Collects published candidate articles for the default featured algorithm.
 */
export async function selectDefaultFeaturedCandidates(
  contentPort: Pick<ContentPersistencePort, "listPublishedArticles">,
  input?: ArticleListPageInput,
): Promise<StoredArticle[]> {
  if (typeof contentPort.listPublishedArticles !== "function") {
    return [];
  }
  const locale = input?.locale ?? "zh-CN";
  const candidates: StoredArticle[] = [];
  let scanOffset = 0;
  while (scanOffset < DEFAULT_FEATURED_CANDIDATE_SCAN_LIMIT) {
    if (input?.signal?.aborted) break;
    const batch = await contentPort.listPublishedArticles({
      locale,
      limit: DEFAULT_FEATURED_BATCH_SIZE,
      offset: scanOffset,
      sort: "latest",
      projection: input?.projection,
      signal: input?.signal,
    });
    candidates.push(...batch);
    if (batch.length < DEFAULT_FEATURED_BATCH_SIZE) break;
    scanOffset += batch.length;
  }
  return candidates;
}

/**
 * Resolves the featured shelf:
 * 1. An editor-curated shelf takes precedence and is returned directly.
 * 2. If no editor has chosen featured works (or the shelf is empty), falls
 *    back to the default algorithm: published works ordered by word count descending.
 */
export async function resolveFeaturedArticles(
  contentPort: Pick<ContentPersistencePort, "listFeaturedArticles" | "listPublishedArticles">,
  input?: ArticleListPageInput,
): Promise<StoredArticle[]> {
  const locale = input?.locale ?? "zh-CN";
  const limit = Math.max(1, input?.limit ?? 20);
  const offset = Math.max(0, input?.offset ?? 0);

  const curated = await contentPort.listFeaturedArticles(input);
  if (curated.length > 0) {
    return curated;
  }

  // When offset > 0, check if offset 0 had curated items. If so, the curated shelf
  // exists and the caller simply paged past its end.
  if (offset > 0) {
    const probe = await contentPort.listFeaturedArticles({ locale, limit: 1, offset: 0 });
    if (probe.length > 0) {
      return [];
    }
  }

  // No editor-curated articles exist on the shelf: fall back to the default algorithm.
  const candidates = await selectDefaultFeaturedCandidates(contentPort, input);
  const ranked = rankArticlesByWordCount(candidates);
  return ranked.slice(offset, offset + limit);
}
