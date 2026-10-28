/**
 * Persistence adapter contracts consumed by the application layer.
 *
 * Implementations return domain-shaped records, not driver-specific rows.
 * The contract intentionally groups methods by domain so a PostgreSQL,
 * MongoDB, or SQLite adapter can be tested against the same behavioral suite.
 */
export const persistencePortMethods = Object.freeze({
  content: Object.freeze([
    "listPublishedArticles", "getPublishedArticle", "listMyArticles",
    "createArticle", "updateArticle", "listLikedArticles", "listRelatedArticles",
  ]),
  taxonomy: Object.freeze([
    "listTaxonomies", "getTaxonomyBySlug", "listTaxonomyArticles",
    "listArticleTaxonomies", "createTag", "createTaxonomy", "deleteTaxonomy",
  ]),
  profiles: Object.freeze([
    "getAuthorProfile", "searchUsers", "listFollowing", "listFollowers",
    "followUser", "unfollowUser", "upsertAuthorProfile",
  ]),
  engagement: Object.freeze([
    "getArticleLikeInfo", "toggleArticleLike", "setArticleLike",
    "listArticleComments", "createArticleComment", "deleteArticleComment",
  ]),
  conversations: Object.freeze([
    "createConversation", "getConversation", "updateConversationParticipants", "deleteConversation",
    "markConversationAsRead", "listConversationMessages", "listConversations",
    "persistMessage", "listConversationParticipantIds",
  ]),
  notifications: Object.freeze([
    "listNotifications", "getUnreadNotificationCount", "markAllNotificationsRead",
    "markNotificationRead", "createNotification", "deliverMessageNotifications",
  ]),
  sessions: Object.freeze(["revokeSession", "isSessionRevoked"]),
  identity: Object.freeze([
    "createIdentityAccount", "findIdentityAccount", "createIdentitySession",
    "rotateIdentityRefresh", "revokeIdentityRefresh", "pruneExpiredIdentityState",
  ]),
  rateLimits: Object.freeze(["consumeRateLimit"]),
  outbox: Object.freeze([
    "claimOutboxEvents", "markOutboxDelivered", "rescheduleOutboxEvent",
  ]),
  operations: Object.freeze(["health"]),
});

export function assertPersistenceAdapter(adapter) {
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
export function createPersistencePorts(adapter) {
  if (!adapter || typeof adapter !== "object") {
    throw new TypeError("A persistence adapter object is required.");
  }
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
          return Reflect.apply(operation, adapter, args);
        },
      ]))),
    ]),
  ));
}
