import { assertPersistenceAdapter } from "../application/persistence-ports.mjs";
import { createSqliteArticleStore } from "./sqlite-article-store.mjs";
import { createSqliteTaxonomyStore } from "./sqlite-taxonomy-store.mjs";
import { createSqliteProfileStore } from "./sqlite-profile-store.mjs";
import { createSqliteEngagementStore } from "./sqlite-engagement-store.mjs";
import { createSqliteConversationStore } from "./sqlite-conversation-store.mjs";
import { createSqliteNotificationStore } from "./sqlite-notification-store.mjs";
import { createSqliteSessionStore } from "./sqlite-session-store.mjs";
import { createSqliteOutboxStore } from "./sqlite-outbox-store.mjs";
import { createSqliteClient, runSqliteMigrations } from "./sqlite.mjs";

/**
 * Compose the SQLite domain slices into one adapter-shaped object.
 *
 * This factory deliberately does not register SQLite with the application
 * runtime. Shape validation is necessary but not sufficient: provider
 * activation remains gated on shared behavioral contract parity with Postgres.
 */
export function createSqliteStore(db) {
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
    createSqliteOutboxStore(db),
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
 * This is an opt-in construction helper, not a registered runtime provider.
 */
export async function createSqlitePersistence({
  filename,
  timeoutMs = 5000,
  enableWal = true,
} = {}) {
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
