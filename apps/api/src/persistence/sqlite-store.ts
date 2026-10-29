import { assertPersistenceAdapter, type PersistenceAdapterContract } from "../application/persistence-ports.ts";
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
import { createSqliteClient, runSqliteMigrations } from "./sqlite.ts";

/**
 * Compose the SQLite domain slices into one adapter-shaped object.
 *
 * This full adapter is registered as the default runtime provider. Its
 * operations are covered by the shared persistence-adapter contract tests.
 */
export function createSqliteStore(db): PersistenceAdapterContract {
  if (!db || typeof db.prepare !== "function" || typeof db.exec !== "function") {
    throw new TypeError("A node:sqlite DatabaseSync connection is required.");
  }

  const adapter = Object.assign(
    {},
    createSqliteArticleStore(db),
    createSqliteTaxonomyStore(db),
    createSqliteProfileStore(db),
    createSqliteEngagementStore(db),
    createSqliteConversationStore(db),
    createSqliteNotificationStore(db),
    createSqliteSessionStore(db),
    // Identity replaces revokeSession with session-family revocation while
    // preserving the legacy revoked-session lookup from the session slice.
    createSqliteIdentityStore(db),
    createSqliteOutboxStore(db),
    createSqliteMediaStore(db),
    {
      async health() {
        db.prepare("SELECT 1 AS ok").get();
        return true;
      },
    },
  );

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
