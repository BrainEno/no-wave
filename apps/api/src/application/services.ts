import {
  createPersistencePorts,
  type PersistenceAdapterContract,
  type PersistenceAdapterMethods,
  type PersistencePorts,
  type ArticleAuthorInput,
  type AuthorArticlesInput,
  type CreateTaxonomyInput,
  type DeleteTaxonomyInput,
  type DeletedArticleResult,
  type PurgedArticlesResult,
  type PurgeExpiredArticlesInput,
  type RestoreArticleInput,
  type SetFeaturedArticlesInput,
  type StoredArticle,
  type StoredDeletedArticle,
  type StoredTaxonomy,
} from "./persistence-ports.ts";
import { ArticleInputError, ArticleNotFoundError, ProfileAuthorizationError } from "../domain/errors.ts";
import {
  ARTICLE_VIEW_LIMIT,
  ARTICLE_VIEW_WINDOW_SECONDS,
  articleViewDay,
  articleViewKey,
  articleViewReader,
  articleViewsAvailable,
} from "./article-views.ts";
import { runReportedTask, safeErrorClass, type BackgroundFailure, type BackgroundFailureReporter } from "./background-tasks.ts";

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never;

/** Flatten `{ content: { a, b }, taxonomy: { c } }` into `{ a, b, c }`. */
type FlatPorts<P> = UnionToIntersection<{ [K in keyof P]: P[K] }[keyof P]>;

/**
 * The REST-normalized article write body as the application layer receives it.
 * `contentBlocks` is still a serialized JSON array here; `createApplicationServices`
 * parses it at the boundary. `transport/rest/bodies.ts` produces a structurally
 * compatible shape (its `locale` is limited to the supported article locales).
 */
export type ArticleWriteInput = {
  title: string;
  contentBlocks: string;
  summary: string;
  locale?: string;
  slug?: string;
  publish?: boolean;
  workType?: string;
  contentBlocksVersion?: number;
  categoryIds?: readonly unknown[];
  tagIds?: readonly unknown[];
};
export type ArticleCreateServiceInput = ArticleWriteInput & {
  authorId: string;
  slug: string;
  idempotencyKey?: string | null;
  requestedSlug?: string | null;
};
export type ArticleUpdateServiceInput = ArticleWriteInput & {
  articleId: string;
  actorId: string;
  slug: string;
  publish: boolean;
  expectedRevision?: number | null;
};

/**
 * One reader opening one work, as the transport saw it.
 *
 * `actorId` is the verified session or `null`; `address` is whatever
 * `clientAddressFor` decided the peer is — never trusted for anything but the
 * anonymous dedupe key, and never stored.
 */
export type ArticleViewInput = {
  slug: string;
  locale?: string;
  actorId?: string | null;
  address: string;
};
export type ArticleViewResult = { counted: boolean; viewCount: number };

/** Facade methods whose input or output differs from the raw port signature. */
type ServiceOverrideName =
  | "createArticle" | "updateArticle" | "deleteArticle" | "listMyDeletedArticles"
  | "restoreArticle" | "purgeExpiredArticles" | "setFeaturedArticles"
  | "createTaxonomy" | "deleteTaxonomy";

/**
 * The application-facing service facade.
 *
 * The type is *derived* from the persistence port table rather than hand-written
 * again: `createApplicationServices` flattens the domain-grouped ports into one
 * object. The handful of methods the facade deliberately wraps (editorial
 * permission checks, serialized content parsing, tombstone retention) are
 * `Omit`ted from that flattening and declared here with their real signatures —
 * no index signature, no `any`, no assertion. Both a method that is not in the
 * port table and a misspelled or wrongly typed argument are compile errors
 * (issues #66 / #167).
 */
export type ApplicationServices<A extends PersistenceAdapterMethods = PersistenceAdapterContract> =
  Omit<FlatPorts<PersistencePorts<A>>, ServiceOverrideName> & {
    createArticle(input: ArticleCreateServiceInput): Promise<StoredArticle>;
    updateArticle(input: ArticleUpdateServiceInput): Promise<StoredArticle>;
    deleteArticle(input: ArticleAuthorInput): Promise<DeletedArticleResult>;
    listMyDeletedArticles(input: AuthorArticlesInput): Promise<Array<StoredDeletedArticle & { purgesAt?: string }>>;
    restoreArticle(input: RestoreArticleInput): Promise<StoredArticle>;
    purgeExpiredArticles(input?: PurgeExpiredArticlesInput): Promise<PurgedArticlesResult>;
    /** `actorIsEditor` is decided here, not accepted from the transport. */
    setFeaturedArticles(input: Omit<SetFeaturedArticlesInput, "actorIsEditor">): Promise<StoredArticle[]>;
    createTaxonomy(input: Omit<CreateTaxonomyInput, "actorIsEditor">): Promise<StoredTaxonomy>;
    deleteTaxonomy(input: Omit<DeleteTaxonomyInput, "actorIsEditor">): Promise<boolean>;
    /**
     * Record that someone opened a published work (ADR 0035).
     *
     * `counted` says whether this call was the one that moved the number: the
     * author's own reads and a reader's second visit on the same UTC day answer
     * `{counted: false}` with the count they already had, because a deduplicated
     * view is a normal outcome, not an error the browser has to interpret.
     */
    recordArticleView(input: ArticleViewInput): Promise<ArticleViewResult>;
    /** ADR 0016: may this account curate? Consulted before every editorial write. */
    isEditor(input: { actorId: string }): Promise<boolean>;
    assignUserRole(input: { actorId: string; userId: string; role: string }): Promise<string>;
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
 * How many deletion notices go in one transaction (audit F-23).
 *
 * The single-row call is a transaction of its own, so the old loop held the
 * SQLite write lock 200 times inside one `DELETE` request: every other writer on
 * the instance waited behind a page of notices. Fifty per batch keeps each
 * transaction short (and each failed batch small) while turning 200 commits into
 * four. The batch is all-or-nothing, so a batch is also the unit of "these
 * readers were told".
 */
export const TOMBSTONE_NOTIFICATION_BATCH_SIZE = 50;

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

export function createApplicationServices({
  persistence,
  onPersistenceOperation = null,
  onBackgroundFailure = null,
  env = process.env,
}: {
  persistence: PersistenceAdapterContract;
  onPersistenceOperation?: ((sample: { operation: string; success: boolean; durationMs: number }) => void) | null;
  /**
   * Where a cleanup or inbox failure goes (audit F-22). The default is to report
   * nothing, which is what an embedded host or a test wants; the API passes a
   * structured-log sink so an operator can see a sweep that has stopped working.
   */
  onBackgroundFailure?: BackgroundFailureReporter;
  env?: NodeJS.ProcessEnv;
}): ApplicationServices {
  // ADR 0016, decision 2: the `role` column is the source of truth, but an empty
  // database can never mint its first editor through it — only an editor may write
  // it. `EDITOR_USER_IDS` is the way in, and the way back if the last editor is lost.
  const bootstrapEditors = new Set(
    String(env?.EDITOR_USER_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
  // `persistence` is the typed contract, so every call below is checked against
  // the declared port inputs and outputs. No `as unknown as` is needed to keep
  // the facade and the adapter in agreement.
  const ports = createPersistencePorts(persistence, { onOperation: onPersistenceOperation ?? undefined });

  // One sink for every background failure, so a task cannot be added below and
  // quietly skip the report. A sink that throws is not allowed to fail a request
  // that has already done the right thing.
  const report = (failure: BackgroundFailure): void => {
    try {
      onBackgroundFailure?.(failure);
    } catch {
      // Reporting is best-effort by definition; the failure itself still travels
      // back through `runReportedTask` for maintenance runs that log a summary.
    }
  };

  // Parse transport-serialized content at the application boundary, not in GraphQL.
  const parseContentBlocks = (serialized: string): unknown[] => {
    let blocks;
    try {
      blocks = JSON.parse(serialized);
    } catch {
      throw new ArticleInputError("contentBlocks must be a valid JSON array.");
    }
    if (!Array.isArray(blocks)) {
      throw new ArticleInputError("contentBlocks must be a valid JSON array.");
    }
    return blocks;
  };

  /**
   * The one permission question the platform asks today: may this account curate?
   *
   * A missing or empty actor is a plain `member`, never a reason to fail open; the
   * environment list is consulted before the column so bootstrapping works on a
   * database that has no roles yet.
   */
  const isEditor = async ({ actorId }: { actorId: string }): Promise<boolean> => {
    if (typeof actorId !== "string" || actorId.trim().length === 0) return false;
    if (bootstrapEditors.has(actorId)) return true;
    return await ports.profiles.getUserRole({ userId: actorId }) === "editor";
  };

  /**
   * ADR 0016, decision 3: the caller must be an editor to hand out the role at
   * all. Refusing to change your own is enforced one layer down, in persistence,
   * so both adapters answer it identically under the same contract test.
   */
  const assignUserRole = async ({ actorId, userId, role }: { actorId: string; userId: string; role: string }): Promise<string> => {
    if (!await isEditor({ actorId })) throw new ProfileAuthorizationError();
    return ports.profiles.setUserRole({ actorId, userId, role });
  };

  /**
   * ADR 0016, decision 1: a category is an editorial structure, a hashtag is the
   * author's own words. The editor question is answered here — the only layer
   * that can see `EDITOR_USER_IDS` — and handed to persistence as a plain fact.
   * ADR 0016, decision 4: the featured shelf is editorial in both directions.
   */
  const setFeaturedArticles = async ({ actorId, ...input }: Omit<SetFeaturedArticlesInput, "actorIsEditor">): Promise<StoredArticle[]> => {
    const actorIsEditor = await isEditor({ actorId });
    return ports.content.setFeaturedArticles({ ...input, actorId, actorIsEditor });
  };
  const createTaxonomy = async ({ actorId, ...input }: Omit<CreateTaxonomyInput, "actorIsEditor">): Promise<StoredTaxonomy> => {
    const actorIsEditor = await isEditor({ actorId });
    return ports.taxonomy.createTaxonomy({ ...input, actorId, actorIsEditor });
  };
  const deleteTaxonomy = async ({ actorId, ...input }: Omit<DeleteTaxonomyInput, "actorIsEditor">): Promise<boolean> => {
    const actorIsEditor = await isEditor({ actorId });
    return ports.taxonomy.deleteTaxonomy({ ...input, actorId, actorIsEditor });
  };

  const createArticleBase = async ({ authorId, ...input }: ArticleCreateServiceInput): Promise<StoredArticle> =>
    ports.content.createArticle({ ...input, authorId, contentBlocks: parseContentBlocks(input.contentBlocks) });
  const updateArticleBase = async ({ actorId, ...input }: ArticleUpdateServiceInput): Promise<StoredArticle> =>
    ports.content.updateArticle({ ...input, actorId, contentBlocks: parseContentBlocks(input.contentBlocks) });

  /**
   * Tell the readers who commented on a work what deleting it means for them.
   *
   * The sweep takes the comments with the row, and the scheduled maintenance run
   * only removes rows — it does not warn anyone the day before, because a notice
   * per pending deletion per day would be a mailing list. The only moment the
   * system can reach those readers is the deletion itself. One notification each,
   * naming the date their words go, deduplicated by the notification store's own
   * event key.
   *
   * No failure here may fail the delete: a work the author cannot remove because
   * an inbox row could not be written would be a far worse bug than a reader who
   * was never told. They are *reported* instead — one line per deletion, carrying
   * the count and the error class, so a broken notification write stops being
   * invisible without turning into a 500.
   *
   * The notices are written in batches of {@link TOMBSTONE_NOTIFICATION_BATCH_SIZE},
   * one transaction each (audit F-23). Per row they were 200 transactions inside
   * one `DELETE`, which on SQLite means the write lock 200 times for every other
   * writer on the instance. A batch that fails is retried row by row, so one
   * unwritable key still costs one reader rather than a whole page.
   */
  async function notifyCommentAuthors(articleId: string, actorId: string, purgesAt: string): Promise<void> {
    if (typeof ports.engagement.listArticleCommentAuthorIds !== "function") return;
    if (typeof ports.notifications.createNotification !== "function") return;
    let authorIds: unknown;
    try {
      authorIds = await ports.engagement.listArticleCommentAuthorIds({ articleId, limit: TOMBSTONE_NOTIFICATION_LIMIT });
    } catch (error) {
      report({ task: "tombstone-notifications", errorName: safeErrorClass(error) });
      return;
    }
    if (!Array.isArray(authorIds)) return;
    const notice = (userId: string) => ({
      userId,
      eventKey: `article.deleted:${articleId}:${userId}`,
      payload: { type: "article.deleted", articleId, purgesAt },
    });
    // The author deleting their own work needs no notice about it.
    const recipients = authorIds.filter(
      (userId): userId is string => typeof userId === "string" && userId.length > 0 && userId !== actorId,
    );
    let failed = 0;
    let firstFailure: string | null = null;
    for (let start = 0; start < recipients.length; start += TOMBSTONE_NOTIFICATION_BATCH_SIZE) {
      const batch = recipients.slice(start, start + TOMBSTONE_NOTIFICATION_BATCH_SIZE);
      try {
        // One transaction per batch, in the order the readers were listed.
        await ports.notifications.createNotifications(batch.map(notice));
        continue;
      } catch (error) {
        // The batch is one transaction, so a failure anywhere in it wrote
        // nothing. Record it, then fall back to one row at a time for *this*
        // batch only: a single unwritable key must cost one reader, not fifty,
        // and the deletion itself never fails because an inbox row could not be
        // written.
        firstFailure ??= safeErrorClass(error);
      }
      for (const userId of batch) {
        try {
          await ports.notifications.createNotification(notice(userId));
        } catch (error) {
          failed += 1;
          firstFailure ??= safeErrorClass(error);
        }
      }
    }
    // `failed` counts readers who were never told. It is omitted when the batch
    // failed but the row-by-row retry wrote every notice: the failure is still
    // worth a line (something is flaky), and it is not worth claiming a loss.
    if (firstFailure !== null) {
      report({
        task: "tombstone-notifications",
        errorName: firstFailure,
        ...(failed > 0 ? { failed } : {}),
      });
    }
  }

  // Deletion carries no body: it addresses a work the author already has.
  const deleteArticle = async ({ actorId, articleId }: ArticleAuthorInput): Promise<DeletedArticleResult> => {
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
  const listMyDeletedArticles = async ({ actorId, locale, limit }: AuthorArticlesInput): Promise<Array<StoredDeletedArticle & { purgesAt?: string }>> => {
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
  const restoreArticle = async ({ actorId, articleId, locale }: RestoreArticleInput): Promise<StoredArticle> =>
    ports.content.restoreArticle({ articleId, actorId, locale });
  const purgeExpiredArticles = async ({ retentionDays = resolveTombstoneRetentionDays(env), now, limit }: PurgeExpiredArticlesInput = {}): Promise<PurgedArticlesResult> =>
    ports.content.purgeExpiredArticles({ retentionDays, now: now ?? new Date(), limit });

  /**
   * Bounded best-effort sweep, on the pattern of `pruneExpiredIdentityState`:
   * it rides on the desk's own writes, is awaited inside the request, and is
   * never allowed to fail the write that triggered it. Nothing is detached, so
   * no work can outlive the process or the request.
   *
   * This is a *supplement* since audit F-22, not the trigger. A quiet instance
   * has no writes to ride on, which is why `runMaintenance` exists and why the
   * operation is documented as a scheduled job. What changed here is only the
   * failure: it used to vanish, and on an instance whose writes all come from the
   * one author, a purge that had stopped working looked exactly like a bin that
   * was always empty.
   */
  let writesUntilTombstonePurge = TOMBSTONE_PURGE_EVERY_WRITES;
  async function sweepTombstones(): Promise<void> {
    writesUntilTombstonePurge -= 1;
    if (writesUntilTombstonePurge > 0) return;
    writesUntilTombstonePurge = TOMBSTONE_PURGE_EVERY_WRITES;
    if (typeof ports.content.purgeExpiredArticles !== "function") return;
    await runReportedTask({
      task: "tombstone-purge",
      report: onBackgroundFailure,
      work: async () => ports.content.purgeExpiredArticles({ retentionDays: resolveTombstoneRetentionDays(env) }),
    });
  }
  const withTombstoneSweep = <Input, Output>(work: (input: Input) => Promise<Output>) => async (input: Input): Promise<Output> => {
    try {
      return await work(input);
    } finally {
      await sweepTombstones();
    }
  };
  const createArticle = withTombstoneSweep(createArticleBase);
  const updateArticle = withTombstoneSweep(updateArticleBase);
  const deleteArticleWithSweep = withTombstoneSweep(deleteArticle);
  const restoreArticleWithSweep = withTombstoneSweep(restoreArticle);

  // Spreads provide every port method with its declared type; the trailing
  // entries are the intentional application-layer overrides, each checked by
  // `satisfies` against the single matching facade signature.
  /**
   * Count this read, if this read is a view (ADR 0035).
   *
   * The order is deliberate: resolve the work first (a slug that is not a
   * published work is a `404`, not a discarded view), then refuse the author's
   * own reading, then charge the day's bucket, then increment. A failure between
   * the last two steps loses one view; the reverse order would count a view the
   * bucket had not allowed, which is the one failure a metric must not have.
   */
  const recordArticleView = async ({
    slug,
    locale = "zh-CN",
    actorId = null,
    address,
  }: ArticleViewInput): Promise<ArticleViewResult> => {
    const article = await ports.content.getPublishedArticle({ slug, locale });
    if (!article) throw new ArticleNotFoundError();

    // The author's own reloads are proofreading, not reach.
    if (actorId !== null && actorId === article.authorId) {
      return { counted: false, viewCount: article.viewCount };
    }

    const secret = env?.AUTH_JWT_SECRET;
    if (!articleViewsAvailable(secret)) {
      return { counted: false, viewCount: article.viewCount };
    }

    const key = articleViewKey({
      secret,
      articleId: article.id,
      viewer: articleViewReader(actorId, address),
      day: articleViewDay(new Date()),
    });
    const bucket = await ports.rateLimits.consumeRateLimit({
      key,
      limit: ARTICLE_VIEW_LIMIT,
      windowSeconds: ARTICLE_VIEW_WINDOW_SECONDS,
    });
    if (!bucket.allowed) {
      return { counted: false, viewCount: article.viewCount };
    }
    return { counted: true, viewCount: await ports.content.incrementArticleViewCount({ articleId: article.id }) };
  };

  const services = {
    ...ports.content,
    ...ports.taxonomy,
    ...ports.profiles,
    ...ports.engagement,
    ...ports.conversations,
    ...ports.notifications,
    ...ports.sessions,
    ...ports.identity,
    ...ports.rateLimits,
    ...ports.outbox,
    ...ports.imports,
    ...ports.operations,
    isEditor,
    assignUserRole,
    setFeaturedArticles,
    createTaxonomy,
    deleteTaxonomy,
    createArticle,
    updateArticle,
    deleteArticle: deleteArticleWithSweep,
    listMyDeletedArticles,
    restoreArticle: restoreArticleWithSweep,
    purgeExpiredArticles,
    recordArticleView,
  } satisfies ApplicationServices;

  return Object.freeze(services);
}
