/**
 * Typed signatures for the persistence ports (issue #167, closing #66).
 *
 * `persistence-ports.ts` owns *which* methods a port has. This module owns what
 * they take and what they return, so a call site that passes `{ userId }` to a
 * method that wants `{ actorId }`, or reads a field the adapter never returns,
 * fails `pnpm typecheck` instead of failing on the one branch no test covers.
 *
 * The shapes below are the adapter's observable contract, not the database's
 * rows: both providers map their columns into these objects, which is why the
 * row mappers are the only place a `snake_case` name appears.
 *
 * They are deliberately *narrow* rather than inferred from an implementation.
 * An inference would inherit `any` from whichever adapter happened to be
 * checked first, and the point of the exercise is to stop that spreading.
 */

/**
 * A port answer that may arrive inline or as a promise.
 *
 * SQLite (`node:sqlite`) answers synchronously and PostgreSQL answers
 * asynchronously; the port describes both, and every call site awaits anyway.
 */
export type PersistenceResult<T> = T | Promise<T>;

/** The locales a work, taxonomy or profile translation can be written in. */
export type PersistenceLocale = string;

/** Every read that a locale applies to takes one; `zh-CN` is the default. */
type LocaleArgs = { locale?: PersistenceLocale };

export type ArticleStatus = "draft" | "published";

export type Article = {
  id: string;
  authorId: string;
  slug: string;
  workType: string;
  status: ArticleStatus | string;
  locale: PersistenceLocale;
  title: string;
  summary: string;
  contentBlocks: unknown;
  contentBlocksVersion: number;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
};

/** A tombstone as the recycle bin shows it: the work plus when and what it costs. */
export type DeletedArticle = Article & { deletedAt: string | null; commentCount: number };

export type TaxonomyKind = "category" | "tag";

export type Taxonomy = {
  id: string;
  kind: TaxonomyKind;
  slug: string;
  name: string;
  description: string;
  locale: PersistenceLocale;
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
  locale: PersistenceLocale;
  followerCount: number;
  followingCount: number;
  isFollowing: boolean;
  createdAt: string;
  updatedAt: string;
};

/**
 * A directory entry (ADR 0024).
 *
 * Narrower than `AuthorProfile` on purpose: the directory lists writers by reach
 * and output, and it must not become a second way to read a profile — including
 * a viewer-specific `isFollowing` the query never asked for.
 */
export type AuthorDirectoryEntry = {
  userId: string;
  displayName: string;
  bio: string;
  locale: PersistenceLocale;
  followerCount: number;
  workCount: number;
};

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
  locale: PersistenceLocale;
  replies: ArticleComment[];
};

/** Whether one viewer saved a work, and how many readers did. */
export type ArticleLikeInfo = { articleId: string; slug: string; likeCount: number; likedByViewer: boolean };

export type Message = {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  createdAt: string;
  /** True when the write answered a retried request with the original message. */
  duplicate: boolean;
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

export type NotificationRecord = {
  id: string;
  userId: string;
  eventKey: string;
  payload: unknown;
  createdAt: string;
  readAt: string | null;
};

export type OutboxEvent = {
  id: string;
  event_key: string;
  event_type: string;
  aggregate_id: string;
  payload: unknown;
  attempts: number;
  available_at: string;
  lease_token: string;
};

export type OutboxBacklog = { pendingEvents: number; oldestPendingAgeMs: number };

export type MediaAsset = {
  id: string;
  ownerId: string;
  storageKey: string;
  contentType: "image/webp" | string;
  byteSize: number;
  width: number;
  height: number;
  sha256: string;
  createdAt: string;
};

/** One place a media URL lives, as the reference scan reads it (ADR 0022). */
export type MediaScanRow = {
  kind: "work" | "avatar";
  content: unknown;
  work?: {
    articleId: string;
    slug: string;
    status: string;
    deletedAt: string | null;
    locale: PersistenceLocale;
    title: string;
    authorId: string;
  };
};

export type MediaCursor = { at: string; id: string } | null;

export type IdentityAccount = { userId: string; passwordHash: string };

export type IdentityCredentials = { userId: string; passwordHash: string };

export type IdentityAccountRecord = {
  userId: string;
  email: string;
  emailVerifiedAt: string | null;
};

export type IdentityTokenGrant = { userId: string; email: string } | null;

export type IdentitySession = {
  sessionId: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
};

/** The session a caller hands to `createIdentityAccount`/`createIdentitySession`. */
export type IdentitySessionSeed = {
  sessionId: string;
  userId: string;
  accessTokenId: string;
  refreshHash: string;
  expiresAt: string;
  accessExpiresAt: string;
};

/**
 * The answer to a refresh attempt.
 *
 * Four outcomes, not a boolean: "invalid" and "reused" must be tellable apart,
 * because a reused token revokes the family and a merely expired one does not.
 */
export type RefreshRotation =
  | { status: "invalid" }
  | { status: "reused" }
  | {
    status: "rotated";
    userId: string;
    sessionId: string;
    accessExpiresAt: string;
    refreshExpiresAt: string;
  };

export type PrunedIdentityState = {
  sessions: number;
  rateLimits: number;
  revokedSessions: number;
  identityTokens: number;
};

export type RateLimitDecision = { allowed: boolean; resetAt: string };

// ---------------------------------------------------------------------------
// Port inputs. One type per method that takes an object, so a call site and a
// provider implementation cannot drift apart in a parameter name.
// ---------------------------------------------------------------------------

export type ListPublishedArticlesInput = LocaleArgs & {
  query?: string;
  authorId?: string | null;
  sort?: "latest" | "popular";
  limit?: number;
  offset?: number;
  /** Base64url keyset cursor; mutually exclusive with `offset`. */
  cursor?: string | null;
};

export type GetPublishedArticleInput = LocaleArgs & { slug: string };

export type ListOwnArticlesInput = LocaleArgs & { actorId: string; limit?: number };

export type CreateArticleInput = LocaleArgs & {
  authorId: string;
  slug: string;
  title: string;
  summary?: string;
  contentBlocks: unknown;
  contentBlocksVersion?: number;
  publish?: boolean;
  workType?: string;
  categoryIds?: string[];
  tagIds?: string[];
  idempotencyKey?: string | null;
  /** The address the client asked for, when it asked for one (see #137/#157). */
  requestedSlug?: string | null;
};

export type UpdateArticleInput = LocaleArgs & {
  articleId: string;
  actorId: string;
  slug: string;
  title: string;
  summary?: string;
  contentBlocks: unknown;
  contentBlocksVersion?: number;
  publish?: boolean;
  workType?: string;
  categoryIds?: string[];
  tagIds?: string[];
};

export type ArticleActorInput = { articleId: string; actorId: string };

export type RestoreArticleInput = ArticleActorInput & LocaleArgs;

export type PurgeExpiredArticlesInput = {
  retentionDays?: number;
  now?: Date | string;
  limit?: number;
};

export type ListByLocaleInput = LocaleArgs & { limit?: number; offset?: number };

export type ListRelatedArticlesInput = LocaleArgs & { slug: string; limit?: number };

export type SetFeaturedArticlesInput = LocaleArgs & {
  actorId: string;
  actorIsEditor?: boolean;
  articleIds: string[];
};

export type ListTaxonomiesInput = LocaleArgs & {
  kind?: TaxonomyKind;
  query?: string;
  limit?: number;
  offset?: number;
};

export type GetTaxonomyBySlugInput = LocaleArgs & { kind: TaxonomyKind; slug: string };

export type ListTaxonomyArticlesInput = LocaleArgs & {
  kind: TaxonomyKind;
  slug: string;
  limit?: number;
  offset?: number;
};

export type ListArticleTaxonomiesInput = LocaleArgs & { articleId: string; kind: TaxonomyKind };

export type CreateTagInput = LocaleArgs & { actorId: string; name: string };

export type CreateTaxonomyInput = LocaleArgs & {
  actorId: string;
  actorIsEditor?: boolean;
  kind: TaxonomyKind;
  slug: string;
  name: string;
  description?: string;
};

export type DeleteTaxonomyInput = { taxonomyId: string; actorId: string; actorIsEditor?: boolean };

export type GetAuthorProfileInput = LocaleArgs & { userId: string; viewerId?: string | null };

export type GetUserRoleInput = { userId: string };

export type SetUserRoleInput = { actorId: string; userId: string; role: string };

export type SearchAuthorsInput = LocaleArgs & { query?: string; limit?: number; offset?: number };

export type SearchUsersInput = LocaleArgs & { query: string; viewerId?: string | null; limit?: number };

export type ListProfilesInput = LocaleArgs & { userId: string; viewerId?: string | null; limit?: number };

export type FollowUserInput = { actorId: string; targetUserId: string };

export type UpsertAuthorProfileInput = LocaleArgs & {
  userId: string;
  displayName: string;
  bio?: string;
  avatarUrl?: string | null;
  websiteUrl?: string | null;
};

export type ArticleSlugInput = LocaleArgs & { slug: string; actorId?: string | null };

export type SetArticleLikeInput = LocaleArgs & { slug: string; actorId: string; liked: boolean };

export type ListArticleCommentsInput = LocaleArgs & { slug: string; limit?: number };

export type CreateArticleCommentInput = LocaleArgs & {
  slug: string;
  actorId: string;
  content: string;
  contentBlocks?: unknown;
  contentBlocksVersion?: number;
  parentCommentId?: string | null;
  idempotencyKey?: string | null;
};

export type DeleteArticleCommentInput = { commentId: string; actorId: string };

export type ListArticleCommentAuthorIdsInput = { articleId: string; limit?: number };

export type CreateConversationInput = { actorId: string; participantIds: string[]; idempotencyKey?: string | null };

export type ConversationActorInput = { conversationId: string; actorId: string };

export type UpdateConversationParticipantsInput = ConversationActorInput & {
  addUserIds?: string[];
  removeUserIds?: string[];
};

export type ListConversationMessagesInput = ConversationActorInput & {
  limit?: number;
  before?: string | null;
};

export type ListConversationsInput = { actorId: string; limit?: number };

export type PersistMessageInput = {
  conversationId: string;
  senderId: string;
  body: string;
  idempotencyKey: string;
};

export type ConversationIdInput = { conversationId: string };

export type DeliverMessageNotificationsInput = {
  eventKey: string;
  messageId: string;
  conversationId: string;
  senderId: string;
};

export type ListNotificationsInput = { actorId: string; limit?: number };

export type ActorInput = { actorId: string };

export type MarkNotificationReadInput = { notificationId: string; actorId: string };

export type CreateNotificationInput = { userId: string; eventKey: string; payload: unknown };

export type ClaimOutboxEventsInput = { limit?: number; leaseSeconds?: number };

export type OutboxLeaseInput = { eventId: string; leaseToken: string };

export type RescheduleOutboxEventInput = OutboxLeaseInput & { delaySeconds?: number };

export type CreateMediaAssetInput = Omit<MediaAsset, "createdAt">;

export type GetMediaAssetInput = { id: string };

export type ListMediaAssetsInput = { ownerId: string; cursor?: MediaCursor; limit?: number };

export type DeleteUnusedMediaAssetInput = { id: string; ownerId: string };

export type DeleteUnusedMediaAssetResult = { deleted: MediaAsset | null; usedBy: MediaScanRow[] } | null;

export type CreateIdentityAccountInput = {
  userId: string;
  email: string;
  passwordHash: string;
  session: IdentitySessionSeed;
  displayName?: string;
};

export type FindIdentityAccountInput = { email: string };

export type RotateIdentityRefreshInput = {
  refreshHash: string;
  nextRefreshHash: string;
  accessTokenId: string;
  issuedAt: string;
  accessExpiresAt: string;
};

export type RevokeIdentityRefreshInput = { refreshHash: string };

export type RevokeSessionInput = { sessionId: string; expiresAt: string };

export type IssueIdentityTokenInput = {
  userId: string;
  purpose: string;
  email: string;
  tokenHash: string;
  expiresAt: string;
};

export type ConsumeIdentityTokenInput = { tokenHash: string; purpose: string };

export type ReplaceIdentityPasswordInput = { userId: string; passwordHash: string; exceptSessionId?: string | null };

export type ListIdentitySessionsInput = { userId: string; limit: number };

export type RevokeIdentitySessionInput = { userId: string; sessionId: string };

export type RevokeIdentitySessionsInput = { userId: string; exceptSessionId?: string | null };

export type MarkIdentityEmailVerifiedInput = { userId: string; verifiedAt: string };

export type IdentityUserInput = { userId: string };

export type SetIdentityEmailInput = { userId: string; email: string };

export type ConsumeRateLimitInput = { key: string; limit: number; windowSeconds: number };
