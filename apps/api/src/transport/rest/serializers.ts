import type { IncomingMessage, ServerResponse } from "node:http";
import { type RestServices } from "./http.ts";

export function serializeRestNotification(notification: any): any {
  if (!notification || typeof notification !== "object") return null;
  // Match the GraphQL Notification contract; do not leak persistence-only userId.
  return {
    id: notification.id,
    eventKey: notification.eventKey,
    payload: JSON.stringify(notification.payload),
    createdAt: notification.createdAt,
    readAt: notification.readAt ?? null,
  };
}

export async function serializeRestArticle(
  services: RestServices,
  article: any,
  viewerId: string | null,
): Promise<any> {
  if (!article || typeof article !== "object") return article;
  const locale = typeof article.locale === "string" ? article.locale : "zh-CN";
  const [author, categoriesResult, tagsResult] = await Promise.all([
    article.authorId
      ? services.getAuthorProfile({ userId: article.authorId, locale, viewerId })
      : Promise.resolve(null),
    article.id
      ? services.listArticleTaxonomies({ articleId: article.id, kind: "category", locale })
      : Promise.resolve([]),
    article.id
      ? services.listArticleTaxonomies({ articleId: article.id, kind: "tag", locale })
      : Promise.resolve([]),
  ]);
  // Match the GraphQL Article contract fields. REST intentionally represents
  // contentBlocks as a JSON array rather than a JSON-encoded GraphQL string.
  return {
    ...article,
    author: author ?? null,
    categories: Array.isArray(categoriesResult) ? categoriesResult : [],
    tags: Array.isArray(tagsResult) ? tagsResult : [],
  };
}

/**
 * Attach author and taxonomy projections to a page of articles (#162).
 *
 * The old shape called `serializeRestArticle` per item, and that function asks
 * three questions per article: who wrote it, what categories it has, what tags
 * it has. A page of 100 therefore issued 301 statements — and because the SQLite
 * driver is synchronous, every one of them blocked the event loop. Worse, the
 * questions are not independent per article: a site with three authors names
 * each of them dozens of times per page, so the same follower counts were
 * recomputed dozens of times.
 *
 * This prefetches instead: one statement for the distinct authors, one for the
 * category links across the page, one for the tags. The total is three
 * statements at any page size, and the per-article assembly below is pure
 * in-memory work.
 *
 * Output is unchanged, deliberately: the same keys, the same `null` author for
 * an article whose author profile is missing, the same empty arrays, and the
 * same ordering inside each taxonomy list (`listArticlesTaxonomies` orders by
 * name then id, exactly as the per-article call did).
 */
export async function serializeRestArticles(
  services: RestServices,
  articles: unknown,
  viewerId: string | null,
): Promise<unknown[]> {
  if (!Array.isArray(articles) || articles.length === 0) return [];
  // Non-objects are passed through untouched, as the per-article path did.
  const objects = articles.filter((article) => article && typeof article === "object");
  if (objects.length === 0) return articles.map((article) => article);

  const locales = new Map(objects.map((article: any) => [article, typeof article.locale === "string" ? article.locale : "zh-CN"]));
  // One author-locale pair per distinct (author, locale): the profile carries the
  // locale it was rendered in, so an author appearing in two locale lists needs
  // two answers.
  const authorIds = [...new Set(objects.map((article: any) => article.authorId).filter(Boolean))];
  const articleIds = [...new Set(objects.map((article: any) => article.id).filter(Boolean))];
  const localesUsed = [...new Set(locales.values())];

  const [profilesByLocale, categoriesByLocale, tagsByLocale] = await Promise.all([
    Promise.all(localesUsed.map((locale) =>
      authorIds.length === 0
        ? Promise.resolve({} as Record<string, any>)
        : Promise.resolve(services.getAuthorProfilesByIds({ userIds: authorIds, locale, viewerId })))),
    Promise.all(localesUsed.map((locale) =>
      articleIds.length === 0
        ? Promise.resolve({} as Record<string, any[]>)
        : Promise.resolve(services.listArticlesTaxonomies({ articleIds, kind: "category", locale })))),
    Promise.all(localesUsed.map((locale) =>
      articleIds.length === 0
        ? Promise.resolve({} as Record<string, any[]>)
        : Promise.resolve(services.listArticlesTaxonomies({ articleIds, kind: "tag", locale })))),
  ]);
  const byLocale = <T>(results: T[]) => new Map(localesUsed.map((locale, index) => [locale, results[index]]));
  const profiles = byLocale(profilesByLocale);
  const categories = byLocale(categoriesByLocale);
  const tags = byLocale(tagsByLocale);

  const assembled = new Map<unknown, any>();
  for (const article of objects as any[]) {
    const locale = locales.get(article)!;
    const author = article.authorId ? profiles.get(locale)?.[article.authorId] ?? null : null;
    assembled.set(article, {
      ...article,
      author,
      categories: article.id ? categories.get(locale)?.[article.id] ?? [] : [],
      tags: article.id ? tags.get(locale)?.[article.id] ?? [] : [],
    });
  }
  return articles.map((article) => assembled.get(article) ?? article);
}

export async function serializeRestComment(
  services: RestServices,
  comment: any,
  viewerId: string | null,
): Promise<any> {
  if (!comment || typeof comment !== "object") return comment;
  const author = comment.authorId
    ? await services.getAuthorProfile({
        userId: comment.authorId,
        locale: typeof comment.locale === "string" ? comment.locale : "zh-CN",
        viewerId,
      })
    : null;
  const replies = Array.isArray(comment.replies) ? comment.replies : [];
  return {
    ...comment,
    author: author ?? null,
    replies: await Promise.all(replies.map((reply) => serializeRestComment(services, reply, viewerId))),
  };
}

export async function serializeRestComments(
  services: RestServices,
  comments: unknown,
  viewerId: string | null,
): Promise<unknown[]> {
  if (!Array.isArray(comments)) return [];
  return Promise.all(comments.map((comment) => serializeRestComment(services, comment, viewerId)));
}

/**
 * REST transport adapter. It calls application services directly; it never
 * makes an HTTP round-trip to GraphQL or reaches into persistence adapters.
 */
