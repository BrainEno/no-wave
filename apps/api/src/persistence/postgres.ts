/**
 * PostgreSQL provider entry point.
 *
 * This module owns only connection-pool creation, the transaction helper and
 * the composition of the domain slices. Every domain operation lives in the
 * matching `postgres-*-store.ts`, aligned with the SQLite slices.
 */
import { assertDisjointSlices, assertPersistenceAdapter, type TypedPersistenceAdapterContract } from "../application/persistence-ports.ts";
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
import { createPostgresStoreContext } from "./postgres-shared.ts";
import type { PgDatabase } from "./postgres-driver.ts";

export function createPostgresClient({
  connectionString = process.env.DATABASE_URL,
  max = 10,
  idle_timeout = 20,
  connect_timeout = 10,
} = {}): Promise<PgDatabase> {
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
 * Compose every PostgreSQL domain slice into one adapter-shaped object.
 *
 * The identity slice comes first so the session and rate-limit methods it owns
 * are present before the remaining slices are mixed in; no slice overrides a
 * method owned by another (the runtime assertion below is the guard).
 */
export function createPostgresStore(sql: PgDatabase): TypedPersistenceAdapterContract {
  if (!sql || typeof sql.unsafe !== "function" || typeof sql.begin !== "function") {
    throw new TypeError("A postgres.js SQL client is required.");
  }
  const ctx = createPostgresStoreContext(sql);
  const identity = createPostgresIdentityStore(sql);
  const article = createPostgresArticleStore(ctx);
  const taxonomy = createPostgresTaxonomyStore(ctx);
  const profiles = createPostgresProfileStore(ctx);
  const engagement = createPostgresEngagementStore(ctx);
  const conversations = createPostgresConversationStore(ctx);
  const notifications = createPostgresNotificationStore(ctx);
  const outbox = createPostgresOutboxStore(ctx);
  const media = createPostgresMediaStore(ctx);
  const sessions = createPostgresSessionStore(ctx);
  // `transaction` is PostgreSQL-only; it is optional in the shared contract so
  // the SQLite provider is not forced to invent a matching helper.
  const provider = Object.freeze({
    async health() {
      await sql.unsafe("SELECT 1 AS ok");
      return true;
    },
    transaction(work) {
      if (typeof work !== "function") throw new TypeError("Transaction callback is required.");
      return sql.begin(work);
    },
  });

  const slices = [
    ["identity", identity], ["article", article], ["taxonomy", taxonomy],
    ["profiles", profiles], ["engagement", engagement], ["conversations", conversations],
    ["notifications", notifications], ["outbox", outbox], ["media", media],
    ["sessions", sessions], ["provider", provider],
  ] as const;
  assertDisjointSlices(slices);

  // A single object literal (not Object.assign with 10 sources, whose TS
  // overload collapses to `any`) keeps `satisfies` a real compile-time check.
  const adapter = {
    ...identity,
    ...article,
    ...taxonomy,
    ...profiles,
    ...engagement,
    ...conversations,
    ...notifications,
    ...outbox,
    ...media,
    ...sessions,
    ...provider,
  } satisfies TypedPersistenceAdapterContract;
  return Object.freeze(assertPersistenceAdapter(adapter));
}
