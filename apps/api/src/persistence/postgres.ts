import { assertPersistenceAdapter, type TypedPersistenceAdapterContract } from "../application/persistence-ports.ts";
import { createPostgresIdentityStore } from "./postgres-identity-store.ts";
import { createPostgresArticleStore } from "./postgres-article-store.ts";
import { createPostgresTaxonomyStore } from "./postgres-taxonomy-store.ts";
import { createPostgresProfileStore } from "./postgres-profile-store.ts";
import { createPostgresEngagementStore } from "./postgres-engagement-store.ts";
import { createPostgresConversationStore } from "./postgres-conversation-store.ts";
import { createPostgresNotificationStore } from "./postgres-notification-store.ts";
import { createPostgresOutboxStore } from "./postgres-outbox-store.ts";
import { createPostgresMediaStore } from "./postgres-media-store.ts";
import { createPostgresSessionStore } from "./postgres-session-store.ts";

export function createPostgresClient({
  connectionString = process.env.DATABASE_URL,
  max = 10,
  idle_timeout = 20,
  connect_timeout = 10,
} = {}): Promise<any> {
  if (typeof connectionString !== "string" || connectionString.length === 0) {
    throw new Error("DATABASE_URL is required to create the PostgreSQL client.");
  }
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL.");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("DATABASE_URL must use postgres:// or postgresql://.");
  }
  return import("postgres").then(({ default: postgres }) => postgres(connectionString, {
    max, idle_timeout, connect_timeout, connection: { application_name: "bot-thk-api" },
  } as never));
}

/**
 * Compose the PostgreSQL domain slices into one adapter-shaped object.
 *
 * Each slice mirrors its SQLite counterpart (see `sqlite-*-store.ts`) so the
 * two providers stay behaviourally aligned. This file owns only the connection
 * check and the composition; all SQL lives in the slices.
 */
export function createPostgresStore(sql: any): TypedPersistenceAdapterContract {
  if (!sql || typeof (sql as { unsafe?: unknown; begin?: unknown }).unsafe !== "function" || typeof (sql as { begin?: unknown }).begin !== "function") {
    throw new TypeError("A postgres.js SQL client is required.");
  }

  const adapter = Object.assign(
    {},
    createPostgresArticleStore(sql as never),
    createPostgresTaxonomyStore(sql as never),
    createPostgresProfileStore(sql as never),
    createPostgresEngagementStore(sql as never),
    createPostgresConversationStore(sql as never),
    createPostgresNotificationStore(sql as never),
    createPostgresOutboxStore(sql as never),
    createPostgresMediaStore(sql as never),
    createPostgresSessionStore(sql as never),
    createPostgresIdentityStore(sql as never),
  );

  return Object.freeze(assertPersistenceAdapter(adapter as unknown as TypedPersistenceAdapterContract)) as TypedPersistenceAdapterContract;
}
