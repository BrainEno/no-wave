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
    "createArticle", "updateArticle", "listLikedArticles", "listRelatedArticles",
  ] as const),
  taxonomy: Object.freeze([
    "listTaxonomies", "getTaxonomyBySlug", "listTaxonomyArticles",
    "listArticleTaxonomies", "createTag", "createTaxonomy", "deleteTaxonomy",
  ] as const),
  profiles: Object.freeze([
    "getAuthorProfile", "searchUsers", "listFollowing", "listFollowers",
    "followUser", "unfollowUser", "upsertAuthorProfile",
  ] as const),
  engagement: Object.freeze([
    "getArticleLikeInfo", "toggleArticleLike", "setArticleLike",
    "listArticleComments", "createArticleComment", "deleteArticleComment",
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
    "createIdentityAccount", "findIdentityAccount", "createIdentitySession",
    "rotateIdentityRefresh", "revokeIdentityRefresh", "pruneExpiredIdentityState",
  ] as const),
  rateLimits: Object.freeze(["consumeRateLimit"] as const),
  outbox: Object.freeze([
    "claimOutboxEvents", "markOutboxDelivered", "rescheduleOutboxEvent",
  ] as const),
  operations: Object.freeze(["health"] as const),
});

export type PortGroups = typeof persistencePortMethods;
export type PortName = keyof PortGroups;
export type PortMethodName<K extends PortName> = PortGroups[K][number];

/**
 * The persistence adapter, as seen by the application layer.
 *
 * The SQLite and PostgreSQL adapters are still authored without parameter or
 * return annotations, so this alias is the one place where the transport boundary
 * admits `any`. It exists so that typing an adapter method later propagates
 * through `PersistencePorts`/`ApplicationServices` automatically instead of being
 * blocked by a hand-written facade — the remaining work tracked in issue #66.
 */
export type PersistenceAdapterMethods = Record<string, (...args: any[]) => any>;

/** Domain-grouped repository ports, typed from the adapter that backs them. */
export type PersistencePorts<A extends PersistenceAdapterMethods = PersistenceAdapterMethods> = {
  [K in PortName]: { [M in PortMethodName<K>]: A[M] };
};

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
export function createPersistencePorts<A extends PersistenceAdapterMethods = PersistenceAdapterMethods>(
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
