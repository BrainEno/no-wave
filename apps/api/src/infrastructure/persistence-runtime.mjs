import { assertPersistenceAdapter } from "../application/persistence-ports.mjs";

const builtInProviders = Object.freeze({
  postgres: async ({ env }) => {
    if (typeof env.DATABASE_URL !== "string" || env.DATABASE_URL.length === 0) {
      throw new Error("DATABASE_URL is required when DATABASE_PROVIDER=postgres.");
    }
    const { createPostgresClient, createPostgresStore } = await import("../persistence/postgres.mjs");
    const client = await createPostgresClient({ connectionString: env.DATABASE_URL });
    return {
      adapter: createPostgresStore(client),
      close: () => client.end({ timeout: 5 }),
    };
  },
});

/**
 * Select a persistence implementation explicitly. Additional adapters can be
 * injected here once they pass the shared adapter contract and contract tests.
 * Unsupported providers fail closed; no silent fallback to PostgreSQL occurs.
 */
export async function createPersistenceRuntime({
  provider = "postgres",
  env = process.env,
  providers = builtInProviders,
} = {}) {
  if (typeof provider !== "string" || provider.trim() !== provider || provider.length === 0) {
    throw new TypeError("DATABASE_PROVIDER must be a non-empty provider name.");
  }
  const factory = providers[provider];
  if (typeof factory !== "function") {
    const available = Object.keys(providers).sort();
    throw new Error(
      `DATABASE_PROVIDER "${provider}" has no registered adapter. Available providers: ${available.join(", ") || "(none)"}.`
    );
  }
  const runtime = await factory({ env });
  if (!runtime || !runtime.adapter || typeof runtime.adapter !== "object" || typeof runtime.close !== "function") {
    throw new TypeError(`The "${provider}" persistence factory must return { adapter, close }.`);
  }
  assertPersistenceAdapter(runtime.adapter);
  return Object.freeze({ provider, adapter: runtime.adapter, close: runtime.close });
}
