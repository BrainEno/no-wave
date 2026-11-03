/**
 * Persistence adapter contracts consumed by the application layer.
 *
 * Implementations return domain-shaped records, not driver-specific rows.
 * The contract intentionally groups methods by domain so a PostgreSQL,
 * MongoDB, or SQLite adapter can be tested against the same behavioral suite.
 */
import type { IdentityStore } from "./identity.ts";
import type { MediaAsset, MediaScanRow } from "./media-assets.ts";

/**
 * The single source of truth for the persistence surface.
 *
 * Runtime assertion (`assertPersistenceAdapter`) and the compile-time port types
 * below are both derived from this object, so a method cannot be added to one and
 * forgotten in the other.
 */
export const persistencePortMethods = Object.freeze({
  content: Object.freeze([
    "listPublishedArticles", "getPublishedArticle", "listMyArticles",
    "createArticle", "updateArticle", "deleteArticle", "restoreArticle",
    "listMyDeletedArticles", "purgeExpiredArticles", "listLikedArticles", "listRelatedArticles",
    "listFollowingArticles", "listFeaturedArticles", "setFeaturedArticles",
  ] as const),
  taxonomy: Object.freeze([
    "listTaxonomies", "getTaxonomyBySlug", "listTaxonomyArticles",
    "listArticleTaxonomies", "createTag", "createTaxonomy", "deleteTaxonomy",
  ] as const),
  profiles: Object.freeze([
    "getAuthorProfile", "searchUsers", "searchAuthors", "listFollowing", "listFollowers",
    "followUser", "unfollowUser", "upsertAuthorProfile",
    "getUserRole", "setUserRole",
  ] as const),
  engagement: Object.freeze([
    "getArticleLikeInfo", "toggleArticleLike", "setArticleLike",
    "listArticleComments", "createArticleComment", "deleteArticleComment",
    "listArticleCommentAuthorIds",
  ] as const),
  conversations: Object.freeze([
    "createConversation", "getConversation", "updateConversationParticipants", "deleteConversation",
    "markConversationAsRead", "listConversationMessages", "listConversations",
    "persistMessage", "listConversationParticipantIds",
  ] as const),
  notifications: Object.freeze([
    "listNotifications", "getUnreadNotificationCount", "markAllNotificationsRead",
    "markNotificationRead", "createNotification", "deliverMessageNotifications",
  ] as const),
  sessions: Object.freeze(["revokeSession", "isSessionRevoked"] as const),
  identity: Object.freeze([
    "createIdentityAccount", "findIdentityAccount", "findIdentityAccountByUserId",
    "findIdentityCredentials",
    "createIdentitySession",
    "rotateIdentityRefresh", "revokeIdentityRefresh",
    "replaceIdentityPassword", "setIdentityEmail", "markIdentityEmailVerified",
    "listIdentitySessions", "revokeIdentitySession", "revokeIdentitySessions",
    "issueIdentityToken", "consumeIdentityToken",
    "pruneExpiredIdentityState",
  ] as const),
  rateLimits: Object.freeze(["consumeRateLimit"] as const),
  outbox: Object.freeze([
    "claimOutboxEvents", "markOutboxDelivered", "rescheduleOutboxEvent", "outboxBacklog",
  ] as const),
  operations: Object.freeze(["health"] as const),
});

export type PortGroups = typeof persistencePortMethods;
export type PortName = keyof PortGroups;
export type PortMethodName<K extends PortName> = PortGroups[K][number];

/* -------------------------------------------------------------------------- */
/* Domain output records                                                      */
/* -------------------------------------------------------------------------- */

/** An article in one locale, as every provider answers a read. */
export type StoredArticle = {
  id: string; authorId: string; slug: string; workType: string; status: string;
  locale: string; title: string; summary: string; contentBlocks: unknown;
  contentBlocksVersion: number;
  createdAt: string | null; updatedAt: string | null; publishedAt: string | null;
};
/** A tombstone in the author's desk, with the cost of its eventual sweep. */
export type StoredDeletedArticle = StoredArticle & { deletedAt: string; commentCount: number };
export type StoredTaxonomy = {
  id: string; kind: string; slug: string; name: string; description: string;
  locale: string; createdBy: string; articleCount: number;
};
export type StoredAuthorProfile = {
  userId: string; role: string; displayName: string; bio: string;
  avatarUrl: string | null; websiteUrl: string | null; locale: string;
  followerCount: number; followingCount: number; isFollowing: boolean;
  createdAt: string; updatedAt: string;
};
/** The author-directory projection: profile reach plus published work count. */
export type StoredAuthorHit = {
  userId: string; displayName: string; bio: string; locale: string;
  followerCount: number; workCount: number; isFollowing?: boolean;
};
export type StoredArticleLikeInfo = {
  articleId: string; slug: string; likeCount: number; likedByViewer: boolean;
};
export type StoredArticleComment = {
  id: string; articleId: string; authorId: string; parentCommentId: string | null;
  content: string; contentBlocks: unknown; contentBlocksVersion: number;
  createdAt: string; updatedAt: string; locale: string; replies: StoredArticleComment[];
};
export type StoredMessage = {
  id: string; conversationId: string; senderId: string; body: string;
  createdAt: string; duplicate: boolean;
};
export type StoredConversation = {
  id: string; createdBy: string | null; participantIds: string[];
  createdAt: string; lastActivityAt: string; unreadCount: number;
  lastMessage: StoredMessage | null;
};
export type StoredNotification = {
  id: string; userId: string; eventKey: string; payload: unknown;
  createdAt: string; readAt: string | null; duplicate?: boolean;
};
export type StoredOutboxEvent = {
  id: string; eventKey: string; eventType: string; aggregateId: string;
  payload: unknown; attempts: number; availableAt: string; leaseToken: string;
};
export type OutboxBacklog = { pendingEvents: number; oldestPendingAgeMs: number };
export type RateLimitResult = { allowed: boolean; resetAt: string };
export type DeletedArticleResult = { id: string; deletedAt: string };
export type PurgedArticlesResult = { purged: number };
export type NotificationCount = { count: number };

/* -------------------------------------------------------------------------- */
/* Domain input shapes                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Inputs are deliberately declared with optional fields: the REST layer builds
 * several of them by spreading a validated `Record<string, unknown>` body, and a
 * required field there would be a compile error even though the body does carry
 * it. Optionality does not weaken the contract — a misspelled key is still an
 * excess-property error, and a wrong value type is still a type error.
 */
export type ListPublishedArticlesInput = {
  locale?: string; query?: string; authorId?: string | null; sort?: string;
  limit?: number; offset?: number; cursor?: unknown;
};
export type ArticleBySlugInput = { slug?: string; locale?: string };
export type ArticleForViewerInput = { slug?: string; locale?: string; actorId?: string | null };
export type AuthorArticlesInput = { actorId?: string; locale?: string; limit?: number };
export type ArticleListPageInput = { locale?: string; limit?: number; offset?: number };
export type CreateArticleInput = {
  authorId?: string; slug?: string; title?: string; summary?: string; locale?: string;
  contentBlocks?: unknown; contentBlocksVersion?: number; publish?: boolean;
  workType?: string; categoryIds?: string[]; tagIds?: string[];
  idempotencyKey?: string | null; requestedSlug?: string | null;
};
export type UpdateArticleInput = CreateArticleInput & {
  articleId?: string; actorId?: string; workType?: string;
  categoryIds?: string[]; tagIds?: string[];
};
export type ArticleAuthorInput = { articleId?: string; actorId?: string };
export type RestoreArticleInput = ArticleAuthorInput & { locale?: string };
export type PurgeExpiredArticlesInput = { retentionDays?: number; now?: Date | string; limit?: number };
export type RelatedArticlesInput = { slug?: string; locale?: string; limit?: number };
export type FollowingArticlesInput = { actorId?: string; locale?: string; limit?: number; offset?: number };
export type SetFeaturedArticlesInput = {
  actorId?: string; actorIsEditor?: boolean; articleIds?: string[]; locale?: string;
};
export type TaxonomyListInput = {
  kind?: string; locale?: string; query?: string; limit?: number; offset?: number;
};
export type TaxonomyBySlugInput = { kind?: string; slug?: string; locale?: string };
export type TaxonomyArticlesInput = TaxonomyBySlugInput & { limit?: number; offset?: number };
export type ArticleTaxonomiesInput = { articleId?: string; kind?: string; locale?: string };
export type CreateTagInput = { actorId?: string; name?: string; locale?: string };
export type CreateTaxonomyInput = {
  actorId?: string; actorIsEditor?: boolean; kind?: string; slug?: string;
  name?: string; description?: string; locale?: string;
};
export type DeleteTaxonomyInput = { taxonomyId?: string; actorId?: string; actorIsEditor?: boolean };
export type AuthorProfileInput = { userId?: string; locale?: string; viewerId?: string | null };
export type UserRoleInput = { actorId?: string; userId?: string; role?: string };
export type SearchAuthorsInput = { query?: string; locale?: string; limit?: number; offset?: number };
export type SearchUsersInput = {
  query?: string; locale?: string; viewerId?: string | null; limit?: number;
};
export type RelatedUsersInput = {
  userId?: string; locale?: string; viewerId?: string | null; limit?: number;
};
export type FollowUserInput = { actorId?: string; targetUserId?: string };
export type UpsertAuthorProfileInput = {
  userId?: string; displayName?: string; bio?: string; avatarUrl?: string;
  websiteUrl?: string; locale?: string;
};
export type ArticleLikeInput = { slug?: string; locale?: string; actorId?: string | null; liked?: boolean };
export type ArticleCommentsInput = { slug?: string; locale?: string; limit?: number };
export type CreateArticleCommentInput = {
  slug?: string; locale?: string; actorId?: string; content?: string;
  contentBlocks?: unknown; contentBlocksVersion?: number;
  parentCommentId?: string | null; idempotencyKey?: string | null;
};
export type DeleteArticleCommentInput = { commentId?: string; actorId?: string };
export type ArticleCommentAuthorIdsInput = { articleId?: string; limit?: number };
export type CreateConversationInput = {
  actorId?: string; participantIds?: string[]; idempotencyKey?: string | null;
};
export type ConversationMemberInput = { conversationId?: string; actorId?: string };
export type UpdateConversationParticipantsInput = ConversationMemberInput & {
  addUserIds?: string[]; removeUserIds?: string[];
};
export type ListConversationMessagesInput = ConversationMemberInput & {
  limit?: number; before?: unknown;
};
export type ListConversationsInput = { actorId?: string; limit?: number };
export type PersistMessageInput = {
  conversationId?: string; senderId?: string; body?: string; idempotencyKey?: string;
};
export type NotificationListInput = { actorId?: string; limit?: number };
export type NotificationActorInput = { actorId?: string };
export type MarkNotificationReadInput = { notificationId?: string; actorId?: string };
export type CreateNotificationInput = { userId?: string; eventKey?: string; payload?: unknown };
export type DeliverMessageNotificationsInput = {
  eventKey?: string; messageId?: string; conversationId?: string; senderId?: string;
};
export type RevokeSessionInput = { sessionId?: string; expiresAt?: string | Date };
export type ClaimOutboxEventsInput = { limit?: number; leaseSeconds?: number };
export type MarkOutboxDeliveredInput = { eventId?: string; leaseToken?: string };
export type RescheduleOutboxEventInput = MarkOutboxDeliveredInput & { delaySeconds?: number };
export type ListMediaAssetsInput = {
  ownerId?: string; cursor?: { at: string; id: string } | null; limit?: number;
};
export type DeleteUnusedMediaAssetInput = { id?: string; ownerId?: string };

/* -------------------------------------------------------------------------- */
/* The 11 typed port groups                                                    */
/* -------------------------------------------------------------------------- */

/** Article content, publication, author desks and the featured shelf. */
export type ContentPersistencePort = {
  listPublishedArticles(input?: ListPublishedArticlesInput): Promise<StoredArticle[]>;
  getPublishedArticle(input: ArticleBySlugInput): Promise<StoredArticle | null>;
  listMyArticles(input?: AuthorArticlesInput): Promise<StoredArticle[]>;
  createArticle(input: CreateArticleInput): Promise<StoredArticle>;
  updateArticle(input: UpdateArticleInput): Promise<StoredArticle>;
  deleteArticle(input: ArticleAuthorInput): Promise<DeletedArticleResult>;
  restoreArticle(input: RestoreArticleInput): Promise<StoredArticle>;
  listMyDeletedArticles(input?: AuthorArticlesInput): Promise<StoredDeletedArticle[]>;
  purgeExpiredArticles(input?: PurgeExpiredArticlesInput): Promise<PurgedArticlesResult>;
  listLikedArticles(input?: AuthorArticlesInput): Promise<StoredArticle[]>;
  listRelatedArticles(input?: RelatedArticlesInput): Promise<StoredArticle[]>;
  listFollowingArticles(input?: FollowingArticlesInput): Promise<StoredArticle[]>;
  listFeaturedArticles(input?: ArticleListPageInput): Promise<StoredArticle[]>;
  setFeaturedArticles(input: SetFeaturedArticlesInput): Promise<StoredArticle[]>;
};

/** User-generated hashtags and editorial categories. */
export type TaxonomyPersistencePort = {
  listTaxonomies(input: TaxonomyListInput): Promise<StoredTaxonomy[]>;
  getTaxonomyBySlug(input: TaxonomyBySlugInput): Promise<StoredTaxonomy | null>;
  listTaxonomyArticles(input: TaxonomyArticlesInput): Promise<StoredArticle[]>;
  listArticleTaxonomies(input: ArticleTaxonomiesInput): Promise<StoredTaxonomy[]>;
  createTag(input: CreateTagInput): Promise<StoredTaxonomy>;
  createTaxonomy(input: CreateTaxonomyInput): Promise<StoredTaxonomy>;
  deleteTaxonomy(input: DeleteTaxonomyInput): Promise<unknown>;
};

/** Author profiles, roles, search and follow relationships. */
export type ProfilesPersistencePort = {
  getAuthorProfile(input: AuthorProfileInput): Promise<StoredAuthorProfile | null>;
  searchUsers(input: SearchUsersInput): Promise<StoredAuthorHit[]>;
  searchAuthors(input: SearchAuthorsInput): Promise<StoredAuthorHit[]>;
  listFollowing(input: RelatedUsersInput): Promise<StoredAuthorProfile[]>;
  listFollowers(input: RelatedUsersInput): Promise<StoredAuthorProfile[]>;
  followUser(input: FollowUserInput): Promise<unknown>;
  unfollowUser(input: FollowUserInput): Promise<unknown>;
  upsertAuthorProfile(input: UpsertAuthorProfileInput): Promise<StoredAuthorProfile>;
  getUserRole(input: { userId?: string }): Promise<string>;
  setUserRole(input: UserRoleInput): Promise<unknown>;
};

/** Article likes and threaded comments. */
export type EngagementPersistencePort = {
  getArticleLikeInfo(input: ArticleForViewerInput): Promise<StoredArticleLikeInfo | null>;
  toggleArticleLike(input: ArticleForViewerInput): Promise<StoredArticleLikeInfo>;
  setArticleLike(input: ArticleLikeInput): Promise<StoredArticleLikeInfo>;
  listArticleComments(input: ArticleCommentsInput): Promise<StoredArticleComment[]>;
  createArticleComment(input: CreateArticleCommentInput): Promise<StoredArticleComment>;
  deleteArticleComment(input: DeleteArticleCommentInput): Promise<boolean>;
  listArticleCommentAuthorIds(input: ArticleCommentAuthorIdsInput): Promise<string[]>;
};

/** Conversations, membership and message persistence. */
export type ConversationsPersistencePort = {
  createConversation(input: CreateConversationInput): Promise<StoredConversation>;
  getConversation(input: ConversationMemberInput): Promise<StoredConversation | null>;
  updateConversationParticipants(input: UpdateConversationParticipantsInput): Promise<StoredConversation>;
  deleteConversation(input: ConversationMemberInput): Promise<unknown>;
  markConversationAsRead(input: ConversationMemberInput): Promise<unknown>;
  listConversationMessages(input: ListConversationMessagesInput): Promise<StoredMessage[]>;
  listConversations(input: ListConversationsInput): Promise<StoredConversation[]>;
  persistMessage(input: PersistMessageInput): Promise<StoredMessage>;
  listConversationParticipantIds(input: ConversationMemberInput): Promise<string[]>;
};

/** Recipient-scoped notification inbox and message delivery. */
export type NotificationsPersistencePort = {
  listNotifications(input: NotificationListInput): Promise<StoredNotification[]>;
  getUnreadNotificationCount(input: NotificationActorInput): Promise<NotificationCount>;
  markAllNotificationsRead(input: NotificationActorInput): Promise<NotificationCount>;
  markNotificationRead(input: MarkNotificationReadInput): Promise<StoredNotification | null>;
  createNotification(input: CreateNotificationInput): Promise<StoredNotification>;
  deliverMessageNotifications(input: DeliverMessageNotificationsInput): Promise<unknown>;
};

/** Durable session revocation. */
export type SessionsPersistencePort = {
  revokeSession(input: RevokeSessionInput): Promise<boolean>;
  isSessionRevoked(sessionId: string): Promise<boolean>;
};

/**
 * Self-hosted identity. `IdentityStore` is already the authoritative,
 * fully annotated contract consumed by `createIdentityService`; reusing it here
 * keeps one definition instead of a second hand-written copy that could drift.
 */
export type IdentityPersistencePort = Omit<IdentityStore, "consumeRateLimit">;

/** Durable, atomic rate-limit buckets. */
export type RateLimitsPersistencePort = {
  consumeRateLimit: IdentityStore["consumeRateLimit"];
};

/** Transactional outbox leasing, acknowledgement and backlog metrics. */
export type OutboxPersistencePort = {
  claimOutboxEvents(input?: ClaimOutboxEventsInput): Promise<StoredOutboxEvent[]>;
  markOutboxDelivered(input: MarkOutboxDeliveredInput): Promise<boolean>;
  rescheduleOutboxEvent(input: RescheduleOutboxEventInput): Promise<boolean>;
  outboxBacklog(): Promise<OutboxBacklog>;
};

/** Operational probes. */
export type OperationsPersistencePort = {
  health(): Promise<boolean>;
};

/* -------------------------------------------------------------------------- */
/* Provider-only (non-port) methods                                           */
/* -------------------------------------------------------------------------- */

/**
 * Media metadata is consumed by `createMediaAssetService` through the raw
 * adapter, not through a domain port, but it is part of the adapter surface and
 * is typed here so the composed store has no untyped methods left.
 */
export type MediaPersistencePort = {
  createMediaAsset(asset: Omit<MediaAsset, "createdAt">): Promise<MediaAsset>;
  getMediaAsset(input: { id: string }): Promise<MediaAsset | null>;
  listMediaAssets(input: ListMediaAssetsInput): Promise<MediaAsset[]>;
  listMediaScanRows(): Promise<MediaScanRow[]>;
  deleteUnusedMediaAsset(input: DeleteUnusedMediaAssetInput): Promise<{
    deleted: MediaAsset | null; usedBy: MediaScanRow[];
  } | null>;
};

/**
 * `transaction` is a PostgreSQL-only helper (used by its failure/rollback
 * integration test), not a domain port. It is optional so the SQLite adapter,
 * which has no such helper, satisfies the same contract.
 */
export type TransactionPersistencePort = {
  transaction?(work: (...args: never[]) => unknown): Promise<unknown>;
};

/**
 * The fully typed adapter contract: one explicit signature for every port
 * method in the table, plus the provider-only media/transaction helpers.
 * Declared as an intersection of *type aliases* (not interfaces) so it keeps an
 * implicit index signature and therefore satisfies the generic constraint used
 * by `assertPersistenceAdapter`/`createPersistencePorts`.
 */
export type TypedPersistenceAdapterContract =
  & ContentPersistencePort
  & TaxonomyPersistencePort
  & ProfilesPersistencePort
  & EngagementPersistencePort
  & ConversationsPersistencePort
  & NotificationsPersistencePort
  & SessionsPersistencePort
  & IdentityPersistencePort
  & RateLimitsPersistencePort
  & OutboxPersistencePort
  & OperationsPersistencePort
  & MediaPersistencePort
  & TransactionPersistencePort;

/**
 * Broad structural constraint for adapter-shaped objects. `never[]` accepts a
 * method with any parameter list (contravariance) while `unknown` forbids the
 * `any` escape hatch in return positions; generic arguments still infer their
 * own concrete method signatures.
 */
export type PersistenceAdapterMethods = Record<string, (...args: never[]) => unknown>;

/**
 * The shape an adapter must actually return.
 *
 * This used to be a mapped `(...args: any[]) => any`, which let a transport call
 * silently pass a misspelled or wrongly typed argument. It is now the explicit
 * domain contract, so `createPersistencePorts`, `ApplicationServices` and every
 * REST route inherit the parameter and return types declared above (issue #66).
 * Adapters annotate their returned object with `satisfies TypedPersistenceAdapterContract`,
 * which turns a renamed/dropped/wrongly typed method into a compile error.
 */
export type PersistenceAdapterContract = TypedPersistenceAdapterContract;

/** Domain-grouped repository ports, typed from the adapter that backs them. */
export type PersistencePorts<A extends PersistenceAdapterMethods = PersistenceAdapterContract> = {
  [K in PortName]: { [M in PortMethodName<K>]: A[M] };
};

export function assertPersistenceAdapter<T extends PersistenceAdapterMethods>(adapter: T): T {
  if (!adapter || typeof adapter !== "object") {
    throw new TypeError("A persistence adapter object is required.");
  }
  const missing = Object.entries(persistencePortMethods)
    .flatMap(([port, methods]) => methods
      .filter((method) => typeof adapter[method] !== "function")
      .map((method) => `${port}.${method}`));
  if (missing.length > 0) {
    throw new TypeError("Persistence adapter is missing required operations: " + missing.join(", "));
  }
  return adapter;
}

/** Group a flat adapter into domain-specific repository ports. */
export function createPersistencePorts<A extends PersistenceAdapterMethods = PersistenceAdapterContract>(
  adapter: A,
  {
    onOperation,
  }: {
    onOperation?: (sample: { operation: string; success: boolean; durationMs: number }) => void;
  } = {},
) {
  if (!adapter || typeof adapter !== "object") {
    throw new TypeError("A persistence adapter object is required.");
  }
  // The mapping from the runtime method table to `PersistencePorts<A>` cannot be
  // expressed by `Object.fromEntries`, so this module — which owns the table —
  // performs the single cast that keeps every consumer typed.
  return Object.freeze(Object.fromEntries(
    Object.entries(persistencePortMethods).map(([port, methods]) => [
      port,
      Object.freeze(Object.fromEntries(methods.map((method) => [
        method,
        (...args) => {
          const operation = adapter[method];
          if (typeof operation !== "function") {
            throw new TypeError(`Persistence adapter does not implement ${port}.${method}.`);
          }
          const startedAt = process.hrtime.bigint();
          const report = (success) => {
            if (typeof onOperation !== "function") return;
            try {
              onOperation({
                operation: method,
                success,
                durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
              });
            } catch {
              // Metrics are best effort and never change persistence semantics.
            }
          };
          let result;
          try {
            result = Reflect.apply(operation, adapter, args);
          } catch (error) {
            report(false);
            throw error;
          }
          if (result !== null && (typeof result === "object" || typeof result === "function") &&
              typeof result.then === "function") {
            return result.then(
              (value) => { report(true); return value; },
              (error) => { report(false); throw error; },
            );
          }
          report(true);
          return result;
        },
      ]))),
    ]),
  )) as PersistencePorts<A>;
}
