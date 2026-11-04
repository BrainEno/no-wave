/**
 * Compile-time regression guards for the typed persistence port contract
 * (issues #66 / #167).
 *
 * This module is intentionally never imported at runtime: `pnpm typecheck` is
 * its test runner, and the API tsconfig includes `src/**\/*.ts` (minus tests),
 * so every line below participates in CI's TypeScript compilation. Each
 * `@ts-expect-error` must remain an error. If the port surface ever falls back
 * to `(...args: any[]) => any` again, TypeScript reports an *unused*
 * `@ts-expect-error` directive and the build fails — which is the property the
 * contract is meant to guarantee.
 */
import type {
  PersistenceAdapterContract,
  PersistencePorts,
  PersistenceResult,
  StoredArticle,
  TypedPersistenceAdapterContract,
} from "./persistence-ports.ts";
import type { ApplicationServices } from "./services.ts";
import type { createSqliteArticleStore } from "../persistence/sqlite-article-store.ts";
import type { createSqliteTaxonomyStore } from "../persistence/sqlite-taxonomy-store.ts";
import type { createSqliteProfileStore } from "../persistence/sqlite-profile-store.ts";
import type { createSqliteEngagementStore } from "../persistence/sqlite-engagement-store.ts";
import type { createSqliteConversationStore } from "../persistence/sqlite-conversation-store.ts";
import type { createSqliteNotificationStore } from "../persistence/sqlite-notification-store.ts";
import type { createSqliteSessionStore } from "../persistence/sqlite-session-store.ts";
import type { createSqliteIdentityStore } from "../persistence/sqlite-identity-store.ts";
import type { createSqliteOutboxStore } from "../persistence/sqlite-outbox-store.ts";
import type { createSqliteMediaStore } from "../persistence/sqlite-media-store.ts";
import type { createPostgresArticleStore } from "../persistence/postgres-article-store.ts";
import type { createPostgresTaxonomyStore } from "../persistence/postgres-taxonomy-store.ts";
import type { createPostgresProfileStore } from "../persistence/postgres-profile-store.ts";
import type { createPostgresEngagementStore } from "../persistence/postgres-engagement-store.ts";
import type { createPostgresConversationStore } from "../persistence/postgres-conversation-store.ts";
import type { createPostgresNotificationStore } from "../persistence/postgres-notification-store.ts";
import type { createPostgresSessionStore } from "../persistence/postgres-session-store.ts";
import type { createPostgresIdentityStore } from "../persistence/postgres-identity-store.ts";
import type { createPostgresOutboxStore } from "../persistence/postgres-outbox-store.ts";
import type { createPostgresMediaStore } from "../persistence/postgres-media-store.ts";

declare const ports: PersistencePorts;
declare const services: ApplicationServices;
declare const adapter: PersistenceAdapterContract;

/** Nothing here executes; the calls exist only so `tsc` checks their arguments. */
export function assertTypedPortInputs(): void {
  void ports.content.getPublishedArticle({ slug: "hello", locale: "en" });
  void services.getPublishedArticle({ slug: "hello", locale: "en" });
  void services.listPublishedArticles({ locale: "en", limit: 20, offset: 0 });
  void ports.content.listPublishedArticles({ sort: "popular", limit: 20 });
  void ports.taxonomy.deleteTaxonomy({ taxonomyId: "t", actorId: "u" });
  void ports.content.setFeaturedArticles({ actorId: "u", articleIds: ["a"] });
  void ports.notifications.deliverMessageNotifications({ eventKey: "e", messageId: "m", conversationId: "c", senderId: "s" });

  // @ts-expect-error a misspelled port parameter name is a compile error
  void ports.content.getPublishedArticle({ slugg: "hello" });
  // @ts-expect-error a wrong port parameter type is a compile error
  void ports.content.listPublishedArticles({ limit: "20" });
  // @ts-expect-error a misspelled transport parameter name is a compile error
  void services.listPublishedArticles({ limt: 20 });
  // @ts-expect-error an enum value outside the declared union is a compile error
  void ports.content.listPublishedArticles({ sort: "newest" });
  // @ts-expect-error a required input object cannot be omitted
  void ports.content.getPublishedArticle();
  // @ts-expect-error a required field cannot be omitted from a required input
  void ports.content.setFeaturedArticles({ actorId: "u" });
  // @ts-expect-error `deleteTaxonomy` needs both taxonomyId and actorId
  void ports.taxonomy.deleteTaxonomy({ taxonomyId: "t" });
  // @ts-expect-error an extra positional argument is a compile error (wrong arity)
  void ports.content.getPublishedArticle({ slug: "hello" }, 2);
  // @ts-expect-error a method that is not in the port table does not exist
  void ports.content.listPublishedArticless({});
  // @ts-expect-error the flat adapter contract has no `any` catch-all method
  void adapter.notAMethodAtAll;
  // @ts-expect-error media metadata is not exposed through the REST port groups
  void ports.media;
  // @ts-expect-error media metadata is not exposed through the REST service facade
  void services.createMediaAsset;
  // @ts-expect-error `health` resolves to a boolean, not a number
  const wrongReturn: Promise<number> = ports.operations.health();
  void wrongReturn;
}

/** The declared result shapes are the ones the stores actually return. */
export async function assertTypedPortOutputs(): Promise<void> {
  const article: StoredArticle | null = await ports.content.getPublishedArticle({ slug: "hello" });
  void article?.id;
  // @ts-expect-error a stored article has no `html` field
  void article?.html;

  const unread: number = await ports.notifications.getUnreadNotificationCount({ actorId: "u" });
  void unread;
  // @ts-expect-error the unread count is a number, not `{ count }`
  const wrongCount: { count: number } = await ports.notifications.getUnreadNotificationCount({ actorId: "u" });
  void wrongCount;

  const deleted: boolean = await ports.taxonomy.deleteTaxonomy({ taxonomyId: "t", actorId: "u" });
  void deleted;
  const followed: boolean = await ports.profiles.followUser({ actorId: "u", targetUserId: "v" });
  void followed;
  const delivered: boolean = await ports.notifications.deliverMessageNotifications({ eventKey: "e", messageId: "m", conversationId: "c", senderId: "s" });
  void delivered;
  const receiptDuplicate: boolean = (await ports.notifications.createNotification({ userId: "u", eventKey: "e", payload: {} })).duplicate;
  void receiptDuplicate;
  const inboxReadAt: string | null = (await ports.notifications.listNotifications({ actorId: "u" }))[0].readAt;
  void inboxReadAt;
  const outboxEventKey: string = (await ports.outbox.claimOutboxEvents())[0].event_key;
  void outboxEventKey;
  const role: string = await ports.profiles.setUserRole({ actorId: "u", userId: "v", role: "editor" });
  void role;
  const participantIds: string[] = await ports.conversations.updateConversationParticipants({ conversationId: "c", actorId: "u" });
  void participantIds;
  // @ts-expect-error the participant update returns ids in both providers, not a boolean
  const wrongParticipantIds: boolean = await ports.conversations.updateConversationParticipants({ conversationId: "c", actorId: "u" });
  void wrongParticipantIds;

  // A SQLite slice may answer synchronously; both forms are valid results.
  const syncResult: PersistenceResult<number> = 1;
  const asyncResult: PersistenceResult<number> = Promise.resolve(1);
  void syncResult; void asyncResult;
}

/** An adapter with a wrongly typed method cannot satisfy the contract. */
export function assertTypedAdapterShape(): void {
  void ({ async getPublishedArticle({ slug, locale }: { slug: string; locale?: string }) { return { slug, locale } as never; } } satisfies Pick<TypedPersistenceAdapterContract, "getPublishedArticle">);
  void ({ async deleteTaxonomy({ taxonomyId, actorId }: { taxonomyId: string; actorId: string }) { return true; } } satisfies Pick<TypedPersistenceAdapterContract, "deleteTaxonomy">);

  // @ts-expect-error an adapter method taking a parameter the contract does not declare is rejected
  void ({ async getPublishedArticle({ slugg }: { slugg: string }) { return null; } } satisfies Pick<TypedPersistenceAdapterContract, "getPublishedArticle">);
  // @ts-expect-error a wrong result field (a missing `id`) is rejected
  void ({ async getPublishedArticle() { return { slug: "hello" }; } } satisfies Pick<TypedPersistenceAdapterContract, "getPublishedArticle">);
  // @ts-expect-error `getUnreadNotificationCount` returns a number, not an object
  void ({ async getUnreadNotificationCount() { return { count: 0 }; } } satisfies Pick<TypedPersistenceAdapterContract, "getUnreadNotificationCount">);
  // @ts-expect-error `followUser` returns a boolean, not `unknown`-shaped void
  void ({ async followUser() { return { ok: true }; } } satisfies Pick<TypedPersistenceAdapterContract, "followUser">);
  // @ts-expect-error `updateConversationParticipants` returns active ids, not `true`
  void ({ async updateConversationParticipants() { return true; } } satisfies Pick<TypedPersistenceAdapterContract, "updateConversationParticipants">);
  // @ts-expect-error a required adapter method cannot be missing from a Pick slice
  void ({ async otherMethod() { return 1; } } satisfies Pick<TypedPersistenceAdapterContract, "getPublishedArticle">);
}

/* -------------------------------------------------------------------------- */
/* Compile-time slice disjointness                                            */
/* -------------------------------------------------------------------------- */

type KeysOfUnion<U> = U extends unknown ? keyof U : never;
type PairwiseOverlaps<S extends readonly unknown[]> = S extends readonly [infer Head, ...infer Tail]
  ? Extract<keyof Head, KeysOfUnion<Tail[number]>> | PairwiseOverlaps<Tail>
  : never;
/** Fails to compile unless `T` is `never` — i.e. no two slices share a key. */
type RequireDisjoint<T extends never> = true;

/**
 * The SQLite composition takes only `isSessionRevoked` from the session slice
 * (the identity slice owns `revokeSession`), which is exactly what this list
 * models. `assertDisjointSlices` enforces the same invariant at runtime.
 */
type ComposedSqliteSlices = [
  ReturnType<typeof createSqliteArticleStore>,
  ReturnType<typeof createSqliteTaxonomyStore>,
  ReturnType<typeof createSqliteProfileStore>,
  ReturnType<typeof createSqliteEngagementStore>,
  ReturnType<typeof createSqliteConversationStore>,
  ReturnType<typeof createSqliteNotificationStore>,
  Omit<ReturnType<typeof createSqliteSessionStore>, "revokeSession">,
  ReturnType<typeof createSqliteIdentityStore>,
  ReturnType<typeof createSqliteOutboxStore>,
  ReturnType<typeof createSqliteMediaStore>,
];
type ComposedPostgresSlices = [
  ReturnType<typeof createPostgresIdentityStore>,
  ReturnType<typeof createPostgresArticleStore>,
  ReturnType<typeof createPostgresTaxonomyStore>,
  ReturnType<typeof createPostgresProfileStore>,
  ReturnType<typeof createPostgresEngagementStore>,
  ReturnType<typeof createPostgresConversationStore>,
  ReturnType<typeof createPostgresNotificationStore>,
  ReturnType<typeof createPostgresOutboxStore>,
  ReturnType<typeof createPostgresMediaStore>,
  ReturnType<typeof createPostgresSessionStore>,
];

export type SqliteSlicesAreDisjoint = RequireDisjoint<PairwiseOverlaps<ComposedSqliteSlices>>;
export type PostgresSlicesAreDisjoint = RequireDisjoint<PairwiseOverlaps<ComposedPostgresSlices>>;
