/**
 * Persistence adapter contracts consumed by the application layer.
 *
 * Implementations return domain-shaped records, not driver-specific rows.
 * The contract intentionally groups methods by domain so a PostgreSQL,
 * MongoDB, or SQLite adapter can be tested against the same behavioral suite.
 */
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

// ---------------------------------------------------------------------------
// Domain entity shapes (intentionally permissive – stores may add fields)
// ---------------------------------------------------------------------------

export type Article = {
  id: string;
  authorId: string;
  slug: string;
  workType?: string;
  status: string;
  locale: string;
  title: string;
  summary: string;
  contentBlocks: unknown;
  contentBlocksVersion: number;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  deletedAt?: string;
  commentCount?: number;
  purgesAt?: string;
};

export type Taxonomy = {
  id: string;
  kind: string;
  slug: string;
  name: string;
  description: string;
  locale: string;
  createdBy: string;
  articleCount: number;
};

export type AuthorProfile = {
  userId: string;
  role: string;
  displayName: string;
  bio: string;
  avatarUrl: string | null;
  websiteUrl: string | null;
  locale: string;
  followerCount: number;
  followingCount: number;
  isFollowing: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AuthorSearchResult = {
  userId: string;
  displayName: string;
  bio: string;
  locale: string;
  followerCount: number;
  workCount: number;
};

export type LikeInfo = {
  articleId: string;
  slug: string;
  likeCount: number;
  likedByViewer: boolean;
} | null;

export type ArticleComment = {
  id: string;
  articleId: string;
  authorId: string;
  parentCommentId: string | null;
  content: string;
  contentBlocks: unknown;
  contentBlocksVersion: number;
  createdAt: string;
  updatedAt: string;
  locale: string;
  replies: ArticleComment[];
};

export type Conversation = {
  id: string;
  createdBy: string | null;
  participantIds: string[];
  createdAt: string;
  lastActivityAt: string;
  unreadCount: number;
  lastMessage: Message | null;
};

export type Message = {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  createdAt: string;
  duplicate?: boolean;
};

export type Notification = {
  id: string;
  userId: string;
  eventKey: string;
  payload: unknown;
  createdAt: string;
  readAt: string | null;
};

export type MediaAsset = {
  id: string;
  ownerId: string;
  storageKey: string;
  contentType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  sha256: string;
  createdAt: string;
};

export type MediaScanRow =
  | { kind: "work"; content: string; work: { articleId: string; slug: string; status: string; deletedAt: string | null; locale: string; title: string; authorId: string } }
  | { kind: "avatar"; content: string };

export type MediaDeleteResult = {
  deleted: MediaAsset | null;
  usedBy: MediaScanRow[];
} | null;

export type OutboxEvent = {
  id: string;
  event_key: string;
  event_type: string;
  aggregate_id: string;
  payload: unknown;
  attempts: number;
  available_at: string;
  lease_token: string | null;
};

export type OutboxBacklog = {
  pendingEvents: number;
  oldestPendingAgeMs: number;
};

// Identity / session domain
export type IdentitySession = {
  sessionId: string;
  userId: string;
  accessTokenId: string;
  refreshHash: string;
  expiresAt: string;
  accessExpiresAt: string;
  issuedAt?: string;
};

export type IdentityAccountResult = { userId: string; passwordHash: string } | null;
export type IdentityAccountByUserIdResult = { userId: string; email: string; emailVerifiedAt: string | null } | null;
export type IdentityCredentialsResult = { userId: string; passwordHash: string } | null;
export type IdentityTokenConsumeResult = { userId: string; email: string } | null;
export type RotateIdentityRefreshResult =
  | { status: "invalid" }
  | { status: "reused" }
  | { status: "rotated"; userId: string; sessionId: string; accessExpiresAt: string; refreshExpiresAt: string };
export type IdentitySessionListItem = { sessionId: string; createdAt: string; lastUsedAt: string | null; expiresAt: string };
export type PruneResult = { sessions: number; rateLimits: number; revokedSessions: number; identityTokens: number };
export type RateLimitResult = { allowed: boolean; resetAt: string };

// ---------------------------------------------------------------------------
// Typed persistence adapter contract
// ---------------------------------------------------------------------------

export type TypedPersistenceAdapterContract = {
  // content – payload fields are optional so service/route spreading of
  // `Record<string, unknown>` validates at runtime (via domain validators)
  // while a misspelled key is still an excess-property compile error.
  listPublishedArticles(input?: { locale?: string; query?: string; authorId?: string | null; sort?: string; limit?: number; offset?: number; cursor?: string | null }): Promise<Article[]>;
  getPublishedArticle(input: { slug: string; locale?: string }): Promise<Article | null>;
  listMyArticles(input: { actorId: string; locale?: string; limit?: number }): Promise<Article[]>;
  createArticle(input: { authorId: string; slug?: string; title?: string; summary?: string; locale?: string; contentBlocks?: unknown; contentBlocksVersion?: number; publish?: boolean; workType?: string; categoryIds?: string[]; tagIds?: string[]; idempotencyKey?: string | null; requestedSlug?: string | null }): Promise<Article>;
  updateArticle(input: { articleId: string; actorId: string; slug?: string; title?: string; summary?: string; locale?: string; contentBlocks?: unknown; contentBlocksVersion?: number; publish?: boolean; workType?: string; categoryIds?: string[] | undefined; tagIds?: string[] | undefined }): Promise<Article>;
  deleteArticle(input: { articleId: string; actorId: string }): Promise<{ id: string; deletedAt: string }>;
  restoreArticle(input: { articleId: string; actorId: string; locale?: string }): Promise<Article>;
  listMyDeletedArticles(input: { actorId: string; locale?: string; limit?: number }): Promise<Article[]>;
  purgeExpiredArticles(input?: { retentionDays?: number; now?: Date | string; limit?: number }): Promise<{ purged: number }>;
  listLikedArticles(input: { actorId: string; locale?: string; limit?: number }): Promise<Article[]>;
  listRelatedArticles(input: { slug: string; locale?: string; limit?: number }): Promise<Article[]>;
  listFollowingArticles(input: { actorId: string; locale?: string; limit?: number; offset?: number }): Promise<Article[]>;
  listFeaturedArticles(input?: { locale?: string; limit?: number; offset?: number }): Promise<Article[]>;
  setFeaturedArticles(input: { actorId: string; actorIsEditor?: boolean; articleIds: string[]; locale?: string }): Promise<Article[]>;

  // taxonomy
  listTaxonomies(input: { kind: string; locale?: string; query?: string; limit?: number; offset?: number }): Promise<Taxonomy[]>;
  getTaxonomyBySlug(input: { kind: string; slug: string; locale?: string }): Promise<Taxonomy | null>;
  listTaxonomyArticles(input: { kind: string; slug: string; locale?: string; limit?: number; offset?: number }): Promise<Article[]>;
  listArticleTaxonomies(input: { articleId: string; kind: string; locale?: string }): Promise<Taxonomy[]>;
  createTag(input: { actorId: string; name: string; locale?: string }): Promise<Taxonomy>;
  createTaxonomy(input: { actorId: string; actorIsEditor?: boolean; kind: string; slug: string; name: string; description?: string; locale?: string }): Promise<Taxonomy>;
  deleteTaxonomy(input: { taxonomyId: string; actorId: string; actorIsEditor?: boolean }): Promise<boolean>;

  // profiles
  getAuthorProfile(input: { userId: string; locale?: string; viewerId?: string | null }): Promise<AuthorProfile | null>;
  searchUsers(input: { query: string; locale?: string; viewerId?: string | null; limit?: number }): Promise<AuthorProfile[]>;
  searchAuthors(input: { query?: string; locale?: string; limit?: number; offset?: number }): Promise<AuthorSearchResult[]>;
  listFollowing(input: { userId: string; locale?: string; viewerId?: string | null; limit?: number }): Promise<AuthorProfile[]>;
  listFollowers(input: { userId: string; locale?: string; viewerId?: string | null; limit?: number }): Promise<AuthorProfile[]>;
  followUser(input: { actorId: string; targetUserId: string }): Promise<boolean>;
  unfollowUser(input: { actorId: string; targetUserId: string }): Promise<boolean>;
  upsertAuthorProfile(input: { userId: string; displayName?: string; bio?: string; avatarUrl?: string | null | undefined; websiteUrl?: string | null | undefined; locale?: string }): Promise<AuthorProfile>;
  getUserRole(input: { userId: string }): Promise<string>;
  setUserRole(input: { actorId: string; userId: string; role: string }): Promise<string>;

  // engagement
  getArticleLikeInfo(input: { slug: string; locale?: string; actorId?: string | null }): Promise<LikeInfo>;
  toggleArticleLike(input: { slug: string; locale?: string; actorId: string }): Promise<LikeInfo>;
  setArticleLike(input: { slug: string; locale?: string; actorId: string; liked: boolean }): Promise<LikeInfo>;
  listArticleComments(input: { slug: string; locale?: string; limit?: number }): Promise<ArticleComment[]>;
  createArticleComment(input: { slug: string; locale?: string; actorId: string; content: string; contentBlocks?: unknown; contentBlocksVersion?: number; parentCommentId?: string | null; idempotencyKey?: string | null }): Promise<ArticleComment>;
  deleteArticleComment(input: { commentId: string; actorId: string }): Promise<boolean>;
  listArticleCommentAuthorIds(input: { articleId: string; limit?: number }): Promise<string[]>;

  // conversations
  createConversation(input: { actorId: string; participantIds: string[]; idempotencyKey?: string | null }): Promise<Conversation>;
  getConversation(input: { conversationId: string; actorId: string }): Promise<Conversation | null>;
  updateConversationParticipants(input: { conversationId: string; actorId: string; addUserIds?: string[]; removeUserIds?: string[] }): Promise<boolean>;
  deleteConversation(input: { conversationId: string; actorId: string }): Promise<boolean>;
  markConversationAsRead(input: { conversationId: string; actorId: string }): Promise<boolean>;
  listConversationMessages(input: { conversationId: string; actorId: string; limit?: number; before?: string | null }): Promise<Message[]>;
  listConversations(input: { actorId: string; limit?: number }): Promise<Conversation[]>;
  persistMessage(input: { conversationId: string; senderId: string; body: string; idempotencyKey: string }): Promise<Message>;
  listConversationParticipantIds(input: { conversationId: string }): Promise<string[]>;

  // notifications
  listNotifications(input: { actorId: string; limit?: number }): Promise<Notification[]>;
  getUnreadNotificationCount(input: { actorId: string }): Promise<number>;
  markAllNotificationsRead(input: { actorId: string }): Promise<number>;
  markNotificationRead(input: { notificationId: string; actorId: string }): Promise<Notification | null>;
  createNotification(input: { userId: string; eventKey: string; payload: unknown }): Promise<{ id: string; userId: string; eventKey: string; payload: unknown; createdAt: string; duplicate?: boolean }>;
  deliverMessageNotifications(input: { eventKey: string; messageId: string; conversationId: string; senderId: string }): Promise<boolean>;

  // sessions
  revokeSession(input: { sessionId: string; expiresAt: string | Date }): Promise<boolean>;
  isSessionRevoked(sessionId: string): Promise<boolean>;

  // identity
  createIdentityAccount(input: { userId: string; email: string; passwordHash: string; session: IdentitySession; displayName?: string }): Promise<boolean>;
  findIdentityAccount(input: { email: string }): Promise<IdentityAccountResult>;
  findIdentityAccountByUserId(input: { userId: string }): Promise<IdentityAccountByUserIdResult>;
  findIdentityCredentials(input: { userId: string }): Promise<IdentityCredentialsResult>;
  createIdentitySession(input: IdentitySession): Promise<boolean>;
  rotateIdentityRefresh(input: { refreshHash: string; nextRefreshHash: string; accessTokenId: string; issuedAt: string; accessExpiresAt: string }): Promise<RotateIdentityRefreshResult>;
  revokeIdentityRefresh(input: { refreshHash: string }): Promise<boolean>;
  replaceIdentityPassword(input: { userId: string; passwordHash: string; exceptSessionId?: string | null }): Promise<{ updated: boolean; revokedSessions: number }>;
  setIdentityEmail(input: { userId: string; email: string }): Promise<boolean>;
  markIdentityEmailVerified(input: { userId: string; verifiedAt: string | Date }): Promise<boolean>;
  listIdentitySessions(input: { userId: string; limit: number }): Promise<IdentitySessionListItem[]>;
  revokeIdentitySession(input: { userId: string; sessionId: string }): Promise<boolean>;
  revokeIdentitySessions(input: { userId: string; exceptSessionId?: string | null }): Promise<number>;
  issueIdentityToken(input: { userId: string; purpose: string; email: string; tokenHash: string; expiresAt: string | Date }): Promise<boolean>;
  consumeIdentityToken(input: { tokenHash: string; purpose: string }): Promise<IdentityTokenConsumeResult>;
  pruneExpiredIdentityState(): Promise<PruneResult>;

  // rateLimits
  consumeRateLimit(input: { key: string; limit: number; windowSeconds: number }): Promise<RateLimitResult>;

  // outbox
  claimOutboxEvents(input?: { limit?: number; leaseSeconds?: number }): Promise<OutboxEvent[]>;
  markOutboxDelivered(input: { eventId: string; leaseToken: string }): Promise<boolean>;
  rescheduleOutboxEvent(input: { eventId: string; leaseToken: string; delaySeconds?: number }): Promise<boolean>;
  outboxBacklog(): Promise<OutboxBacklog>;

  // operations
  health(): Promise<boolean>;

  // media (portable library – not in persistencePortMethods but part of the adapter)
  createMediaAsset?(input: { id: string; ownerId: string; storageKey: string; contentType: string; byteSize: number; width?: number | null; height?: number | null; sha256: string }): Promise<MediaAsset>;
  getMediaAsset?(input: { id: string }): Promise<MediaAsset | null>;
  listMediaScanRows?(): Promise<MediaScanRow[]>;
  listMediaAssets?(input: { ownerId: string; cursor?: { at: string; id: string } | null; limit?: number }): Promise<MediaAsset[]>;
  deleteUnusedMediaAsset?(input: { id: string; ownerId: string }): Promise<MediaDeleteResult>;

  // generic helper not in port table
  transaction?(work: (tx: unknown) => unknown): unknown;
};

/**
 * Backwards-compatible aliases – the SQLite and PostgreSQL adapters annotate
 * their return value with `PersistenceAdapterContract`. After #167 this is
 * a fully-typed contract; the old `Record<string, (...args:any[])=>any>`
 * escape hatch is removed.
 */
export type PersistenceAdapterContract = TypedPersistenceAdapterContract;
export type PersistenceAdapterMethods = TypedPersistenceAdapterContract;

/** Domain-grouped repository ports, typed from the adapter that backs them. */
export type PersistencePorts<A extends TypedPersistenceAdapterContract = TypedPersistenceAdapterContract> = {
  [K in PortName]: { [M in PortMethodName<K>]: A[M] };
};

export function assertPersistenceAdapter<T extends TypedPersistenceAdapterContract>(adapter: T): T {
  if (!adapter || typeof adapter !== "object") {
    throw new TypeError("A persistence adapter object is required.");
  }
  const missing = Object.entries(persistencePortMethods)
    .flatMap(([port, methods]) => methods
      .filter((method) => typeof (adapter as Record<string, unknown>)[method as string] !== "function")
      .map((method) => `${port}.${method}`));
  if (missing.length > 0) {
    throw new TypeError("Persistence adapter is missing required operations: " + missing.join(", "));
  }
  return adapter;
}

/** Group a flat adapter into domain-specific repository ports. */
export function createPersistencePorts<A extends TypedPersistenceAdapterContract = TypedPersistenceAdapterContract>(
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
          const operation = (adapter as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
          if (typeof operation !== "function") {
            throw new TypeError(`Persistence adapter does not implement ${port}.${method}.`);
          }
          const startedAt = process.hrtime.bigint();
          const report = (success: boolean) => {
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
          let result: unknown;
          try {
            result = Reflect.apply(operation, adapter, args);
          } catch (error) {
            report(false);
            throw error;
          }
          if (result !== null && (typeof result === "object" || typeof result === "function") &&
              typeof (result as { then?: unknown }).then === "function") {
            return (result as Promise<unknown>).then(
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
