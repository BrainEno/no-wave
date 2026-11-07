import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  NotificationRecord,
  StoredArticleComment,
  StoredAuthorProfile,
  StoredTaxonomy,
} from "../../application/persistence-ports.ts";
import { type RestServices } from "./http.ts";

/**
 * The REST response projections.
 *
 * These four functions used to be typed `any` in and `any` out, which meant the
 * one place every response shape is decided was the one place `tsc` could not
 * look: renaming a stored field, or reading `article.authors` instead of
 * `article.author`, compiled cleanly and produced JSON with a hole in it. The
 * types below are derived from the persistence contracts on purpose — the
 * projection cannot drift from the row it projects without a compile error.
 *
 * The runtime tolerance stays, because it is a contract, not sloppiness: a
 * non-object in a list is passed through untouched rather than dropped (the
 * serializer is a pass-through for things it does not understand), and a
 * notification-shaped value that is not an object answers `null`. Each function
 * therefore has two signatures — the typed one a route gets, and the tolerant one
 * a test or a caller holding `unknown` gets.
 */

/** What a serialized article gains over the row that was read. */
export type RestArticleProjection = {
  author: StoredAuthorProfile | null;
  categories: StoredTaxonomy[];
  tags: StoredTaxonomy[];
};

export type SerializedRestComment<C> = Omit<C, "replies"> & {
  author: StoredAuthorProfile | null;
  replies: SerializedRestComment<StoredArticleComment>[];
};

/** The notification contract the GraphQL-era client expects; `userId` stays out. */
export type SerializedRestNotification = {
  id: string;
  eventKey: string;
  payload: string;
  createdAt: string;
  readAt: string | null;
};

/** The fields this module reads off a stored article. */
type ArticleLike = { id?: unknown; authorId?: unknown; locale?: unknown };
/** The fields this module reads off a stored comment. */
type CommentLike = { authorId?: unknown; locale?: unknown; replies?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArticleLike(value: unknown): value is ArticleLike {
  return isRecord(value);
}

function localeOf(value: { locale?: unknown }): string {
  return typeof value.locale === "string" ? value.locale : "zh-CN";
}

export function serializeRestNotification(notification: NotificationRecord): SerializedRestNotification;
export function serializeRestNotification(notification: unknown): SerializedRestNotification | null;
export function serializeRestNotification(notification: unknown): SerializedRestNotification | null {
  if (!isRecord(notification)) return null;
  // The guard above is the whole contract: the row came from the notification
  // store, and the previous version trusted it just as much — it simply had no
  // type to trust it with.
  const record = notification as NotificationRecord;
  // Match the GraphQL Notification contract; do not leak persistence-only userId.
  return {
    id: record.id,
    eventKey: record.eventKey,
    payload: JSON.stringify(record.payload),
    createdAt: record.createdAt,
    readAt: record.readAt ?? null,
  };
}

/**
 * One article's projection — a detail route: create, update, publish, or a
 * single work's page.
 *
 * Deliberately a one-item call to {@link serializeRestArticles} rather than its
 * own query path. There used to be two implementations, and the list one was
 * quietly the slow one: three queries per article, 301 statements for a page of
 * 100 (#162). Keeping a second, hand-written single path would leave the same
 * trap for the next person who loops over it in a list route — and nothing in the
 * type system would object.
 *
 * With one code path, a future list route that calls this per item costs the
 * batch path's three statements *per call*, which the statement-count test sees
 * immediately instead of a year later.
 */
export async function serializeRestArticle<A extends ArticleLike>(
  services: RestServices,
  article: A,
  viewerId: string | null,
): Promise<A & RestArticleProjection>;
export async function serializeRestArticle(
  services: RestServices,
  article: unknown,
  viewerId: string | null,
): Promise<unknown>;
export async function serializeRestArticle(
  services: RestServices,
  article: unknown,
  viewerId: string | null,
): Promise<unknown> {
  if (!isArticleLike(article)) return article;
  const [serialized] = await projectArticles(services, [article], viewerId);
  return serialized;
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
export async function serializeRestArticles<A extends ArticleLike>(
  services: RestServices,
  articles: readonly A[],
  viewerId: string | null,
): Promise<Array<A & RestArticleProjection>>;
export async function serializeRestArticles(
  services: RestServices,
  articles: unknown,
  viewerId: string | null,
): Promise<unknown[]>;
export async function serializeRestArticles(
  services: RestServices,
  articles: unknown,
  viewerId: string | null,
): Promise<unknown[]> {
  if (!Array.isArray(articles) || articles.length === 0) return [];
  const records = articles.filter(isArticleLike);
  // Non-objects are passed through untouched, as the per-article path did.
  if (records.length === 0) return articles.slice();
  const projected = await projectArticles(services, records, viewerId);
  const byRecord = new Map<unknown, unknown>(records.map((record, index) => [record, projected[index]]));
  return articles.map((article) => (isArticleLike(article) ? byRecord.get(article) ?? article : article));
}

async function projectArticles<A extends ArticleLike>(
  services: RestServices,
  records: readonly A[],
  viewerId: string | null,
): Promise<Array<A & RestArticleProjection>> {
  const locales = new Map<A, string>(records.map((record) => [record, localeOf(record)]));
  // One author-locale pair per distinct (author, locale): the profile carries the
  // locale it was rendered in, so an author appearing in two locale lists needs
  // two answers.
  const authorIds = [...new Set(records.map((record) => record.authorId).filter(isIdentifier))];
  const articleIds = [...new Set(records.map((record) => record.id).filter(isIdentifier))];
  const localesUsed = [...new Set(locales.values())];

  const [profilesByLocale, categoriesByLocale, tagsByLocale] = await Promise.all([
    Promise.all(localesUsed.map((locale) =>
      authorIds.length === 0
        ? Promise.resolve<Record<string, StoredAuthorProfile>>({})
        : Promise.resolve(services.getAuthorProfilesByIds({ userIds: authorIds, locale, viewerId })))),
    Promise.all(localesUsed.map((locale) =>
      articleIds.length === 0
        ? Promise.resolve<Record<string, StoredTaxonomy[]>>({})
        : Promise.resolve(services.listArticlesTaxonomies({ articleIds, kind: "category", locale })))),
    Promise.all(localesUsed.map((locale) =>
      articleIds.length === 0
        ? Promise.resolve<Record<string, StoredTaxonomy[]>>({})
        : Promise.resolve(services.listArticlesTaxonomies({ articleIds, kind: "tag", locale })))),
  ]);
  const byLocale = <T>(results: T[]) => new Map(localesUsed.map((locale, index) => [locale, results[index]]));
  const profiles = byLocale(profilesByLocale);
  const categories = byLocale(categoriesByLocale);
  const tags = byLocale(tagsByLocale);

  return records.map((record) => {
    const locale = locales.get(record)!;
    const authorId = typeof record.authorId === "string" ? record.authorId : null;
    const articleId = typeof record.id === "string" ? record.id : null;
    return {
      ...record,
      author: authorId ? profiles.get(locale)?.[authorId] ?? null : null,
      categories: articleId ? categories.get(locale)?.[articleId] ?? [] : [],
      tags: articleId ? tags.get(locale)?.[articleId] ?? [] : [],
    };
  });
}

export async function serializeRestComment<C extends CommentLike>(
  services: RestServices,
  comment: C,
  viewerId: string | null,
): Promise<SerializedRestComment<C>>;
export async function serializeRestComment(
  services: RestServices,
  comment: unknown,
  viewerId: string | null,
): Promise<unknown>;
export async function serializeRestComment(
  services: RestServices,
  comment: unknown,
  viewerId: string | null,
): Promise<unknown> {
  if (!isRecord(comment)) return comment;
  return projectComment(services, comment, viewerId);
}

export async function serializeRestComments<C extends CommentLike>(
  services: RestServices,
  comments: readonly C[],
  viewerId: string | null,
): Promise<Array<SerializedRestComment<C>>>;
export async function serializeRestComments(
  services: RestServices,
  comments: unknown,
  viewerId: string | null,
): Promise<unknown[]>;
export async function serializeRestComments(
  services: RestServices,
  comments: unknown,
  viewerId: string | null,
): Promise<unknown[]> {
  if (!Array.isArray(comments)) return [];
  return Promise.all(comments.map((comment) => serializeRestComment(services, comment, viewerId)));
}

async function projectComment(
  services: RestServices,
  comment: Record<string, unknown>,
  viewerId: string | null,
): Promise<SerializedRestComment<Record<string, unknown>>> {
  const authorId = typeof comment.authorId === "string" ? comment.authorId : null;
  const author = authorId
    ? await services.getAuthorProfile({ userId: authorId, locale: localeOf(comment), viewerId })
    : null;
  const replies = Array.isArray(comment.replies) ? comment.replies : [];
  const projected = await Promise.all(replies.map((reply) => serializeRestComment(services, reply, viewerId)));
  return {
    ...(comment as Omit<Record<string, unknown>, "replies">),
    author: author ?? null,
    // The recursion cannot express its own input type: the guard above already
    // discarded every reply that is not an object, and the stored contract says a
    // reply is a comment. This is the one assertion in the module.
    replies: projected as SerializedRestComment<StoredArticleComment>[],
  };
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * REST transport adapter. It calls application services directly; it never
 * makes an HTTP round-trip to GraphQL or reaches into persistence adapters.
 */
