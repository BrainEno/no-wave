/**
 * PostgreSQL persistence: connection management plus composition of the domain
 * slices (issue #167).
 *
 * The adapter used to be one 2,241-line file. It is now the same code, cut along
 * the domains the SQLite provider has always used (`sqlite-*-store.ts`), because
 * the cost of the single file was not its size: it was that an author looking at
 * "how do PostgreSQL likes behave" had to find them among comments, conversations
 * and outbox leases, and that every slice could reach every other slice's SQL.
 *
 * This entry file keeps the three things that must not be duplicated:
 *
 * 1. **One connection pool** — `createPostgresClient` is the only place a DSN
 *    becomes a client, and it validates the URL before importing the driver.
 * 2. **One migration-journal capture** — every slice mutates through
 *    `captureChanges`, which is constructed here once and handed down, so a slice
 *    cannot forget to journal a change and silently break replica replay.
 * 3. **One composed store** — `createPostgresStore` returns the union of the
 *    slices behind `PersistenceAdapterContract`, so `assertPersistenceAdapter`
 *    still fails at startup (not at first request) when a port method is missing.
 */
import type { PersistenceAdapterContract } from "../application/persistence-ports.ts";
import { createPostgresProviderMigrationCapture } from "./postgres-provider-migration-capture.ts";
import { createPostgresIdentityStore } from "./postgres-identity-store.ts";
import { createPostgresArticleStore } from "./postgres-article-store.ts";
import { createPostgresTaxonomyStore } from "./postgres-taxonomy-store.ts";
import { createPostgresProfileStore } from "./postgres-profile-store.ts";
import { createPostgresEngagementStore } from "./postgres-engagement-store.ts";
import { createPostgresConversationStore } from "./postgres-conversation-store.ts";
import { createPostgresNotificationStore } from "./postgres-notification-store.ts";
import { createPostgresOutboxStore } from "./postgres-outbox-store.ts";
import { createPostgresMediaStore } from "./postgres-media-store.ts";

/**
 * Open a pooled PostgreSQL client.
 *
 * The DSN is validated here rather than at the first query so a malformed URL is
 * a startup error with a sentence in it, instead of a driver error on whichever
 * request happened to run first. The driver itself is imported lazily so the
 * SQLite provider never pays for it.
 */
export function createPostgresClient({
  connectionString = process.env.DATABASE_URL,
  max = 10,
  idle_timeout = 20,
  connect_timeout = 10,
} = {}) {
  if (typeof connectionString !== "string" || connectionString.length === 0) {
    throw new Error("DATABASE_URL is required to create the PostgreSQL client.");
  }
  let parsed;
  try { parsed = new URL(connectionString); } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL.");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("DATABASE_URL must use postgres:// or postgresql://.");
  }
  return import("postgres").then(({ default: postgres }) => postgres(connectionString, {
    max, idle_timeout, connect_timeout, connection: { application_name: "bot-thk-api" },
  }));
}

/**
 * Compose every PostgreSQL domain slice into one adapter.
 *
 * The slices share the pool, the journal capture and one `sql.begin`. `health`
 * and the legacy `transaction` hook stay here because they are about the
 * connection, not about a domain; `isSessionRevoked` stays with the pool too, as
 * the last piece of the pre-identity session port that the identity slice still
 * answers for.
 */
export function createPostgresStore(sql): PersistenceAdapterContract {
  if (!sql || typeof sql.unsafe !== "function" || typeof sql.begin !== "function") {
    throw new TypeError("A postgres.js SQL client is required.");
  }
  const migrationCapture = createPostgresProviderMigrationCapture(sql);
  async function captureChanges(tx, transactionId, changes) {
    await migrationCapture.captureInTransaction(tx, transactionId, changes);
  }
  const slices = { sql, captureChanges };
  return Object.freeze({
    ...createPostgresIdentityStore(sql),
    ...createPostgresArticleStore(slices),
    ...createPostgresTaxonomyStore(slices),
    ...createPostgresProfileStore(slices),
    ...createPostgresEngagementStore(slices),
    ...createPostgresConversationStore(slices),
    ...createPostgresNotificationStore(slices),
    ...createPostgresOutboxStore(slices),
    ...createPostgresMediaStore(slices),
    async health() {
      await sql.unsafe("SELECT 1 AS ok");
      return true;
    },
    transaction(work) {
      if (typeof work !== "function") throw new TypeError("Transaction callback is required.");
      return sql.begin(work);
    },
    async isSessionRevoked(sessionId) {
      const rows = await sql.unsafe("SELECT 1 FROM revoked_sessions WHERE session_id = $1 AND expires_at > now()", [sessionId]);
      return rows.length > 0;
    },
  });
}
