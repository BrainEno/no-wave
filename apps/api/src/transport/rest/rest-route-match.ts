// Request-path recognition is intentionally separate from route policy and handlers.
const ROUTE_PATTERNS = Object.freeze({
  identityRoute: /^\/api\/v1\/auth\/(register|login|refresh|logout)$/,
  userRelationshipsMatch: /^\/api\/v1\/users\/([^/]+)\/(followers|following)$/,
  followPathMatch: /^\/api\/v1\/users\/([^/]+)\/follow$/,
  articleLikePathMatch: /^\/api\/v1\/articles\/([^/]+)\/like$/,
  relatedArticlesMatch: /^\/api\/v1\/articles\/([^/]+)\/related$/,
  articleCommentsPathMatch: /^\/api\/v1\/articles\/([^/]+)\/comments$/,
  commentItemPathMatch: /^\/api\/v1\/comments\/([^/]+)$/,
  taxonomyItemMatch: /^\/api\/v1\/taxonomies\/([^/]+)$/,
  conversationMessagesMatch: /^\/api\/v1\/conversations\/([^/]+)\/messages$/,
  conversationParticipantsMatch: /^\/api\/v1\/conversations\/([^/]+)\/participants$/,
  conversationReadMatch: /^\/api\/v1\/conversations\/([^/]+)\/read$/,
  conversationItemMatch: /^\/api\/v1\/conversations\/([^/]+)$/,
  notificationReadMatch: /^\/api\/v1\/me\/notifications\/([^/]+)\/read$/,
  authorArticlesMatch: /^\/api\/v1\/authors\/([^/]+)\/articles$/,
  authorMatch: /^\/api\/v1\/authors\/([^/]+)$/,
  articleMatch: /^\/api\/v1\/articles\/([^/]+)$/,
  categoryArticlesMatch: /^\/api\/v1\/categories\/([^/]+)\/articles$/,
  categoryMatch: /^\/api\/v1\/categories\/([^/]+)$/,
  tagArticlesMatch: /^\/api\/v1\/tags\/([^/]+)\/articles$/,
  tagMatch: /^\/api\/v1\/tags\/([^/]+)$/
});

export type RestRouteMatches = {
  identityRoute: RegExpMatchArray | null;
  mePath: boolean;
  meProfilePath: boolean;
  meSessionPath: boolean;
  meLikedArticlesPath: boolean;
  usersSearchPath: boolean;
  userRelationshipsMatch: RegExpMatchArray | null;
  followPathMatch: RegExpMatchArray | null;
  articleLikePathMatch: RegExpMatchArray | null;
  relatedArticlesMatch: RegExpMatchArray | null;
  articleCommentsPathMatch: RegExpMatchArray | null;
  commentItemPathMatch: RegExpMatchArray | null;
  tagsCollectionPath: boolean;
  taxonomyCollectionPath: boolean;
  taxonomyItemMatch: RegExpMatchArray | null;
  conversationsPath: boolean;
  conversationMessagesMatch: RegExpMatchArray | null;
  conversationParticipantsMatch: RegExpMatchArray | null;
  conversationReadMatch: RegExpMatchArray | null;
  conversationItemMatch: RegExpMatchArray | null;
  notificationsPath: boolean;
  unreadNotificationCountPath: boolean;
  notificationReadMatch: RegExpMatchArray | null;
  readAllNotificationsPath: boolean;
  articleItemPath: boolean;
  authorArticlesMatch: RegExpMatchArray | null;
  authorMatch: RegExpMatchArray | null;
  articleMatch: RegExpMatchArray | null;
  categoryArticlesMatch: RegExpMatchArray | null;
  categoryMatch: RegExpMatchArray | null;
  tagArticlesMatch: RegExpMatchArray | null;
  tagMatch: RegExpMatchArray | null;
};

export function matchRestPaths(pathname: string): RestRouteMatches {
  return {
    identityRoute: ROUTE_PATTERNS.identityRoute.exec(pathname),
    mePath: pathname === "/api/v1/me",
    meProfilePath: pathname === "/api/v1/me/profile",
    meSessionPath: pathname === "/api/v1/me/session",
    meLikedArticlesPath: pathname === "/api/v1/me/liked-articles",
    usersSearchPath: pathname === "/api/v1/users",
    userRelationshipsMatch: ROUTE_PATTERNS.userRelationshipsMatch.exec(pathname),
    followPathMatch: ROUTE_PATTERNS.followPathMatch.exec(pathname),
    articleLikePathMatch: ROUTE_PATTERNS.articleLikePathMatch.exec(pathname),
    relatedArticlesMatch: ROUTE_PATTERNS.relatedArticlesMatch.exec(pathname),
    articleCommentsPathMatch: ROUTE_PATTERNS.articleCommentsPathMatch.exec(pathname),
    commentItemPathMatch: ROUTE_PATTERNS.commentItemPathMatch.exec(pathname),
    tagsCollectionPath: pathname === "/api/v1/tags",
    taxonomyCollectionPath: pathname === "/api/v1/taxonomies",
    taxonomyItemMatch: ROUTE_PATTERNS.taxonomyItemMatch.exec(pathname),
    conversationsPath: pathname === "/api/v1/conversations",
    conversationMessagesMatch: ROUTE_PATTERNS.conversationMessagesMatch.exec(pathname),
    conversationParticipantsMatch: ROUTE_PATTERNS.conversationParticipantsMatch.exec(pathname),
    conversationReadMatch: ROUTE_PATTERNS.conversationReadMatch.exec(pathname),
    conversationItemMatch: ROUTE_PATTERNS.conversationItemMatch.exec(pathname),
    notificationsPath: pathname === "/api/v1/me/notifications",
    unreadNotificationCountPath: pathname === "/api/v1/me/notifications/unread-count",
    notificationReadMatch: ROUTE_PATTERNS.notificationReadMatch.exec(pathname),
    readAllNotificationsPath: pathname === "/api/v1/me/notifications/read-all",
    articleItemPath: /^\/api\/v1\/articles\/[^/]+$/.test(pathname),
    authorArticlesMatch: ROUTE_PATTERNS.authorArticlesMatch.exec(pathname),
    authorMatch: ROUTE_PATTERNS.authorMatch.exec(pathname),
    articleMatch: ROUTE_PATTERNS.articleMatch.exec(pathname),
    categoryArticlesMatch: ROUTE_PATTERNS.categoryArticlesMatch.exec(pathname),
    categoryMatch: ROUTE_PATTERNS.categoryMatch.exec(pathname),
    tagArticlesMatch: ROUTE_PATTERNS.tagArticlesMatch.exec(pathname),
    tagMatch: ROUTE_PATTERNS.tagMatch.exec(pathname)
  };
}
