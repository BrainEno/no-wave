import test from "node:test";
import assert from "node:assert/strict";
import { createPersistenceRuntime } from "./persistence-runtime.ts";
import { persistencePortMethods } from "../application/persistence-ports.ts";
import { resolveDatabaseProvider, resolveSqliteDatabasePath } from "./database-config.ts";

function completeFakeAdapter() {
  const adapter = {};
  for (const methods of Object.values(persistencePortMethods)) {
    for (const method of methods) adapter[method] = async () => true;
  }
  return adapter;
}

test("provider registry selects the configured adapter explicitly", async () => {
  let observed = null;
  const adapter = completeFakeAdapter();
  const runtime = await createPersistenceRuntime({
    provider: "sqlite",
    env: { DATABASE_URL: "file:test.db" },
    providers: {
      sqlite: async ({ env }) => {
        observed = env.DATABASE_URL;
        return { adapter, close: async () => {} };
      },
    },
  });
  assert.equal(runtime.provider, "sqlite");
  assert.equal(runtime.adapter, adapter);
  assert.equal(observed, "file:test.db");
});

test("fresh configuration defaults to SQLite and legacy DATABASE_URL continues to select Postgres", () => {
  assert.equal(resolveDatabaseProvider({ env: {} }), "sqlite");
  assert.equal(resolveDatabaseProvider({ env: { DATABASE_URL: "postgresql://localhost/no-wave" } }), "postgres");
  assert.equal(resolveDatabaseProvider({ env: { DATABASE_PROVIDER: "mongodb" } }), "mongodb");
  assert.throws(() => resolveDatabaseProvider({ env: { DATABASE_PROVIDER: " sqlite " } }), /non-empty provider name/i);
  assert.equal(resolveSqliteDatabasePath({ env: { DATABASE_PATH: ":memory:" } }), ":memory:");
  assert.match(resolveSqliteDatabasePath({ env: {} }), /data[\\/]no-wave\.sqlite$/);
});

test("the built-in SQLite provider migrates explicitly, validates full port shape and closes cleanly", async () => {
  const runtime = await createPersistenceRuntime({
    env: { DATABASE_PATH: ":memory:", DATABASE_AUTO_MIGRATE: "true" },
  });
  try {
    assert.equal(runtime.provider, "sqlite");
    assert.equal(await runtime.adapter.health(), true);
    for (const methods of Object.values(persistencePortMethods)) {
      for (const method of methods) assert.equal(typeof runtime.adapter[method], "function", `missing ${method}`);
    }
  } finally {
    runtime.close();
  }
});

test("SQLite runtime refuses an uninitialized database and explains the migration command", async () => {
  await assert.rejects(
    createPersistenceRuntime({ env: { DATABASE_PATH: ":memory:" } }),
    /SQLite schema is not current.*pnpm --filter @bot-thk\/api migrate/i,
  );
});

test("unimplemented providers fail closed and never fall back to PostgreSQL", async () => {
  await assert.rejects(
    createPersistenceRuntime({
      provider: "mongodb",
      env: {},
      providers: { postgres: async () => ({ adapter: completeFakeAdapter(), close: async () => {} }) },
    }),
    /DATABASE_PROVIDER "mongodb" has no registered adapter/,
  );
});

test("provider runtime rejects adapters that do not implement the full persistence contract", async () => {
  await assert.rejects(
    createPersistenceRuntime({
      provider: "incomplete",
      providers: { incomplete: async () => ({ adapter: { health: async () => true }, close: async () => {} }) },
    }),
    /Persistence adapter is missing required operations: content\.listPublishedArticles/,
  );
});

test("provider factory results must include a close function", async () => {
  await assert.rejects(
    createPersistenceRuntime({
      provider: "broken",
      providers: { broken: async () => ({ adapter: {} }) },
    }),
    /must return \{ adapter, close \}/,
  );
});
