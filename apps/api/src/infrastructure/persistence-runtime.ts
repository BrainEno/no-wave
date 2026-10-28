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
 * Describe the runtime/provider trade-off once during API startup.
 *
 * Node.js 24.15.0 moved node:sqlite to Stability 1.2 (Release Candidate).
 * It remains a pre-stable API; earlier Node 24 releases still mark it
 * experimental. Keep the supported Node major pinned until the adapter has
 * been re-evaluated against a stable API contract.
 */
export function describePersistenceRuntime({
  provider,
  nodeVersion = process.version,
}: {
  provider: string;
  nodeVersion?: string;
}) {
  if (provider !== "sqlite") {
    return Object.freeze({
      event: "api.runtime_compatibility",
      level: "info",
      provider,
      nodeVersion,
      deploymentProfile: provider === "postgres" ? "production-recommended" : "provider-specific",
      message: provider === "postgres"
        ? "PostgreSQL is the recommended provider for production/server deployments; SQLite remains intended for local or single-host use."
        : "Review the configured persistence provider's operational and compatibility requirements before production use.",
    });
  }

  const version = /^v?(\d+)\.(\d+)\.(\d+)/.exec(nodeVersion);
  const releaseCandidate = version !== null
    && Number(version[1]) === 24
    && Number(version[2]) >= 15;
  const sqliteApiStability = releaseCandidate ? "release-candidate" : "experimental";
  return Object.freeze({
    event: "api.runtime_compatibility",
    level: "warn",
    provider,
    nodeVersion,
    sqliteApiStability,
    deploymentProfile: "local-single-host",
    minimumRecommendedNodeVersion: "24.15.0",
    message: releaseCandidate
      ? "node:sqlite is a Release Candidate (Stability 1.2), not a stable API. Use SQLite for local/single-host deployments and prefer PostgreSQL for production/server deployments."
      : "node:sqlite is still experimental on this Node.js version. Node.js 24.15.0 or newer is recommended for the Release Candidate API; prefer PostgreSQL for production/server deployments.",
  });
}

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
