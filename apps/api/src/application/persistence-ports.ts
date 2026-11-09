/**
 * Persistence adapter contracts consumed by the application layer.
 *
 * Implementations return domain-shaped records, not driver-specific rows.
 * The contract intentionally groups methods by domain so a PostgreSQL,
 * MongoDB, or SQLite adapter can be tested against the same behavioral suite.
 *
 * Both providers are checked against this one contract: PostgreSQL slices are
 * asynchronous, most SQLite slices are synchronous. `PersistenceResult<T>` is
 * the honest union for those methods; callers always `await`, so a synchronous
 * value and a promise are observationally equivalent. Methods that both
 * providers implement asynchronously (identity, sessions, rate limits, media,
 * health) keep the narrower `Promise<T>` so the existing `IdentityStore`,
 * `RateLimitStore` and `MediaMetadataStore` consumers stay precise.
 */
import type { IdentityStore } from "./identity.ts";
import type { MediaAsset, MediaScanRow } from "./media-assets.ts";

/**
 * The single source of truth for the persistence surface.
 *
 * Runtime assertion (`assertPersistenceAdapter`) and the compile-time port types
 * below are both derived from this object, so a method cannot be added to one and
 * forgotten in the other. Media metadata and `transaction` are deliberately
 * *absent*: they are provider/adjacent-service capabilities, not REST ports.
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
    "listArticleTaxonomies", "listArticlesTaxonomies", "createTag", "createTaxonomy", "deleteTaxonomy",
  ] as const),
  profiles: Object.freeze([
    "getAuthorProfile", "getAuthorProfilesByIds", "searchUsers", "searchAuthors", "listFollowing", "listFollowers",
    "followUser", "unfollowUser", "upsertAuthorProfile",
    "getUserRole", "setUserRole",
  ] as const),
  engagement: Object.freeze([
    "getArticleLikeInfo", "toggleArticleLike", "setArticleLike",
    "listArticleComments", "createArticleComment", "updateArticleComment", "deleteArticleComment",
    "listArticleCommentAuthorIds",
  ] as const),
  conversations: Object.freeze([
    "createConversation", "getConversation", "updateConversationParticipants", "deleteConversation",
    "markConversationAsRead", "listConversationMessages", "listConversations",
    "persistMessage", "listConversationParticipantIds",
  ] as const),
  notifications: Object.freeze([
    "listNotifications", "getUnreadNotificationCount", "markAllNotificationsRead",
    "markNotificationRead", "createNotification", "createNotifications", "deliverMessageNotifications",
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

/** A provider may answer synchronously (SQLite) or asynchronously (PostgreSQL). */
export type PersistenceResult<T> = T | Promise<T>;

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
/** The public author-directory projection: reach plus published work count. */
export type StoredAuthorDirectoryEntry = {
  userId: string; displayName: string; bio: string; locale: string;
  followerCount: number; workCount: number;
};
export type StoredArticleLikeInfo = {
  articleId: string; slug: string; likeCount: number; likedByViewer: boolean;
};
export type StoredArticleComment = {
  id: string; articleId: string; authorId: string; parentCommentId: string | null;
  content: string; contentBlocks: unknown; contentBlocksVersion: number;
  createdAt: string; updatedAt: string;
  /** When the author last corrected the text, or `null` for a comment as written. */
  editedAt: string | null;
  locale: string; replies: StoredArticleComment[];
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
/** A row in the recipient's inbox (list / mark-one). */
export type NotificationRecord = {
  id: string; userId: string; eventKey: string; payload: unknown;
  createdAt: string; readAt: string | null;
};
/** The receipt returned by `createNotification`; it has no `readAt`. */
export type NotificationReceipt = {
  id: string; userId: string; eventKey: string; payload: unknown;
  createdAt: string; duplicate: boolean;
};
/**
 * Outbox leases stay driver-shaped in both providers: the delivery worker and
 * `message-notification-delivery.ts` read the snake_case column names. Do not
 * "improve" these into camelCase without changing those consumers. The one
 * exception is `available_at`: postgres.js decodes that `timestamptz` as a
 * `Date`, so the PostgreSQL slice maps it to the same ISO string SQLite returns.
 */
export type StoredOutboxEvent = {
  id: string; event_key: string; event_type: string; aggregate_id: string;
  payload: unknown; attempts: number; available_at: string; lease_token: string;
};
export type OutboxBacklog = { pendingEvents: number; oldestPendingAgeMs: number };
export type RateLimitResult = { allowed: boolean; resetAt: string };
export type DeletedArticleResult = { id: string; deletedAt: string };
export type PurgedArticlesResult = { purged: number };

/* -------------------------------------------------------------------------- */
/* Domain input shapes                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Required-ness here mirrors what each store actually validates at runtime.
 * REST bodies are normalized into named types (see `transport/rest/bodies.ts`)
 * rather than spread as `Record<string, unknown>`; no field is optional merely
 * to make an unchecked spread compile. Outputs that are genuinely optional in
 * the store (paging, locale defaults, cursors) remain optional.
 */
export type PublishedArticleSort = "latest" | "popular";
export type ListPublishedArticlesInput = {
  locale?: string; query?: string; authorId?: string | null; sort?: PublishedArticleSort;
  limit?: number; offset?: number; cursor?: unknown;
};
export type ArticleBySlugInput = { slug: string; locale?: string };
export type ArticleForViewerInput = { slug: string; locale?: string; actorId?: string | null };
export type AuthorArticlesInput = { actorId: string; locale?: string; limit?: number };
export type ArticleListPageInput = { locale?: string; limit?: number; offset?: number };
export type CreateArticleInput = {
  authorId: string; slug: string; title: string; contentBlocks: unknown;
  summary?: string; locale?: string;
  contentBlocksVersion?: number; publish?: boolean;
  workType?: string; categoryIds?: readonly unknown[]; tagIds?: readonly unknown[];
  idempotencyKey?: string | null; requestedSlug?: string | null;
};
export type UpdateArticleInput = {
  articleId: string; actorId: string; slug: string; title: string; contentBlocks: unknown;
  summary?: string; locale?: string;
  contentBlocksVersion?: number; publish?: boolean;
  workType?: string; categoryIds?: readonly unknown[]; tagIds?: readonly unknown[];
};
export type ArticleAuthorInput = { articleId: string; actorId: string };
export type RestoreArticleInput = ArticleAuthorInput & { locale?: string };
export type PurgeExpiredArticlesInput = { retentionDays?: number; now?: Date | string; limit?: number };
export type RelatedArticlesInput = { slug: string; locale?: string; limit?: number };
export type FollowingArticlesInput = { actorId: string; locale?: string; limit?: number; offset?: number };
export type SetFeaturedArticlesInput = {
  actorId: string; articleIds: string[]; actorIsEditor?: boolean; locale?: string;
};
export type TaxonomyListInput = {
  kind: string; locale?: string; query?: string; limit?: number; offset?: number;
};
export type TaxonomyBySlugInput = { kind: string; slug: string; locale?: string };
export type TaxonomyArticlesInput = TaxonomyBySlugInput & { limit?: number; offset?: number };
export type ArticleTaxonomiesInput = { articleId: string; kind: string; locale?: string };
/**
 * A page's worth of taxonomies in one round trip (#162).
 *
 * `articleIds` is deduplicated by the caller; the answer is keyed by article so
 * the serializer can attach each list without another read. Articles with no
 * taxonomies of that kind are simply absent from the record.
 */
export type ArticlesTaxonomiesInput = { articleIds: readonly string[]; kind: string; locale?: string };
export type CreateTagInput = { actorId: string; name: string; locale?: string };
export type CreateTaxonomyInput = {
  actorId: string; kind: string; slug: string; name: string;
  actorIsEditor?: boolean; description?: string; locale?: string;
};
export type DeleteTaxonomyInput = { taxonomyId: string; actorId: string; actorIsEditor?: boolean };
export type AuthorProfileInput = { userId: string; locale?: string; viewerId?: string | null };
/**
 * A page's worth of author profiles in one round trip (#162).
 *
 * One list appears in the same page many times over (a site with three authors
 * repeats each of them); asking per article would recompute each author's
 * follower counts and the viewer's follow state once per appearance.
 */
export type AuthorProfilesInput = { userIds: readonly string[]; locale?: string; viewerId?: string | null };
export type UserRoleInput = { actorId: string; userId: string; role: string };
export type SearchAuthorsInput = { query?: string; locale?: string; limit?: number; offset?: number };
export type SearchUsersInput = {
  query: string; locale?: string; viewerId?: string | null; limit?: number;
};
export type RelatedUsersInput = {
  userId: string; locale?: string; viewerId?: string | null; limit?: number;
};
export type FollowUserInput = { actorId: string; targetUserId: string };
export type UpsertAuthorProfileInput = {
  userId: string; displayName: string; bio?: string; avatarUrl?: string | null;
  websiteUrl?: string | null; locale?: string;
};
export type ToggleArticleLikeInput = { slug: string; actorId: string; locale?: string };
export type SetArticleLikeInput = ToggleArticleLikeInput & { liked: boolean };
/**
 * One page of a comment thread.
 *
 * `limit` counts **top-level** comments; a top-level comment arrives with its
 * whole reply tree, because a page of roots whose replies were cut in half would
 * be a thread with holes in it. `cursor` is the `(created_at, id)` of the last
 * top-level comment already shown, in the oldest-first order the thread is read
 * in — decoded here, because base64 is a transport detail.
 */
export type ArticleCommentsInput = {
  slug: string;
  locale?: string;
  limit?: number;
  cursor?: { at: string; id: string } | null;
};
export type CreateArticleCommentInput = {
  slug: string; actorId: string; content: string;
  locale?: string; contentBlocks?: unknown[] | null; contentBlocksVersion?: number;
  parentCommentId?: string | null; idempotencyKey?: string | null;
};
/**
 * A correction of a comment's own words.
 *
 * `parentCommentId` is absent on purpose: an edit replaces text, it does not move
 * a reply out of the thread it answered. `locale` is the edition the caller is
 * addressing and is used for the response projection only — a comment belongs to
 * the work, not to one translation of it.
 */
export type UpdateArticleCommentInput = {
  commentId: string; actorId: string; content: string;
  locale?: string; contentBlocks?: unknown[] | null; contentBlocksVersion?: number;
};
export type DeleteArticleCommentInput = { commentId: string; actorId: string };
export type ArticleCommentAuthorIdsInput = { articleId: string; limit?: number };
export type CreateConversationInput = {
  actorId: string; participantIds: string[]; idempotencyKey?: string | null;
};
export type ConversationMemberInput = { conversationId: string; actorId: string };
export type UpdateConversationParticipantsInput = ConversationMemberInput & {
  addUserIds?: string[]; removeUserIds?: string[];
};
export type ListConversationMessagesInput = ConversationMemberInput & {
  limit?: number; before?: unknown;
};
export type ListConversationsInput = { actorId: string; limit?: number };
export type PersistMessageInput = {
  conversationId: string; senderId: string; body: string; idempotencyKey: string;
};
/**
 * One page of an inbox.
 *
 * `cursor` is the `(created_at, id)` of the last notification already shown, in
 * the newest-first order the list is read in. It is *decoded* here rather than
 * passed as the client's string: base64 and separators are a transport detail,
 * and a store that parsed them would be a second, disagreeing validator of the
 * same contract.
 */
export type NotificationListInput = {
  actorId: string;
  limit?: number;
  cursor?: { at: string; id: string } | null;
};
export type NotificationActorInput = { actorId: string };
export type MarkNotificationReadInput = { notificationId: string; actorId: string };
export type CreateNotificationInput = { userId: string; eventKey: string; payload: unknown };
export type DeliverMessageNotificationsInput = {
  eventKey: string; messageId: string; conversationId: string; senderId: string;
};
export type RevokeSessionInput = { sessionId: string; expiresAt: string | Date };
export type ClaimOutboxEventsInput = { limit?: number; leaseSeconds?: number };
export type MarkOutboxDeliveredInput = { eventId: string; leaseToken: string };
export type RescheduleOutboxEventInput = MarkOutboxDeliveredInput & { delaySeconds?: number };
export type ListMediaAssetsInput = {
  ownerId: string; cursor: { at: string; id: string } | null; limit: number;
};
export type DeleteUnusedMediaAssetInput = { id: string; ownerId: string };
/**
 * The reference question, asked about a page of assets instead of the whole site
 * (#163). Keys are the assets the caller is about to show; an asset nothing uses
 * simply has no entry.
 */
export type ReferencesForAssetsInput = { assetIds: readonly string[] };

/* -------------------------------------------------------------------------- */
/* The 11 typed port groups                                                    */
/* -------------------------------------------------------------------------- */

/** Article content, publication, author desks and the featured shelf. */
export type ContentPersistencePort = {
  listPublishedArticles(input?: ListPublishedArticlesInput): PersistenceResult<StoredArticle[]>;
  getPublishedArticle(input: ArticleBySlugInput): PersistenceResult<StoredArticle | null>;
  listMyArticles(input: AuthorArticlesInput): PersistenceResult<StoredArticle[]>;
  createArticle(input: CreateArticleInput): PersistenceResult<StoredArticle>;
  updateArticle(input: UpdateArticleInput): PersistenceResult<StoredArticle>;
  deleteArticle(input: ArticleAuthorInput): PersistenceResult<DeletedArticleResult>;
  restoreArticle(input: RestoreArticleInput): PersistenceResult<StoredArticle>;
  listMyDeletedArticles(input: AuthorArticlesInput): PersistenceResult<StoredDeletedArticle[]>;
  purgeExpiredArticles(input?: PurgeExpiredArticlesInput): PersistenceResult<PurgedArticlesResult>;
  listLikedArticles(input: AuthorArticlesInput): PersistenceResult<StoredArticle[]>;
  listRelatedArticles(input: RelatedArticlesInput): PersistenceResult<StoredArticle[]>;
  listFollowingArticles(input: FollowingArticlesInput): PersistenceResult<StoredArticle[]>;
  listFeaturedArticles(input?: ArticleListPageInput): PersistenceResult<StoredArticle[]>;
  setFeaturedArticles(input: SetFeaturedArticlesInput): PersistenceResult<StoredArticle[]>;
};

/** User-generated hashtags and editorial categories. */
export type TaxonomyPersistencePort = {
  listTaxonomies(input: TaxonomyListInput): PersistenceResult<StoredTaxonomy[]>;
  getTaxonomyBySlug(input: TaxonomyBySlugInput): PersistenceResult<StoredTaxonomy | null>;
  listTaxonomyArticles(input: TaxonomyArticlesInput): PersistenceResult<StoredArticle[]>;
  listArticleTaxonomies(input: ArticleTaxonomiesInput): PersistenceResult<StoredTaxonomy[]>;
  /** The same rows for many articles at once, keyed by article id. */
  listArticlesTaxonomies(input: ArticlesTaxonomiesInput): PersistenceResult<Record<string, StoredTaxonomy[]>>;
  createTag(input: CreateTagInput): PersistenceResult<StoredTaxonomy>;
  createTaxonomy(input: CreateTaxonomyInput): PersistenceResult<StoredTaxonomy>;
  deleteTaxonomy(input: DeleteTaxonomyInput): PersistenceResult<boolean>;
};

/** Author profiles, roles, search and follow relationships. */
export type ProfilesPersistencePort = {
  getAuthorProfile(input: AuthorProfileInput): PersistenceResult<StoredAuthorProfile | null>;
  /** The same profiles for many users at once, keyed by user id. */
  getAuthorProfilesByIds(input: AuthorProfilesInput): PersistenceResult<Record<string, StoredAuthorProfile>>;
  searchUsers(input: SearchUsersInput): PersistenceResult<StoredAuthorProfile[]>;
  searchAuthors(input: SearchAuthorsInput): PersistenceResult<StoredAuthorDirectoryEntry[]>;
  listFollowing(input: RelatedUsersInput): PersistenceResult<StoredAuthorProfile[]>;
  listFollowers(input: RelatedUsersInput): PersistenceResult<StoredAuthorProfile[]>;
  followUser(input: FollowUserInput): PersistenceResult<boolean>;
  unfollowUser(input: FollowUserInput): PersistenceResult<boolean>;
  upsertAuthorProfile(input: UpsertAuthorProfileInput): PersistenceResult<StoredAuthorProfile>;
  getUserRole(input: { userId: string }): PersistenceResult<string>;
  setUserRole(input: UserRoleInput): PersistenceResult<string>;
};

/** Article likes and threaded comments. */
export type EngagementPersistencePort = {
  getArticleLikeInfo(input: ArticleForViewerInput): PersistenceResult<StoredArticleLikeInfo | null>;
  toggleArticleLike(input: ToggleArticleLikeInput): PersistenceResult<StoredArticleLikeInfo | null>;
  setArticleLike(input: SetArticleLikeInput): PersistenceResult<StoredArticleLikeInfo | null>;
  listArticleComments(input: ArticleCommentsInput): PersistenceResult<StoredArticleComment[]>;
  createArticleComment(input: CreateArticleCommentInput): PersistenceResult<StoredArticleComment>;
  /**
   * Replace a comment's content.
   *
   * `null` means "no such comment". A comment that exists and belongs to somebody
   * else is an authorization error, exactly like deletion: the answer must not
   * become a way to learn which ids exist.
   */
  updateArticleComment(input: UpdateArticleCommentInput): PersistenceResult<StoredArticleComment | null>;
  deleteArticleComment(input: DeleteArticleCommentInput): PersistenceResult<boolean>;
  listArticleCommentAuthorIds(input: ArticleCommentAuthorIdsInput): PersistenceResult<string[]>;
};

/**
 * Conversations, membership and message persistence.
 *
 * `updateConversationParticipants` returns the resulting active participant id
 * list in both providers. The PostgreSQL slice used to return `true` here; it
 * now re-reads membership inside the same transaction so the answer is the
 * same shape as SQLite's. The REST route still re-reads the conversation, so no
 * caller depends on the old boolean.
 */
export type ConversationsPersistencePort = {
  createConversation(input: CreateConversationInput): PersistenceResult<StoredConversation | null>;
  getConversation(input: ConversationMemberInput): PersistenceResult<StoredConversation | null>;
  updateConversationParticipants(input: UpdateConversationParticipantsInput): PersistenceResult<string[]>;
  deleteConversation(input: ConversationMemberInput): PersistenceResult<boolean>;
  markConversationAsRead(input: ConversationMemberInput): PersistenceResult<boolean>;
  listConversationMessages(input: ListConversationMessagesInput): PersistenceResult<StoredMessage[]>;
  listConversations(input: ListConversationsInput): PersistenceResult<StoredConversation[]>;
  persistMessage(input: PersistMessageInput): PersistenceResult<StoredMessage>;
  listConversationParticipantIds(input: { conversationId: string }): PersistenceResult<string[]>;
};

/** Recipient-scoped notification inbox and message delivery. */
export type NotificationsPersistencePort = {
  listNotifications(input: NotificationListInput): PersistenceResult<NotificationRecord[]>;
  getUnreadNotificationCount(input: NotificationActorInput): PersistenceResult<number>;
  markAllNotificationsRead(input: NotificationActorInput): PersistenceResult<number>;
  markNotificationRead(input: MarkNotificationReadInput): PersistenceResult<NotificationRecord | null>;
  createNotification(input: CreateNotificationInput): PersistenceResult<NotificationReceipt>;
  /**
   * Write one inbox row per input in **a single transaction** (audit F-23).
   *
   * Deleting a work tells up to 200 commenters, and the per-row call is a
   * transaction of its own: on SQLite that is 200 `BEGIN IMMEDIATE` … `COMMIT`
   * cycles holding the write lock inside one `DELETE` request, so every other
   * writer on the instance waits behind a page of notices. The batch is the same
   * work with one transaction and one commit.
   *
   * Semantics, matching the single call row by row:
   * - the same `(userId, eventKey)` pair is an idempotent replay, reported as
   *   `duplicate: true`, not an error;
   * - the same key with a **different** payload is an `IdempotencyConflictError`;
   * - because it is one transaction, a conflict or a driver failure rolls the
   *   whole call back. Callers that need per-row isolation send smaller batches
   *   and treat a failed batch as a failed batch — never as "some of these
   *   probably landed";
   * - an empty input list is a no-op that opens no transaction and returns `[]`.
   *
   * Receipts are returned in **input order**, duplicates included, so a caller
   * can line them up with what it asked for.
   */
  createNotifications(inputs: CreateNotificationInput[]): PersistenceResult<NotificationReceipt[]>;
  deliverMessageNotifications(input: DeliverMessageNotificationsInput): PersistenceResult<boolean>;
};

/** Durable session revocation. Both providers implement these asynchronously. */
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
  claimOutboxEvents(input?: ClaimOutboxEventsInput): PersistenceResult<StoredOutboxEvent[]>;
  markOutboxDelivered(input: MarkOutboxDeliveredInput): PersistenceResult<boolean>;
  rescheduleOutboxEvent(input: RescheduleOutboxEventInput): PersistenceResult<boolean>;
  outboxBacklog(): PersistenceResult<OutboxBacklog>;
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
 * adapter, not through a domain port. It stays out of `persistencePortMethods`
 * (so no REST port table exposes it) but is part of the adapter surface and is
 * typed here so the composed store has no untyped methods left. Every media
 * method is `async` in both providers, so `Promise<T>` — not the union — is
 * the accurate result and keeps `MediaMetadataStore` compatible.
 */
export type MediaPersistencePort = {
  createMediaAsset(asset: Omit<MediaAsset, "createdAt">): Promise<MediaAsset>;
  getMediaAsset(input: { id: string }): Promise<MediaAsset | null>;
  listMediaAssets(input: ListMediaAssetsInput): Promise<MediaAsset[]>;
  listMediaScanRows(): Promise<MediaScanRow[]>;
  /**
   * Which works and profiles use these assets, read from `article_media_refs`
   * rather than by scanning every body (#163).
   *
   * The rows come back in the same `MediaScanRow` shape the scan produced, with
   * `content` holding just the asset's own id. That is deliberate: the pure
   * `extractMediaReferences` / `referencesForOwner` pair — the redaction rule
   * included — is then unchanged, so the badge a reader sees cannot drift from
   * what the old scan said.
   */
  listReferencesForAssets(input: ReferencesForAssetsInput): Promise<MediaScanRow[]>;
  deleteUnusedMediaAsset(input: DeleteUnusedMediaAssetInput): Promise<{
    deleted: MediaAsset | null; usedBy: MediaScanRow[];
  } | null>;
};

/**
 * `transaction` is a PostgreSQL-only helper used by its failure/rollback
 * integration test; the SQLite provider has private transaction helpers inside
 * its slices but exposes no public one. It is optional so both adapters can
 * satisfy the same contract without inventing a SQLite behavior change.
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
 * own concrete method signatures. There is deliberately no
 * `(...args: any[]) => any` branch: a `satisfies` check against this contract
 * cannot be forged with `as unknown as`.
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

/**
 * Fail at composition time when two slices claim the same method name.
 *
 * Object spreads would otherwise let a later slice silently overwrite an
 * earlier one; `satisfies` cannot see that. The one intentional duplicate in
 * the SQLite tree (`revokeSession` in both the session and identity slices) is
 * resolved explicitly by the composition before this guard runs.
 */
export function assertDisjointSlices(slices: ReadonlyArray<readonly [string, object]>): void {
  const owners = new Map<string, string>();
  for (const [name, slice] of slices) {
    for (const method of Object.keys(slice)) {
      const previous = owners.get(method);
      if (previous !== undefined) {
        throw new TypeError(`Persistence slice method "${method}" is defined by both ${previous} and ${name}.`);
      }
      owners.set(method, name);
    }
  }
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
        (...args: unknown[]) => {
          const operation = adapter[method];
          if (typeof operation !== "function") {
            throw new TypeError(`Persistence adapter does not implement ${port}.${method}.`);
          }
          const startedAt = process.hrtime.bigint();
          const report = (success: boolean): void => {
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
              (value: unknown) => { report(true); return value; },
              (error: unknown) => { report(false); throw error; },
            );
          }
          report(true);
          return result;
        },
      ]))),
    ]),
  )) as unknown as PersistencePorts<A>;
}
