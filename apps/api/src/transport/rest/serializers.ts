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

export async function serializeRestArticles(
  services: RestServices,
  articles: unknown,
  viewerId: string | null,
): Promise<unknown[]> {
  if (!Array.isArray(articles)) return [];
  return Promise.all(articles.map((article) => serializeRestArticle(services, article, viewerId)));
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
