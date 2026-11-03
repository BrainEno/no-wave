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

/** What one work's list entry needs from persistence, prefetched. */
type ArticlePageContext = {
  authors: Map<string, any>;
  taxonomies: Map<string, { categories: any[]; tags: any[] }>;
};

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
  return presentArticle(article, author, categoriesResult, tagsResult);
}

/**
 * A page of works, at a fixed cost (issue #162).
 *
 * It used to be `Promise.all` over `serializeRestArticle`, and each element asked
 * persistence three questions of its own: the author's profile (which itself ran
 * four correlated subqueries, so a page of twenty works by five authors counted
 * the same follower totals twenty times), the categories, and the tags. A page of
 * fifty works was 151 statements — on SQLite, 151 synchronous statements on the
 * request thread.
 *
 * Now the page is asked about as a page: one query for the distinct authors, one
 * per taxonomy kind, and everything else is a `Map` lookup. The *output* is
 * unchanged, which is the point of doing it here rather than in the routes: the
 * JSON a reader sees cannot depend on how many queries produced it.
 *
 * An empty page asks nothing at all.
 */
export async function serializeRestArticles(
  services: RestServices,
  articles: unknown,
  viewerId: string | null,
): Promise<unknown[]> {
  if (!Array.isArray(articles) || articles.length === 0) return [];
  const localeOf = (article: any) => (typeof article?.locale === "string" ? article.locale : "zh-CN");
  // A page can mix locales (a feed, a search across one language only today, but
  // the serializer cannot assume it), so the batch is keyed by locale too.
  const localeGroups = new Map<string, any[]>();
  for (const article of articles) {
    const locale = localeOf(article);
    const group = localeGroups.get(locale) ?? [];
    group.push(article);
    localeGroups.set(locale, group);
  }

  const contexts = new Map<string, ArticlePageContext>();
  await Promise.all([...localeGroups].map(async ([locale, group]) => {
    const authorIds = [...new Set(group.map((article) => article?.authorId).filter((id): id is string => typeof id === "string" && id.length > 0))];
    const articleIds = [...new Set(group.map((article) => article?.id).filter((id): id is string => typeof id === "string" && id.length > 0))];
    const [authors, taxonomies] = await Promise.all([
      authorIds.length === 0
        ? Promise.resolve(new Map<string, any>())
        : services.getAuthorProfilesByIds({ userIds: authorIds, locale, viewerId }),
      articleIds.length === 0
        ? Promise.resolve(new Map<string, { categories: any[]; tags: any[] }>())
        : services.listArticlesTaxonomies({ articleIds, locale }),
    ]);
    contexts.set(locale, { authors: authors ?? new Map(), taxonomies: taxonomies ?? new Map() });
  }));

  return articles.map((article) => {
    if (!article || typeof article !== "object") return article;
    const context = contexts.get(localeOf(article));
    const author = typeof article.authorId === "string" ? context?.authors.get(article.authorId) ?? null : null;
    const taxonomies = typeof article.id === "string" ? context?.taxonomies.get(article.id) : undefined;
    return presentArticle(article, author, taxonomies?.categories ?? [], taxonomies?.tags ?? []);
  });
}

/**
 * The one place a work's JSON shape is written down.
 *
 * Both the single-work and the page path go through it, so a field cannot appear
 * on `/articles/:slug` and be missing from `/articles`. `contentBlocks` stays a
 * JSON array rather than a JSON-encoded string: the GraphQL contract is behind
 * us, and the REST contract is what clients read now.
 */
function presentArticle(article: any, author: any, categoriesResult: any, tagsResult: any): any {
  return {
    ...article,
    author: author ?? null,
    categories: Array.isArray(categoriesResult) ? categoriesResult : [],
    tags: Array.isArray(tagsResult) ? tagsResult : [],
  };
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
 * makes an HTTP round trip to GraphQL or reaches into persistence adapters.
 */
