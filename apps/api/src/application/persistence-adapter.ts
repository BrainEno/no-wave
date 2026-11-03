/**
 * The typed persistence contract (issue #167, closing #66).
 *
 * `persistence-ports.ts` answers "which methods must an adapter have"; this file
 * answers "what does each one take and return". The two are kept apart because
 * the first is a runtime table (`persistencePortMethods`, asserted at startup)
 * and the second is compile-time only.
 *
 * Before this, the contract was `Record<string, (...args: any[]) => any>`, so a
 * call site could pass `{ userId }` to a method that reads `{ actorId }`, or read
 * a field no adapter returns, and both would compile. Every signature below is
 * taken from what the two adapters actually do — the SQLite and PostgreSQL
 * implementations must each satisfy it, which is what makes a renamed parameter
 * or a forgotten return field a `pnpm typecheck` failure.
 */
import type {
  ActorInput,
  Article,
  ArticleActorInput,
  ArticleComment,
  ArticleLikeInfo,
  ArticleSlugInput,
  AuthorDirectoryEntry,
  AuthorProfile,
  ClaimOutboxEventsInput,
  ConsumeIdentityTokenInput,
  ConsumeRateLimitInput,
  Conversation,
  ConversationActorInput,
  ConversationIdInput,
  CreateArticleCommentInput,
  CreateArticleInput,
  CreateConversationInput,
  CreateIdentityAccountInput,
  CreateMediaAssetInput,
  CreateNotificationInput,
  CreateTagInput,
  CreateTaxonomyInput,
  DeletedArticle,
  DeleteArticleCommentInput,
  DeleteTaxonomyInput,
  DeleteUnusedMediaAssetInput,
  DeleteUnusedMediaAssetResult,
  DeliverMessageNotificationsInput,
  FindIdentityAccountInput,
  FollowUserInput,
  GetAuthorProfileInput,
  GetMediaAssetInput,
  GetPublishedArticleInput,
  GetTaxonomyBySlugInput,
  GetUserRoleInput,
  IdentityAccount,
  IdentityAccountRecord,
  IdentityCredentials,
  IdentitySession,
  IdentitySessionSeed,
  IdentityTokenGrant,
  IdentityUserInput,
  IssueIdentityTokenInput,
  ListArticleCommentAuthorIdsInput,
  ListArticleCommentsInput,
  ListArticleTaxonomiesInput,
  ListByLocaleInput,
  ListConversationMessagesInput,
  ListConversationsInput,
  ListIdentitySessionsInput,
  ListMediaAssetsInput,
  ListNotificationsInput,
  ListOwnArticlesInput,
  ListProfilesInput,
  ListPublishedArticlesInput,
  ListRelatedArticlesInput,
  ListTaxonomiesInput,
  ListTaxonomyArticlesInput,
  MarkIdentityEmailVerifiedInput,
  MarkNotificationReadInput,
  MediaAsset,
  MediaScanRow,
  Message,
  NotificationRecord,
  OutboxBacklog,
  OutboxEvent,
  OutboxLeaseInput,
  PersistenceResult,
  PersistMessageInput,
  PrunedIdentityState,
  PurgeExpiredArticlesInput,
  RateLimitDecision,
  RefreshRotation,
  ReplaceIdentityPasswordInput,
  RescheduleOutboxEventInput,
  RestoreArticleInput,
  RevokeIdentityRefreshInput,
  RevokeIdentitySessionInput,
  RevokeIdentitySessionsInput,
  RevokeSessionInput,
  RotateIdentityRefreshInput,
  SearchAuthorsInput,
  SearchUsersInput,
  SetArticleLikeInput,
  SetFeaturedArticlesInput,
  SetIdentityEmailInput,
  SetUserRoleInput,
  Taxonomy,
  UpdateArticleInput,
  UpdateConversationParticipantsInput,
  UpsertAuthorProfileInput,
} from "./persistence-port-types.ts";

/** `DELETE /articles/:id` answers which work it tombstoned, and from when. */
export type DeletedArticleReceipt = { id: string; deletedAt: string };

/** `purgeExpiredArticles` is the only irreversible step, and it says how many. */
export type PurgeReceipt = { purged: number };

/** A password replacement reports both halves: the credential and the devices. */
export type PasswordReplacementReceipt = { updated: boolean; revokedSessions: number };

/** A created notification, and whether the event key had already produced it. */
export type NotificationReceipt = {
  id: string;
  userId: string;
  eventKey: string;
  payload: unknown;
  createdAt: string;
  duplicate: boolean;
};

/**
 * One signature per port method.
 *
 * Parameter shape, not parameter count: an adapter is free to destructure or to
 * take the whole object, but it must accept exactly this, and callers may rely
 * on exactly this answer.
 */
export type PersistencePortSignatures = {
  // content
  listPublishedArticles: (input?: ListPublishedArticlesInput) => PersistenceResult<Article[]>;
  getPublishedArticle: (input: GetPublishedArticleInput) => PersistenceResult<Article | null>;
  listMyArticles: (input: ListOwnArticlesInput) => PersistenceResult<Article[]>;
  createArticle: (input: CreateArticleInput) => PersistenceResult<Article>;
  updateArticle: (input: UpdateArticleInput) => PersistenceResult<Article>;
  deleteArticle: (input: ArticleActorInput) => PersistenceResult<DeletedArticleReceipt>;
  restoreArticle: (input: RestoreArticleInput) => PersistenceResult<Article>;
  listMyDeletedArticles: (input: ListOwnArticlesInput) => PersistenceResult<DeletedArticle[]>;
  purgeExpiredArticles: (input?: PurgeExpiredArticlesInput) => PersistenceResult<PurgeReceipt>;
  listLikedArticles: (input: ListOwnArticlesInput) => PersistenceResult<Article[]>;
  listRelatedArticles: (input: ListRelatedArticlesInput) => PersistenceResult<Article[]>;
  listFollowingArticles: (input: ListOwnArticlesInput & { offset?: number }) => PersistenceResult<Article[]>;
  listFeaturedArticles: (input?: ListByLocaleInput) => PersistenceResult<Article[]>;
  setFeaturedArticles: (input: SetFeaturedArticlesInput) => PersistenceResult<Article[]>;

  // taxonomy
  listTaxonomies: (input?: Partial<ListTaxonomiesInput>) => PersistenceResult<Taxonomy[]>;
  getTaxonomyBySlug: (input: GetTaxonomyBySlugInput) => PersistenceResult<Taxonomy | null>;
  listTaxonomyArticles: (input: ListTaxonomyArticlesInput) => PersistenceResult<Article[]>;
  listArticleTaxonomies: (input: ListArticleTaxonomiesInput) => PersistenceResult<Taxonomy[]>;
  createTag: (input: CreateTagInput) => PersistenceResult<Taxonomy>;
  createTaxonomy: (input: CreateTaxonomyInput) => PersistenceResult<Taxonomy>;
  deleteTaxonomy: (input: DeleteTaxonomyInput) => PersistenceResult<boolean>;

  // profiles
  getAuthorProfile: (input: GetAuthorProfileInput) => PersistenceResult<AuthorProfile | null>;
  searchUsers: (input: SearchUsersInput) => PersistenceResult<AuthorProfile[]>;
  searchAuthors: (input?: Partial<SearchAuthorsInput>) => PersistenceResult<AuthorDirectoryEntry[]>;
  listFollowing: (input: ListProfilesInput) => PersistenceResult<AuthorProfile[]>;
  listFollowers: (input: ListProfilesInput) => PersistenceResult<AuthorProfile[]>;
  followUser: (input: FollowUserInput) => PersistenceResult<boolean>;
  unfollowUser: (input: FollowUserInput) => PersistenceResult<boolean>;
  upsertAuthorProfile: (input: UpsertAuthorProfileInput) => PersistenceResult<AuthorProfile>;
  getUserRole: (input: GetUserRoleInput) => PersistenceResult<string>;
  setUserRole: (input: SetUserRoleInput) => PersistenceResult<string>;

  // engagement
  getArticleLikeInfo: (input: ArticleSlugInput) => PersistenceResult<ArticleLikeInfo | null>;
  toggleArticleLike: (input: ArticleSlugInput & { actorId: string }) => PersistenceResult<ArticleLikeInfo | null>;
  setArticleLike: (input: SetArticleLikeInput) => PersistenceResult<ArticleLikeInfo | null>;
  listArticleComments: (input: ListArticleCommentsInput) => PersistenceResult<ArticleComment[]>;
  createArticleComment: (input: CreateArticleCommentInput) => PersistenceResult<ArticleComment>;
  deleteArticleComment: (input: DeleteArticleCommentInput) => PersistenceResult<boolean>;
  listArticleCommentAuthorIds: (input: ListArticleCommentAuthorIdsInput) => PersistenceResult<string[]>;

  // conversations
  createConversation: (input: CreateConversationInput) => PersistenceResult<Conversation | null>;
  getConversation: (input: ConversationActorInput) => PersistenceResult<Conversation | null>;
  updateConversationParticipants: (input: UpdateConversationParticipantsInput) => PersistenceResult<boolean>;
  deleteConversation: (input: ConversationActorInput) => PersistenceResult<boolean>;
  markConversationAsRead: (input: ConversationActorInput) => PersistenceResult<boolean>;
  listConversationMessages: (input: ListConversationMessagesInput) => PersistenceResult<Message[]>;
  listConversations: (input: ListConversationsInput) => PersistenceResult<Conversation[]>;
  persistMessage: (input: PersistMessageInput) => PersistenceResult<Message>;
  listConversationParticipantIds: (input: ConversationIdInput) => PersistenceResult<string[]>;

  // notifications
  listNotifications: (input: ListNotificationsInput) => PersistenceResult<NotificationRecord[]>;
  getUnreadNotificationCount: (input: ActorInput) => PersistenceResult<number>;
  markAllNotificationsRead: (input: ActorInput) => PersistenceResult<number>;
  markNotificationRead: (input: MarkNotificationReadInput) => PersistenceResult<NotificationRecord | null>;
  createNotification: (input: CreateNotificationInput) => PersistenceResult<NotificationReceipt>;
  deliverMessageNotifications: (input: DeliverMessageNotificationsInput) => PersistenceResult<boolean>;

  // sessions
  revokeSession: (input: RevokeSessionInput) => PersistenceResult<boolean>;
  isSessionRevoked: (sessionId: string) => PersistenceResult<boolean>;

  // identity
  createIdentityAccount: (input: CreateIdentityAccountInput) => PersistenceResult<boolean>;
  findIdentityAccount: (input: FindIdentityAccountInput) => PersistenceResult<IdentityAccount | null>;
  findIdentityAccountByUserId: (input: IdentityUserInput) => PersistenceResult<IdentityAccountRecord | null>;
  findIdentityCredentials: (input: IdentityUserInput) => PersistenceResult<IdentityCredentials | null>;
  createIdentitySession: (session: IdentitySessionSeed) => PersistenceResult<boolean>;
  rotateIdentityRefresh: (input: RotateIdentityRefreshInput) => PersistenceResult<RefreshRotation>;
  revokeIdentityRefresh: (input: RevokeIdentityRefreshInput) => PersistenceResult<boolean>;
  replaceIdentityPassword: (input: ReplaceIdentityPasswordInput) => PersistenceResult<PasswordReplacementReceipt>;
  setIdentityEmail: (input: SetIdentityEmailInput) => PersistenceResult<boolean>;
  markIdentityEmailVerified: (input: MarkIdentityEmailVerifiedInput) => PersistenceResult<boolean>;
  listIdentitySessions: (input: ListIdentitySessionsInput) => PersistenceResult<IdentitySession[]>;
  revokeIdentitySession: (input: RevokeIdentitySessionInput) => PersistenceResult<boolean>;
  revokeIdentitySessions: (input: RevokeIdentitySessionsInput) => PersistenceResult<number>;
  issueIdentityToken: (input: IssueIdentityTokenInput) => PersistenceResult<boolean>;
  consumeIdentityToken: (input: ConsumeIdentityTokenInput) => PersistenceResult<IdentityTokenGrant>;
  pruneExpiredIdentityState: () => PersistenceResult<PrunedIdentityState>;

  // rate limits
  consumeRateLimit: (input: ConsumeRateLimitInput) => PersistenceResult<RateLimitDecision>;

  // outbox
  claimOutboxEvents: (input?: ClaimOutboxEventsInput) => PersistenceResult<OutboxEvent[]>;
  markOutboxDelivered: (input: OutboxLeaseInput) => PersistenceResult<boolean>;
  rescheduleOutboxEvent: (input: RescheduleOutboxEventInput) => PersistenceResult<boolean>;
  outboxBacklog: () => PersistenceResult<OutboxBacklog>;

  // operations
  health: () => PersistenceResult<boolean>;

  // media (the library metadata port; the bytes live in object storage)
  createMediaAsset: (asset: CreateMediaAssetInput) => PersistenceResult<MediaAsset>;
  getMediaAsset: (input: GetMediaAssetInput) => PersistenceResult<MediaAsset | null>;
  listMediaAssets: (input: ListMediaAssetsInput) => PersistenceResult<MediaAsset[]>;
  listMediaScanRows: () => PersistenceResult<MediaScanRow[]>;
  deleteUnusedMediaAsset: (input: DeleteUnusedMediaAssetInput) => PersistenceResult<DeleteUnusedMediaAssetResult>;
};

export type PersistencePortMethod = keyof PersistencePortSignatures;

/** Re-exported for `persistence-ports.ts`, which references the seed type. */
export type { IdentitySessionSeed } from "./persistence-port-types.ts";

/**
 * The typed adapter contract.
 *
 * `PersistenceAdapterContract` in `persistence-ports.ts` keeps the runtime port
 * table and this signature map together, so the set of methods an adapter must
 * expose and the types it must honour cannot drift apart.
 */
export type TypedPersistenceAdapterContract = {
  readonly [M in PersistencePortMethod]: PersistencePortSignatures[M];
};

/**
 * The connection-level members that belong to no application port.
 *
 * `transaction` is the provider's own transaction boundary (a `sql.begin` or a
 * `BEGIN IMMEDIATE`) and `isSessionRevoked` is the pre-identity session check the
 * identity slice still answers. Neither is reachable from a transport, and both
 * are still required of every adapter so the startup assertion and the compiler
 * agree on what "an adapter" is.
 */
export type PersistenceAdapterInfrastructure = {
  readonly transaction: (work: (tx: unknown) => unknown) => PersistenceResult<unknown>;
  readonly isSessionRevoked: (sessionId: string) => PersistenceResult<boolean>;
};
