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
    "listArticleTaxonomies", "listArticlesTaxonomies", "createTag", "createTaxonomy", "deleteTaxonomy",
  ] as const),
  profiles: Object.freeze([
    "getAuthorProfile", "getAuthorProfilesByIds", "searchUsers", "searchAuthors", "listFollowing", "listFollowers",
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

/**
 * Adapter members that belong to no domain port.
 *
 * They are still part of the shape an adapter must have: `createPostgresStore`
 * spreads its slices into one object and the last thing it does is freeze that
 * object, so a slice that forgot `isSessionRevoked` would otherwise be a runtime
 * 500 on `DELETE /auth/sessions/...` rather than a startup error. Keeping them
 * out of `persistencePortMethods` is deliberate — no transport calls
 * `transaction()`, and adding it to a port group would put a connection-level
 * hook in the application layer's vocabulary.
 */
export const persistenceAdapterInfrastructureMethods = Object.freeze([
  "transaction", "isSessionRevoked",
] as const);

export type PortGroups = typeof persistencePortMethods;
export type PortName = keyof PortGroups;
export type PortMethodName<K extends PortName> = PortGroups[K][number];

/**
 * The persistence adapter, as seen by the application layer.
 *
 * Open by design (`Record<string, ...>`) so `PersistencePorts` can be derived
 * from whichever adapter backs the runtime. It is not where the types live: the
 * parameter and return types of every port method are `PersistencePortSignatures`
 * in `persistence-adapter.ts`, and `PersistenceAdapterContract` below intersects
 * the two — so an adapter is checked against the typed signatures (issue #167,
 * closing #66), while the service facade keeps being derived rather than
 * hand-written.
 */
export type PersistenceAdapterMethods = Record<string, (...args: any[]) => any>;

export type PersistenceAdapterInfrastructureMethod = typeof persistenceAdapterInfrastructureMethods[number];

/**
 * The typed adapter contract: what every port method takes and returns.
 *
 * Declared in a separate module and re-exported here so this file stays the one
 * place that lists *which* methods exist, while the signatures live next to the
 * domain types they describe (`persistence-port-types.ts`).
 */
export type TypedPersistenceAdapterContract = import("./persistence-adapter.ts").TypedPersistenceAdapterContract;

/** The typed connection-level members (`transaction`, the session check). */
export type PersistenceAdapterInfrastructure = import("./persistence-adapter.ts").PersistenceAdapterInfrastructure;

/**
 * The shape an adapter must actually return.
 *
 * `PersistenceAdapterMethods` is deliberately open (`Record<string, ...>`) so the
 * port types can be derived from an adapter's own method list. That openness is
 * exactly what lets an adapter forget a method, so adapters annotate their return
 * value with *this* contract: every port method must exist, and a renamed or
 * dropped method becomes a compile error instead of a runtime 500 behind a route.
 * The infrastructure members (`transaction`, `isSessionRevoked`) are part of the
 * shape for the same reason even though they are in no application port.
 *
 * Parameter types stay permissive until the adapters are annotated method by
 * method with `TypedPersistenceAdapterContract` (see `persistence-adapter.ts`).
 */
export type PersistenceAdapterContract = {
  readonly [M in PortMethodName<PortName> | PersistenceAdapterInfrastructureMethod]:
    M extends keyof TypedPersistenceAdapterContract
      ? TypedPersistenceAdapterContract[M]
      : M extends keyof PersistenceAdapterInfrastructure
        ? PersistenceAdapterInfrastructure[M]
        : (...args: any[]) => any;
};

/** Domain-grouped repository ports, typed from the adapter that backs them. */
export type PersistencePorts<A extends PersistenceAdapterMethods = PersistenceAdapterMethods> = {
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
