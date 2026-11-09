import { assertDisjointSlices, assertPersistenceAdapter, type TypedPersistenceAdapterContract } from "../application/persistence-ports.ts";
import { createSqliteArticleStore } from "./sqlite-article-store.ts";
import { createSqliteTaxonomyStore } from "./sqlite-taxonomy-store.ts";
import { createSqliteProfileStore } from "./sqlite-profile-store.ts";
import { createSqliteEngagementStore } from "./sqlite-engagement-store.ts";
import { createSqliteConversationStore } from "./sqlite-conversation-store.ts";
import { createSqliteNotificationStore } from "./sqlite-notification-store.ts";
import { createSqliteSessionStore } from "./sqlite-session-store.ts";
import { createSqliteIdentityStore } from "./sqlite-identity-store.ts";
import { createSqliteOutboxStore } from "./sqlite-outbox-store.ts";
import { createSqliteMediaStore } from "./sqlite-media-store.ts";
import { createSqliteImportStore } from "./sqlite-import-store.ts";
import { createSqliteClient, runSqliteMigrations, type SqliteRunner } from "./sqlite.ts";

/**
 * Compose the SQLite domain slices into one adapter-shaped object.
 *
 * Every slice is checked at compile time against a `Pick` of the shared
 * contract, and the composed object literal is checked with `satisfies`. The
 * runtime assertion also verifies that no two slices claim the same method
 * name: an object spread would otherwise let a later slice silently win.
 */
export function createSqliteStore(db: SqliteRunner): TypedPersistenceAdapterContract {
  if (!db || typeof db.prepare !== "function" || typeof db.exec !== "function") {
    throw new TypeError("A node:sqlite DatabaseSync connection is required.");
  }

  const article = createSqliteArticleStore(db);
  const taxonomy = createSqliteTaxonomyStore(db);
  const profiles = createSqliteProfileStore(db);
  const engagement = createSqliteEngagementStore(db);
  const conversations = createSqliteConversationStore(db);
  const notifications = createSqliteNotificationStore(db);
  const sessionStore = createSqliteSessionStore(db);
  // The identity slice owns `revokeSession`: it revokes both auth_sessions and
  // revoked_sessions in one transaction, while the older session slice only
  // touched revoked_sessions. Compose only the lookup from that slice so the
  // winning implementation is explicit rather than a silent spread override.
  const sessions = Object.freeze({ isSessionRevoked: sessionStore.isSessionRevoked });
  const identity = createSqliteIdentityStore(db);
  const outbox = createSqliteOutboxStore(db);
  const media = createSqliteMediaStore(db);
  const imports = createSqliteImportStore(db);
  const operations = Object.freeze({
    async health() {
      db.prepare("SELECT 1 AS ok").get();
      return true;
    },
  });

  const slices = [
    ["article", article], ["taxonomy", taxonomy], ["profiles", profiles],
    ["engagement", engagement], ["conversations", conversations],
    ["notifications", notifications], ["sessions", sessions], ["identity", identity],
    ["outbox", outbox], ["media", media], ["imports", imports], ["operations", operations],
  ] as const;
  assertDisjointSlices(slices);

  const adapter = {
    ...article,
    ...taxonomy,
    ...profiles,
    ...engagement,
    ...conversations,
    ...notifications,
    ...sessions,
    ...identity,
    ...outbox,
    ...media,
    ...imports,
    ...operations,
  } satisfies TypedPersistenceAdapterContract;

  return Object.freeze(assertPersistenceAdapter(adapter));
}

/**
 * Open and migrate a SQLite database, then return the composed adapter.
 * The caller owns the returned connection and must call close() on shutdown.
 * This remains a convenience helper for callers that explicitly want migration
 * before exposing the adapter; normal API startup checks migrations but does not
 * change the schema unless DATABASE_AUTO_MIGRATE=true is explicitly set.
 */
export async function createSqlitePersistence({
  filename,
  timeoutMs = 5000,
  enableWal = true,
}: { filename?: string; timeoutMs?: number; enableWal?: boolean } = {}) {
  const db = createSqliteClient({ filename, timeoutMs, enableWal });
  try {
    await runSqliteMigrations(db);
    return Object.freeze({
      adapter: createSqliteStore(db),
      close: () => db.close(),
    });
  } catch (error) {
    db.close();
    throw error;
  }
}
