import { GraphQLError } from "graphql";
import { createSchema } from "graphql-yoga";
import { AuthorizationError, requireAuthenticatedActor } from "../../security/authorization.mjs";
import { ConversationNotFoundError, DomainError } from "../../domain/errors.mjs";

function rethrowApiError(error) {
  if (error instanceof AuthorizationError || error instanceof DomainError) {
    throw new GraphQLError(error.message, { extensions: { code: error.code } });
  }
  throw error;
}

function requireServices(context) {
  if (!context.services) {
    throw new GraphQLError("Persistence is not configured.", {
      extensions: { code: "SERVICE_UNAVAILABLE" },
    });
  }
  return context.services;
}

function resolveViewer(context) {
  try {
    return { id: requireAuthenticatedActor(context) };
  } catch (error) {
    rethrowApiError(error);
  }
}

export function createApiSchema() {
  return createSchema({
    typeDefs: /* GraphQL */ `
      type Health {
        status: String!
        version: String!
      }

      type Viewer {
        id: String!
      }

      type Message {
        id: ID!
        conversationId: String!
        senderId: String!
        body: String!
        createdAt: String!
      }
      type AuthorProfile {
        userId: String!
        displayName: String!
        bio: String!
        avatarUrl: String
        websiteUrl: String
        locale: String!
        createdAt: String!
        updatedAt: String!
        followerCount: Int!
        followingCount: Int!
        isFollowing: Boolean!
      }
      type ArticleLikeInfo {
        articleId: ID!
        slug: String!
        likeCount: Int!
        likedByViewer: Boolean!
      }

      type ArticleComment {
        id: ID!
        articleId: ID!
        authorId: String!
        parentCommentId: ID
        content: String!
        createdAt: String!
        updatedAt: String!
        author: AuthorProfile
        replies: [ArticleComment!]!
      }

      type Article {
        id: ID!
        authorId: String!
        slug: String!
        workType: String!
        status: String!
        locale: String!
        title: String!
        summary: String!
        contentBlocks: String!
        createdAt: String!
        updatedAt: String!
        publishedAt: String
        author: AuthorProfile
        categories: [Taxonomy!]!
        tags: [Taxonomy!]!
      }

      type Taxonomy {
        id: ID!
        kind: String!
        slug: String!
        name: String!
        description: String!
        locale: String!
        createdBy: String!
        articleCount: Int!
      }

      type Notification {
        id: ID!
        eventKey: String!
        payload: String!
        createdAt: String!
        readAt: String
      }

      type Conversation {
        id: ID!
        createdBy: String
        participantIds: [String!]!
        createdAt: String!
        lastActivityAt: String!
        unreadCount: Int!
        lastMessage: Message
      }

      type Query {
        health: Health!
        viewer: Viewer
        viewerProfile(locale: String = "zh-CN"): AuthorProfile
        authorProfile(userId: String!, locale: String = "zh-CN"): AuthorProfile
        searchUsers(query: String!, locale: String = "zh-CN", limit: Int = 20): [AuthorProfile!]!
        followers(userId: String!, locale: String = "zh-CN", limit: Int = 50): [AuthorProfile!]!
        following(userId: String!, locale: String = "zh-CN", limit: Int = 50): [AuthorProfile!]!
        articles(locale: String = "zh-CN", query: String = "", limit: Int = 20, offset: Int = 0): [Article!]!
        likedArticles(locale: String = "zh-CN", limit: Int = 50): [Article!]!
        relatedArticles(slug: String!, locale: String = "zh-CN", limit: Int = 6): [Article!]!
        article(slug: String!, locale: String = "zh-CN"): Article
        articleLikeInfo(slug: String!, locale: String = "zh-CN"): ArticleLikeInfo
        articleComments(slug: String!, locale: String = "zh-CN", limit: Int = 50): [ArticleComment!]!
        taxonomies(kind: String!, locale: String = "zh-CN", query: String = "", limit: Int = 100): [Taxonomy!]!
        taxonomy(kind: String!, slug: String!, locale: String = "zh-CN"): Taxonomy
        taxonomyArticles(kind: String!, slug: String!, locale: String = "zh-CN", limit: Int = 20, offset: Int = 0): [Article!]!
        myArticles(locale: String = "zh-CN", limit: Int = 50): [Article!]!
        conversationMessages(conversationId: String!, limit: Int = 100, before: ID): [Message!]
        conversations(limit: Int = 50): [Conversation!]!
        notifications(limit: Int = 50): [Notification!]!
        unreadNotificationCount: Int!
      }

      type Mutation {
        createConversation(participantIds: [String!]!): Conversation!
        updateConversationParticipants(conversationId: String!, addUserIds: [String!]! = [], removeUserIds: [String!]! = []): Conversation!
        deleteConversation(conversationId: String!): Boolean!
        markConversationAsRead(conversationId: String!): Boolean!
        sendMessage(conversationId: String!, body: String!, idempotencyKey: String!): Message!
        markNotificationRead(notificationId: ID!): Notification
        markAllNotificationsRead: Int!
        revokeCurrentSession: Boolean!

        createArticle(slug: String!, title: String!, summary: String = "", locale: String = "zh-CN", contentBlocks: String!, publish: Boolean = false, workType: String = "other", categoryIds: [ID!]! = [], tagIds: [ID!]! = []): Article!
        updateArticle(articleId: ID!, slug: String!, title: String!, summary: String = "", locale: String = "zh-CN", contentBlocks: String!, publish: Boolean!, workType: String, categoryIds: [ID!], tagIds: [ID!]): Article!
        updateMyProfile(displayName: String!, bio: String = "", avatarUrl: String, websiteUrl: String, locale: String = "zh-CN"): AuthorProfile!
        followUser(userId: String!, locale: String = "zh-CN"): AuthorProfile!
        unfollowUser(userId: String!, locale: String = "zh-CN"): AuthorProfile!
        toggleArticleLike(slug: String!, locale: String = "zh-CN"): ArticleLikeInfo!
        setArticleLike(slug: String!, locale: String = "zh-CN", liked: Boolean!): ArticleLikeInfo!
        createArticleComment(slug: String!, locale: String = "zh-CN", content: String!, parentCommentId: ID): ArticleComment!
        deleteArticleComment(commentId: ID!): Boolean!
        createTag(name: String!, locale: String = "zh-CN"): Taxonomy!
        createTaxonomy(kind: String!, slug: String!, name: String!, description: String = "", locale: String = "zh-CN"): Taxonomy!
        deleteTaxonomy(taxonomyId: ID!): Boolean!
      }
    `,
    resolvers: {
      Query: {
        health: () => ({ status: "ok", version: "0.1.0" }),
        viewer: (_source, _args, context) => resolveViewer(context),
        viewerProfile: async (_source, { locale = "zh-CN" }, context) => {
          try {
            const userId = requireAuthenticatedActor(context);
            return await requireServices(context).getAuthorProfile({ userId, locale, viewerId: userId });
          } catch (error) {
            rethrowApiError(error);
          }
        },
        authorProfile: async (_source, { userId, locale = "zh-CN" }, context) => {
          try {
            return await requireServices(context).getAuthorProfile({ userId, locale, viewerId: context.user?.id ?? null });
          } catch (error) {
            rethrowApiError(error);
          }
        },
        searchUsers: async (_source, { query, locale = "zh-CN", limit = 20 }, context) => {
          try {
            return await requireServices(context).searchUsers({ query, locale, limit, viewerId: context.user?.id ?? null });
          } catch (error) {
            rethrowApiError(error);
          }
        },
        followers: async (_source, { userId, locale = "zh-CN", limit = 50 }, context) => {
          try {
            return await requireServices(context).listFollowers({ userId, locale, limit, viewerId: context.user?.id ?? null });
          } catch (error) {
            rethrowApiError(error);
          }
        },
        following: async (_source, { userId, locale = "zh-CN", limit = 50 }, context) => {
          try {
            return await requireServices(context).listFollowing({ userId, locale, limit, viewerId: context.user?.id ?? null });
          } catch (error) {
            rethrowApiError(error);
          }
        },
        taxonomies: async (_source, { kind, locale = "zh-CN", query = "", limit = 100 }, context) => {
          try {
            return await requireServices(context).listTaxonomies({ kind, locale, query, limit });
          } catch (error) {
            rethrowApiError(error);
          }
        },
        taxonomy: async (_source, { kind, slug, locale = "zh-CN" }, context) => {
          try {
            return await requireServices(context).getTaxonomyBySlug({ kind, slug, locale });
          } catch (error) {
            rethrowApiError(error);
          }
        },
        taxonomyArticles: async (_source, { kind, slug, locale = "zh-CN", limit = 20, offset = 0 }, context) => {
          try {
            return await requireServices(context).listTaxonomyArticles({ kind, slug, locale, limit, offset });
          } catch (error) {
            rethrowApiError(error);
          }
        },
        likedArticles: async (_source, { locale = "zh-CN", limit = 50 }, context) => {
          try {
            const actorId = requireAuthenticatedActor(context);
            return await requireServices(context).listLikedArticles({ actorId, locale, limit });
          } catch (error) {
            rethrowApiError(error);
          }
        },
        relatedArticles: async (_source, { slug, locale = "zh-CN", limit = 6 }, context) => {
          try {
            return await requireServices(context).listRelatedArticles({ slug, locale, limit });
          } catch (error) {
            rethrowApiError(error);
          }
        },
        articles: async (_source, { locale = "zh-CN", query = "", limit = 20, offset = 0 }, context) => {
          try {
            const store = requireServices(context);
            return await store.listPublishedArticles({ locale, query, limit, offset });
          } catch (error) {
            rethrowApiError(error);
          }
        },
        article: async (_source, { slug, locale = "zh-CN" }, context) => {
          try {
            const store = requireServices(context);
            return await store.getPublishedArticle({ slug, locale });
          } catch (error) {
            rethrowApiError(error);
          }
        },
        articleLikeInfo: async (_source, { slug, locale = "zh-CN" }, context) => {
          try {
            return await requireServices(context).getArticleLikeInfo({
              slug, locale, actorId: context.user?.id ?? null,
            });
          } catch (error) {
            rethrowApiError(error);
          }
        },
        articleComments: async (_source, { slug, locale = "zh-CN", limit = 50 }, context) => {
          try {
            return await requireServices(context).listArticleComments({ slug, locale, limit });
          } catch (error) {
            rethrowApiError(error);
          }
        },
        myArticles: async (_source, { locale = "zh-CN", limit = 50 }, context) => {
          try {
            const actorId = requireAuthenticatedActor(context);
            const store = requireServices(context);
            return await store.listMyArticles({ actorId, locale, limit });
          } catch (error) {
            rethrowApiError(error);
          }
        },
        conversationMessages: async (_source, { conversationId, limit = 100, before = null }, context) => {
          try {
            const actorId = requireAuthenticatedActor(context);
            const store = requireServices(context);
            return await store.listConversationMessages({ conversationId, actorId, limit, before });
          } catch (error) {
            rethrowApiError(error);
          }
        },
        conversations: async (_source, { limit = 50 }, context) => {
          try {
            const actorId = requireAuthenticatedActor(context);
            const store = requireServices(context);
            return await store.listConversations({ actorId, limit });
          } catch (error) {
            rethrowApiError(error);
          }
        },
        notifications: async (_source, { limit = 50 }, context) => {
          try {
            const actorId = requireAuthenticatedActor(context);
            const store = requireServices(context);
            const notifications = await store.listNotifications({ actorId, limit });
            return notifications.map(({ payload, ...notification }) => ({
              ...notification,
              payload: JSON.stringify(payload),
            }));
          } catch (error) {
            rethrowApiError(error);
          }
        },
        unreadNotificationCount: async (_source, _args, context) => {
          try {
            const actorId = requireAuthenticatedActor(context);
            const store = requireServices(context);
            return await store.getUnreadNotificationCount({ actorId });
          } catch (error) {
            rethrowApiError(error);
          }
        },
      },
      Article: {
        contentBlocks: (source) => typeof source.contentBlocks === "string"
          ? source.contentBlocks
          : JSON.stringify(source.contentBlocks),
        author: async (source, _args, context) => {
          if (!context.services || !source.authorId) return null;
          return context.services.getAuthorProfile({ userId: source.authorId, locale: source.locale, viewerId: context.user?.id ?? null });
        },
        categories: async (source, _args, context) => {
          if (!context.services || !source.id) return [];
          return context.services.listArticleTaxonomies({ articleId: source.id, kind: "category", locale: source.locale });
        },
        tags: async (source, _args, context) => {
          if (!context.services || !source.id) return [];
          return context.services.listArticleTaxonomies({ articleId: source.id, kind: "tag", locale: source.locale });
        },
      },
      ArticleComment: {
        author: async (source, _args, context) => {
          if (!context.services || !source.authorId) return null;
          return context.services.getAuthorProfile({ userId: source.authorId, locale: source.locale ?? "zh-CN", viewerId: context.user?.id ?? null });
        },
      },
      Mutation: {
        markNotificationRead: async (_source, { notificationId }, context) => {
          try {
            const actorId = requireAuthenticatedActor(context);
            const store = requireServices(context);
            const notification = await store.markNotificationRead({ notificationId, actorId });
            return notification && {
              ...notification,
              payload: JSON.stringify(notification.payload),
            };
          } catch (error) {
            rethrowApiError(error);
          }
        },
        markAllNotificationsRead: async (_source, _args, context) => {
          try {
            const actorId = requireAuthenticatedActor(context);
            const store = requireServices(context);
            return await store.markAllNotificationsRead({ actorId });
          } catch (error) {
            rethrowApiError(error);
          }
        },
        revokeCurrentSession: async (_source, _args, context) => {
          try {
            const actorId = requireAuthenticatedActor(context);
            const store = requireServices(context);
            const { sessionId, sessionExpiresAt } = context.user;
            if (typeof sessionId !== "string" || !Number.isFinite(sessionExpiresAt)) {
              throw new GraphQLError("The authenticated session cannot be revoked.", {
                extensions: { code: "UNAUTHENTICATED" },
              });
            }
            await store.revokeSession({
              sessionId,
              expiresAt: new Date(sessionExpiresAt * 1000),
            });
            return true;
          } catch (error) {
            rethrowApiError(error);
          }
        },
        toggleArticleLike: async (_source, { slug, locale = "zh-CN" }, context) => {
          try {
            const actorId = requireAuthenticatedActor(context);
            return await requireServices(context).toggleArticleLike({ slug, locale, actorId });
          } catch (error) {
            rethrowApiError(error);
          }
        },
        setArticleLike: async (_source, { slug, locale = "zh-CN", liked }, context) => {
          try {
            const actorId = requireAuthenticatedActor(context);
            return await requireServices(context).setArticleLike({ slug, locale, actorId, liked });
          } catch (error) {
            rethrowApiError(error);
          }
        },
        createArticleComment: async (_source, { slug, locale = "zh-CN", content, parentCommentId = null }, context) => {
          try {
            const actorId = requireAuthenticatedActor(context);
            return await requireServices(context).createArticleComment({ slug, locale, actorId, content, parentCommentId });
          } catch (error) {
            rethrowApiError(error);
          }
        },
        deleteArticleComment: async (_source, { commentId }, context) => {
          try {
            const actorId = requireAuthenticatedActor(context);
            return await requireServices(context).deleteArticleComment({ commentId, actorId });
          } catch (error) {
            rethrowApiError(error);
          }
        },
        updateMyProfile: async (_source, args, context) => {
          try {
            const userId = requireAuthenticatedActor(context);
            const store = requireServices(context);
            await store.upsertAuthorProfile({ ...args, userId });
            return await store.getAuthorProfile({ userId, locale: args.locale ?? "zh-CN", viewerId: userId });
          } catch (error) {
            rethrowApiError(error);
          }
        },
        followUser: async (_source, { userId: targetUserId, locale = "zh-CN" }, context) => {
          try {
            const actorId = requireAuthenticatedActor(context);
            const store = requireServices(context);
            await store.followUser({ actorId, targetUserId });
            return await store.getAuthorProfile({ userId: targetUserId, locale, viewerId: actorId });
          } catch (error) {
            rethrowApiError(error);
          }
        },
        unfollowUser: async (_source, { userId: targetUserId, locale = "zh-CN" }, context) => {
          try {
            const actorId = requireAuthenticatedActor(context);
            const store = requireServices(context);
            await store.unfollowUser({ actorId, targetUserId });
            return await store.getAuthorProfile({ userId: targetUserId, locale, viewerId: actorId });
          } catch (error) {
            rethrowApiError(error);
          }
        },
        createTag: async (_source, { name, locale = "zh-CN" }, context) => {
          try {
            const actorId = requireAuthenticatedActor(context);
            return await requireServices(context).createTag({ actorId, name, locale });
          } catch (error) {
            rethrowApiError(error);
          }
        },
        createTaxonomy: async (_source, args, context) => {
          try {
            const actorId = requireAuthenticatedActor(context);
            return await requireServices(context).createTaxonomy({ ...args, actorId });
          } catch (error) {
            rethrowApiError(error);
          }
        },
        deleteTaxonomy: async (_source, { taxonomyId }, context) => {
          try {
            const actorId = requireAuthenticatedActor(context);
            return await requireServices(context).deleteTaxonomy({ taxonomyId, actorId });
          } catch (error) {
            rethrowApiError(error);
          }
        },
        createArticle: async (_source, args, context) => {
          try {
            const authorId = requireAuthenticatedActor(context);
            const store = requireServices(context);
            const article = await store.createArticle({ ...args, authorId });
            return article;
          } catch (error) {
            rethrowApiError(error);
          }
        },
        updateArticle: async (_source, args, context) => {
          try {
            const actorId = requireAuthenticatedActor(context);
            const store = requireServices(context);
            const article = await store.updateArticle({ ...args, actorId });
            return article;
          } catch (error) {
            rethrowApiError(error);
          }
        },
        createConversation: async (_source, { participantIds }, context) => {
          try {
            const actorId = requireAuthenticatedActor(context);
            return await requireServices(context).createConversation({ actorId, participantIds });
          } catch (error) {
            rethrowApiError(error);
          }
        },
        updateConversationParticipants: async (_source, { conversationId, addUserIds = [], removeUserIds = [] }, context) => {
          try {
            const actorId = requireAuthenticatedActor(context);
            const store = requireServices(context);
            await store.updateConversationParticipants({ conversationId, actorId, addUserIds, removeUserIds });
            const conversations = await store.listConversations({ actorId, limit: 100 });
            const updated = conversations.find((conversation) => conversation.id === conversationId);
            if (!updated) throw new ConversationNotFoundError();
            return updated;
          } catch (error) {
            rethrowApiError(error);
          }
        },
        deleteConversation: async (_source, { conversationId }, context) => {
          try {
            const actorId = requireAuthenticatedActor(context);
            return await requireServices(context).deleteConversation({ conversationId, actorId });
          } catch (error) {
            rethrowApiError(error);
          }
        },
        markConversationAsRead: async (_source, { conversationId }, context) => {
          try {
            const actorId = requireAuthenticatedActor(context);
            return await requireServices(context).markConversationAsRead({ conversationId, actorId });
          } catch (error) {
            rethrowApiError(error);
          }
        },
        sendMessage: async (_source, { conversationId, body, idempotencyKey }, context) => {
          try {
            const senderId = requireAuthenticatedActor(context);
            const store = requireServices(context);
            return await store.persistMessage({ conversationId, senderId, body, idempotencyKey });
          } catch (error) {
            rethrowApiError(error);
          }
        },
      },
    },
  });
}
