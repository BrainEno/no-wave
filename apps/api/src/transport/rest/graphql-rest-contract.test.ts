import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildSchema, isObjectType, type GraphQLSchema } from "graphql";

type RouteContract = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  marker: string;
};
type OperationContract = { routes: readonly string[]; disposition?: "intentional-migration" };

// Source markers make a deleted or renamed handler route fail CI instead of
// allowing the human-readable parity audit to drift from the real API.
const routes = {
  health: { method: "GET", path: "/api/v1/health", marker: 'if (url.pathname === "/api/v1/health")' },
  viewer: { method: "GET", path: "/api/v1/me", marker: 'const mePath = url.pathname === "/api/v1/me";' },
  viewerProfile: { method: "GET", path: "/api/v1/me/profile", marker: 'const meProfilePath = url.pathname === "/api/v1/me/profile";' },
  authorProfile: { method: "GET", path: "/api/v1/authors/:userId", marker: "const authorMatch = url.pathname.match(" },
  searchUsers: { method: "GET", path: "/api/v1/users", marker: 'const usersSearchPath = url.pathname === "/api/v1/users";' },
  followers: { method: "GET", path: "/api/v1/users/:userId/followers", marker: "const userRelationshipsMatch = url.pathname.match(" },
  following: { method: "GET", path: "/api/v1/users/:userId/following", marker: "const userRelationshipsMatch = url.pathname.match(" },
  articles: { method: "GET", path: "/api/v1/articles", marker: 'if (url.pathname === "/api/v1/articles")' },
  likedArticles: { method: "GET", path: "/api/v1/me/liked-articles", marker: 'const meLikedArticlesPath = url.pathname === "/api/v1/me/liked-articles";' },
  relatedArticles: { method: "GET", path: "/api/v1/articles/:slug/related", marker: "const relatedArticlesMatch = url.pathname.match(" },
  article: { method: "GET", path: "/api/v1/articles/:slug", marker: "const articleMatch = url.pathname.match(" },
  articleLikeInfo: { method: "GET", path: "/api/v1/articles/:slug/like", marker: "const articleLikePathMatch = url.pathname.match(" },
  articleComments: { method: "GET", path: "/api/v1/articles/:slug/comments", marker: "const articleCommentsPathMatch = url.pathname.match(" },
  categoriesIndex: { method: "GET", path: "/api/v1/categories", marker: 'if (url.pathname === "/api/v1/categories")' },
  tagsIndex: { method: "GET", path: "/api/v1/tags", marker: 'const tagsCollectionPath = url.pathname === "/api/v1/tags";' },
  categoryDetail: { method: "GET", path: "/api/v1/categories/:slug", marker: "const categoryMatch = url.pathname.match(" },
  tagDetail: { method: "GET", path: "/api/v1/tags/:slug", marker: "const tagMatch = url.pathname.match(" },
  categoryArticles: { method: "GET", path: "/api/v1/categories/:slug/articles", marker: "const categoryArticlesMatch = url.pathname.match(" },
  tagArticles: { method: "GET", path: "/api/v1/tags/:slug/articles", marker: "const tagArticlesMatch = url.pathname.match(" },
  myArticles: { method: "GET", path: "/api/v1/me/articles", marker: 'if (url.pathname === "/api/v1/me/articles")' },
  conversationMessages: { method: "GET", path: "/api/v1/conversations/:conversationId/messages", marker: "const conversationMessagesMatch = url.pathname.match(" },
  conversations: { method: "GET", path: "/api/v1/conversations", marker: 'const conversationsPath = url.pathname === "/api/v1/conversations";' },
  notifications: { method: "GET", path: "/api/v1/me/notifications", marker: 'const notificationsPath = url.pathname === "/api/v1/me/notifications";' },
  unreadNotificationCount: { method: "GET", path: "/api/v1/me/notifications/unread-count", marker: 'const unreadNotificationCountPath = url.pathname === "/api/v1/me/notifications/unread-count";' },
  createConversation: { method: "POST", path: "/api/v1/conversations", marker: 'const isCreateConversation = request.method === "POST" && conversationsPath;' },
  updateConversationParticipants: { method: "PATCH", path: "/api/v1/conversations/:conversationId/participants", marker: 'const isUpdateConversationParticipants = request.method === "PATCH" && conversationParticipantsMatch !== null;' },
  deleteConversation: { method: "DELETE", path: "/api/v1/conversations/:conversationId", marker: 'const isDeleteConversation = request.method === "DELETE" && conversationItemMatch !== null;' },
  markConversationAsRead: { method: "PUT", path: "/api/v1/conversations/:conversationId/read", marker: 'const isMarkConversationRead = request.method === "PUT" && conversationReadMatch !== null;' },
  sendMessage: { method: "POST", path: "/api/v1/conversations/:conversationId/messages", marker: 'const isSendMessage = request.method === "POST" && conversationMessagesMatch !== null;' },
  markNotificationRead: { method: "PUT", path: "/api/v1/me/notifications/:notificationId/read", marker: 'const isMarkNotificationRead = request.method === "PUT" && notificationReadMatch !== null;' },
  markAllNotificationsRead: { method: "POST", path: "/api/v1/me/notifications/read-all", marker: 'const isMarkAllNotificationsRead = request.method === "POST" && readAllNotificationsPath;' },
  revokeCurrentSession: { method: "DELETE", path: "/api/v1/me/session", marker: 'const isRevokeSession = request.method === "DELETE" && meSessionPath;' },
  createArticle: { method: "POST", path: "/api/v1/articles", marker: 'const isCreateArticle = request.method === "POST" && url.pathname === "/api/v1/articles";' },
  updateArticle: { method: "PUT", path: "/api/v1/articles/:articleId", marker: 'const isUpdateArticle = request.method === "PUT" && articleItemPath;' },
  updateMyProfile: { method: "PUT", path: "/api/v1/me/profile", marker: 'const isUpdateMyProfile = request.method === "PUT" && meProfilePath;' },
  followUser: { method: "POST", path: "/api/v1/users/:userId/follow", marker: 'const isFollowUser = request.method === "POST" && followPathMatch !== null;' },
  unfollowUser: { method: "DELETE", path: "/api/v1/users/:userId/follow", marker: 'const isUnfollowUser = request.method === "DELETE" && followPathMatch !== null;' },
  setArticleLike: { method: "PUT", path: "/api/v1/articles/:slug/like", marker: 'const isSetArticleLike = request.method === "PUT" && articleLikePathMatch !== null;' },
  createArticleComment: { method: "POST", path: "/api/v1/articles/:slug/comments", marker: 'const isCreateArticleComment = request.method === "POST" && articleCommentsPathMatch !== null;' },
  deleteArticleComment: { method: "DELETE", path: "/api/v1/comments/:commentId", marker: 'const isDeleteArticleComment = request.method === "DELETE" && commentItemPathMatch !== null;' },
  createTag: { method: "POST", path: "/api/v1/tags", marker: 'const isCreateTag = request.method === "POST" && tagsCollectionPath;' },
  createTaxonomy: { method: "POST", path: "/api/v1/taxonomies", marker: 'const isCreateTaxonomy = request.method === "POST" && taxonomyCollectionPath;' },
  deleteTaxonomy: { method: "DELETE", path: "/api/v1/taxonomies/:taxonomyId", marker: 'const isDeleteTaxonomy = request.method === "DELETE" && taxonomyItemMatch !== null;' },
} satisfies Record<string, RouteContract>;

const operationContracts = {
  Query: {
    health: { routes: ["health"] },
    viewer: { routes: ["viewer"] },
    viewerProfile: { routes: ["viewerProfile"] },
    authorProfile: { routes: ["authorProfile"] },
    searchUsers: { routes: ["searchUsers"] },
    followers: { routes: ["followers"] },
    following: { routes: ["following"] },
    articles: { routes: ["articles"] },
    likedArticles: { routes: ["likedArticles"] },
    relatedArticles: { routes: ["relatedArticles"] },
    article: { routes: ["article"] },
    articleLikeInfo: { routes: ["articleLikeInfo"] },
    articleComments: { routes: ["articleComments"] },
    taxonomies: { routes: ["categoriesIndex", "tagsIndex"] },
    taxonomy: { routes: ["categoryDetail", "tagDetail"] },
    taxonomyArticles: { routes: ["categoryArticles", "tagArticles"] },
    myArticles: { routes: ["myArticles"] },
    conversationMessages: { routes: ["conversationMessages"] },
    conversations: { routes: ["conversations"] },
    notifications: { routes: ["notifications"] },
    unreadNotificationCount: { routes: ["unreadNotificationCount"] },
  },
  Mutation: {
    createConversation: { routes: ["createConversation"] },
    updateConversationParticipants: { routes: ["updateConversationParticipants"] },
    deleteConversation: { routes: ["deleteConversation"] },
    markConversationAsRead: { routes: ["markConversationAsRead"] },
    sendMessage: { routes: ["sendMessage"] },
    markNotificationRead: { routes: ["markNotificationRead"] },
    markAllNotificationsRead: { routes: ["markAllNotificationsRead"] },
    revokeCurrentSession: { routes: ["revokeCurrentSession"] },
    createArticle: { routes: ["createArticle"] },
    updateArticle: { routes: ["updateArticle"] },
    updateMyProfile: { routes: ["updateMyProfile"] },
    followUser: { routes: ["followUser"] },
    unfollowUser: { routes: ["unfollowUser"] },
    toggleArticleLike: { routes: ["setArticleLike"], disposition: "intentional-migration" },
    setArticleLike: { routes: ["setArticleLike"] },
    createArticleComment: { routes: ["createArticleComment"] },
    deleteArticleComment: { routes: ["deleteArticleComment"] },
    createTag: { routes: ["createTag"] },
    createTaxonomy: { routes: ["createTaxonomy"] },
    deleteTaxonomy: { routes: ["deleteTaxonomy"] },
  },
} satisfies Record<"Query" | "Mutation", Record<string, OperationContract>>;

const fieldContracts = {
  Health: ["status", "version"],
  Viewer: ["id"],
  AuthorProfile: ["userId", "displayName", "bio", "avatarUrl", "websiteUrl", "locale", "createdAt", "updatedAt", "followerCount", "followingCount", "isFollowing"],
  Article: ["id", "authorId", "slug", "workType", "status", "locale", "title", "summary", "contentBlocks", "contentBlocksVersion", "createdAt", "updatedAt", "publishedAt", "author", "categories", "tags"],
  ArticleComment: ["id", "articleId", "authorId", "parentCommentId", "content", "createdAt", "updatedAt", "author", "replies"],
  ArticleLikeInfo: ["articleId", "slug", "likeCount", "likedByViewer"],
  Taxonomy: ["id", "kind", "slug", "name", "description", "locale", "createdBy", "articleCount"],
  Message: ["id", "conversationId", "senderId", "body", "createdAt"],
  Conversation: ["id", "createdBy", "participantIds", "createdAt", "lastActivityAt", "unreadCount", "lastMessage"],
  Notification: ["id", "eventKey", "payload", "createdAt", "readAt"],
} as const;

async function loadContractInputs(): Promise<{ schema: GraphQLSchema; handlerSource: string; auditSource: string }> {
  const [schemaSource, handlerSource, auditSource] = await Promise.all([
    readFile(new URL("../graphql/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("./handler.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../../../docs/audit/rest-graphql-parity.md", import.meta.url), "utf8"),
  ]);
  const delimiter = String.fromCharCode(96);
  const marker = "typeDefs: /* GraphQL */";
  const markerIndex = schemaSource.indexOf(marker);
  const opening = schemaSource.indexOf(delimiter, markerIndex);
  const closing = schemaSource.indexOf(delimiter, opening + 1);
  assert.ok(markerIndex >= 0 && opening >= 0 && closing > opening, "Could not extract the GraphQL SDL from schema.ts.");
  return { schema: buildSchema(schemaSource.slice(opening + 1, closing)), handlerSource, auditSource };
}

test("GraphQL query and mutation operations have explicit REST mappings and audit entries", async () => {
  const { schema, handlerSource, auditSource } = await loadContractInputs();
  const tick = String.fromCharCode(96);

  for (const operationType of ["Query", "Mutation"] as const) {
    const schemaType = operationType === "Query" ? schema.getQueryType() : schema.getMutationType();
    assert.ok(schemaType, "GraphQL schema is missing " + operationType);
    assert.deepEqual(
      Object.keys(operationContracts[operationType]).sort(),
      Object.keys(schemaType.getFields()).sort(),
      operationType + " operations changed without an explicit REST contract update.",
    );

    for (const [operationName, contract] of Object.entries(operationContracts[operationType])) {
      assert.ok(contract.routes.length > 0, operationType + "." + operationName + " has no REST mapping.");
      assert.ok(
        auditSource.includes(tick + operationName + tick) || auditSource.includes(tick + operationName + "("),
        operationType + "." + operationName + " is missing from the parity audit.",
      );
      for (const routeId of contract.routes) {
        assert.ok(routeId in routes, operationType + "." + operationName + " references unknown REST route " + routeId + ".");
        const route = routes[routeId as keyof typeof routes];
        assert.ok(route.path.startsWith("/api/v1/"), "Route must be versioned: " + route.path);
        assert.ok(handlerSource.includes(route.marker), "REST handler marker missing for " + route.method + " " + route.path);
      }
      if (operationName === "toggleArticleLike") {
        assert.equal(contract.disposition, "intentional-migration");
        assert.ok(
          contract.routes.every((routeId) => routes[routeId as keyof typeof routes].method === "PUT"),
          "Legacy toggle must map to retry-safe PUT state setting, never an HTTP toggle.",
        );
      }
    }
  }
});

test("shared GraphQL object fields stay in sync with the reviewed REST field contract", async () => {
  const { schema } = await loadContractInputs();
  for (const [typeName, expectedFields] of Object.entries(fieldContracts)) {
    const type = schema.getType(typeName);
    if (!type || !isObjectType(type)) throw new Error("Missing GraphQL object type: " + typeName);
    assert.deepEqual(
      Object.keys(type.getFields()).sort(),
      [...expectedFields].sort(),
      typeName + " fields changed; review REST serializers, response tests and parity documentation.",
    );
  }
});
