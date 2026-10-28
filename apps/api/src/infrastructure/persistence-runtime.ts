import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { assertPersistenceAdapter } from "../application/persistence-ports.ts";
import { resolveDatabaseProvider, resolveSqliteDatabasePath } from "./database-config.ts";

const builtInProviders = Object.freeze({
  sqlite: async ({ env }) => {
    const filename = resolveSqliteDatabasePath({ env });
    if (filename !== ":memory:") await mkdir(dirname(filename), { recursive: true });
    const { createSqliteClient, getSqliteMigrationStatus, runSqliteMigrations } = await import("../persistence/sqlite.ts");
    const { createSqliteStore } = await import("../persistence/sqlite-store.ts");
    const db = createSqliteClient({ filename });
    try {
      if (env.DATABASE_AUTO_MIGRATE === "true") await runSqliteMigrations(db);
      const status = await getSqliteMigrationStatus(db);
      if (status.pending.length > 0) {
        throw new Error(
          `SQLite schema is not current. Run "pnpm --filter @bot-thk/api migrate" before starting the API. Pending: ${status.pending.join(", ")}.`,
        );
      }
      return { adapter: createSqliteStore(db), close: () => db.close() };
    } catch (error) {
      db.close();
      throw error;
    }
  },
  postgres: async ({ env }) => {
    if (typeof env.DATABASE_URL !== "string" || env.DATABASE_URL.length === 0) {
      throw new Error("DATABASE_URL is required when DATABASE_PROVIDER=postgres.");
    }
    const { createPostgresClient, createPostgresStore } = await import("../persistence/postgres.ts");
    const client = await createPostgresClient({ connectionString: env.DATABASE_URL });
    return { adapter: createPostgresStore(client), close: () => client.end({ timeout: 5 }) };
  },
});

/**
 * SQLite is the fresh-install default. Existing deployments that set only
 * DATABASE_URL keep using PostgreSQL; provider switches are always explicit.
 * MongoDB remains unavailable until its adapter passes the shared contracts.
 */
export async function createPersistenceRuntime({
  provider,
  env = process.env,
  providers = builtInProviders,
}: {
  provider?: string;
  env?: NodeJS.ProcessEnv;
  providers?: Record<string, (args: { env: NodeJS.ProcessEnv }) => Promise<any> | any>;
} = {}) {
  const selectedProvider = resolveDatabaseProvider({ provider, env });
  const factory = providers[selectedProvider];
  if (typeof factory !== "function") {
    const available = Object.keys(providers).sort();
    throw new Error(
      `DATABASE_PROVIDER "${selectedProvider}" has no registered adapter. Available providers: ${available.join(", ") || "(none)"}.`,
    );
  }
  const runtime = await factory({ env });
  if (!runtime || !runtime.adapter || typeof runtime.adapter !== "object" || typeof runtime.close !== "function") {
    throw new TypeError(`The "${selectedProvider}" persistence factory must return { adapter, close }.`);
  }
  assertPersistenceAdapter(runtime.adapter);
  return Object.freeze({ provider: selectedProvider, adapter: runtime.adapter, close: runtime.close });
}
