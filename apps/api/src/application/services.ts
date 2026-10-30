import { createPersistencePorts, type PersistencePorts } from "./persistence-ports.ts";
import { ArticleInputError } from "../domain/errors.ts";

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never;

/** Flatten `{ content: { a, b }, taxonomy: { c } }` into `{ a, b, c }`. */
type FlatPorts<P> = UnionToIntersection<{ [K in keyof P]: P[K] }[keyof P]>;

/**
 * The application-facing service facade.
 *
 * The type is *derived* from the persistence port table rather than hand-written
 * again: `createApplicationServices` flattens the domain-grouped ports into one
 * object, so the facade type must flatten the same groups. Typing an adapter
 * method therefore tightens every transport call site automatically, and a method
 * name that does not exist in the table is a compile error instead of a runtime
 * "not a function". See issue #66 for the remaining work (annotating the adapter
 * implementations themselves).
 */
export type ApplicationServices<A extends import("./persistence-ports.ts").PersistenceAdapterMethods = import("./persistence-ports.ts").PersistenceAdapterMethods> =
  FlatPorts<PersistencePorts<A>> & {
    createArticle(input: { authorId: string; contentBlocks: unknown; [key: string]: unknown }): Promise<unknown>;
    updateArticle(input: { actorId: string; contentBlocks: unknown; [key: string]: unknown }): Promise<unknown>;
  };

/**
 * GraphQL resolvers depend on these domain-grouped operations rather than on
 * a database driver. Business use cases can be moved into this module without
 * changing transport resolvers or adapter implementations.
 */
/**
 * How long a deleted work stays recoverable.
 *
 * A tombstone that never expires is not a deletion, and one that expires the
 * moment it is written is not recoverable. Thirty days is the shortest window
 * that still covers "I noticed the mistake over the weekend", and it is
 * configurable because the right number belongs to whoever runs the instance,
 * not to this repository.
 */
export const DEFAULT_TOMBSTONE_RETENTION_DAYS = 30;

/** The sweep runs on the desk's own writes, so no scheduler is needed. */
export const TOMBSTONE_PURGE_EVERY_WRITES = 32;

/**
 * How many commenters a single deletion tells about itself.
 *
 * Bounded because the notifications are written inside the deleting request:
 * a work with ten thousand commenters is not a reason to hold a request open,
 * and the cap is the honest place to admit that.
 */
export const TOMBSTONE_NOTIFICATION_LIMIT = 200;

/**
 * Read the retention window from the environment.
 *
 * A value outside the accepted range is not clamped — clamping `0` up to `1`
 * would purge tomorrow what the operator asked to purge today — it falls back to
 * the default, which is always the longer, safer retention.
 */
export function resolveTombstoneRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env?.ARTICLE_TOMBSTONE_RETENTION_DAYS;
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_TOMBSTONE_RETENTION_DAYS;
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3650) return DEFAULT_TOMBSTONE_RETENTION_DAYS;
  return parsed;
}

export function createApplicationServices<A extends import("./persistence-ports.ts").PersistenceAdapterMethods>({ persistence, onPersistenceOperation = null, env = process.env }: {
  persistence: A;
  onPersistenceOperation?: ((sample: { operation: string; success: boolean; durationMs: number }) => void) | null;
  env?: NodeJS.ProcessEnv;
}): ApplicationServices<A> {
  const ports = createPersistencePorts(persistence, { onOperation: onPersistenceOperation ?? undefined });
  const serviceMethods = Object.values(ports).flatMap((group) => Object.entries(group));
  const services = Object.fromEntries(serviceMethods);

  // Parse transport-serialized content at the application boundary, not in GraphQL.
  const parseContentBlocks = (serialized: unknown) => {
    let blocks;
    try {
      blocks = JSON.parse(serialized as string);
    } catch {
      throw new ArticleInputError("contentBlocks must be a valid JSON array.");
    }
    if (!Array.isArray(blocks)) {
      throw new ArticleInputError("contentBlocks must be a valid JSON array.");
    }
    return blocks;
  };

  services.createArticle = async ({ authorId, ...input }) =>
    ports.content.createArticle({ ...input, authorId, contentBlocks: parseContentBlocks(input.contentBlocks) });
  services.updateArticle = async ({ actorId, ...input }) =>
    ports.content.updateArticle({ ...input, actorId, contentBlocks: parseContentBlocks(input.contentBlocks) });
  /**
   * Tell the readers who commented on a work what deleting it means for them.
   *
   * The sweep takes the comments with the row, and there is no scheduler that
   * could warn those readers the day before — so the only moment the system can
   * reach them is the deletion itself. One notification each, naming the date
   * their words go, deduplicated by the notification store's own event key.
   *
   * Every failure here is swallowed on purpose: a work the author cannot delete
   * because an inbox row could not be written would be a far worse bug than a
   * reader who was never told.
   */
  async function notifyCommentAuthors(articleId: string, actorId: string, purgesAt: string): Promise<void> {
    if (typeof ports.engagement.listArticleCommentAuthorIds !== "function") return;
    if (typeof ports.notifications.createNotification !== "function") return;
    let authorIds: unknown;
    try {
      authorIds = await ports.engagement.listArticleCommentAuthorIds({ articleId, limit: TOMBSTONE_NOTIFICATION_LIMIT });
    } catch {
      return;
    }
    if (!Array.isArray(authorIds)) return;
    for (const userId of authorIds) {
      // The author deleting their own work needs no notice about it.
      if (typeof userId !== "string" || userId.length === 0 || userId === actorId) continue;
      try {
        await ports.notifications.createNotification({
          userId,
          eventKey: `article.deleted:${articleId}:${userId}`,
          payload: { type: "article.deleted", articleId, purgesAt },
        });
      } catch {
        // One undeliverable inbox row must not stop the others.
      }
    }
  }

  // Deletion carries no body: it addresses a work the author already has.
  services.deleteArticle = async ({ actorId, articleId }) => {
    const deleted = await ports.content.deleteArticle({ articleId, actorId });
    const deletedAt = new Date(deleted?.deletedAt);
    if (Number.isFinite(deletedAt.getTime())) {
      const purgesAt = new Date(deletedAt.getTime() + resolveTombstoneRetentionDays(env) * 86_400_000).toISOString();
      await notifyCommentAuthors(articleId, actorId, purgesAt);
    }
    return deleted;
  };

  // The recycle bin is what makes a soft delete recoverable, and the expiry
  // date is what makes it a deletion rather than an archive. The window is
  // policy, so it is resolved here and not in the stores: one place reads the
  // environment, both transports and every test see the same number.
  services.listMyDeletedArticles = async ({ actorId, locale, limit }) => {
    const retentionDays = resolveTombstoneRetentionDays(env);
    const articles = await ports.content.listMyDeletedArticles({ actorId, locale, limit });
    return articles.map((article) => {
      const deletedAt = new Date(article.deletedAt);
      // A tombstone without a usable timestamp is still listed; it simply
      // carries no promise about when it will go.
      if (Number.isNaN(deletedAt.getTime())) return article;
      return { ...article, purgesAt: new Date(deletedAt.getTime() + retentionDays * 86_400_000).toISOString() };
    });
  };
  services.restoreArticle = async ({ actorId, articleId, locale }) =>
    ports.content.restoreArticle({ articleId, actorId, locale });
  services.purgeExpiredArticles = async ({ retentionDays = resolveTombstoneRetentionDays(env), now, limit }: { retentionDays?: number; now?: Date | string; limit?: number } = {}) =>
    ports.content.purgeExpiredArticles({ retentionDays, now: now ?? new Date(), limit });

  /**
   * Bounded best-effort sweep, on the pattern of `pruneExpiredIdentityState`:
   * it rides on the desk's own writes, is awaited inside the request, and is
   * never allowed to fail the write that triggered it. Nothing is detached, so
   * no work can outlive the process or the request.
   */
  let writesUntilTombstonePurge = TOMBSTONE_PURGE_EVERY_WRITES;
  async function sweepTombstones(): Promise<void> {
    writesUntilTombstonePurge -= 1;
    if (writesUntilTombstonePurge > 0) return;
    writesUntilTombstonePurge = TOMBSTONE_PURGE_EVERY_WRITES;
    if (typeof ports.content.purgeExpiredArticles !== "function") return;
    try {
      await ports.content.purgeExpiredArticles({ retentionDays: resolveTombstoneRetentionDays(env) });
    } catch {
      // The next write tries again; a failed sweep must not look like a failed save.
    }
  }
  const withTombstoneSweep = (work: (input: any) => Promise<any>) => async (input: any) => {
    try {
      return await work(input);
    } finally {
      await sweepTombstones();
    }
  };
  services.createArticle = withTombstoneSweep(services.createArticle);
  services.updateArticle = withTombstoneSweep(services.updateArticle);
  services.deleteArticle = withTombstoneSweep(services.deleteArticle);
  services.restoreArticle = withTombstoneSweep(services.restoreArticle);

  return Object.freeze(services) as ApplicationServices<A>;
}
