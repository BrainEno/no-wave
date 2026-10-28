import test from "node:test";
import assert from "node:assert/strict";
import { createPersistenceRuntime, describePersistenceRuntime } from "./persistence-runtime.ts";
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

test("SQLite startup notice identifies experimental Node 24 minors and the release-candidate floor", () => {
  const oldNode24 = describePersistenceRuntime({ provider: "sqlite", nodeVersion: "v24.11.0" });
  assert.equal(oldNode24.event, "api.runtime_compatibility");
  assert.equal(oldNode24.level, "warn");
  assert.equal(oldNode24.sqliteApiStability, "experimental");
  assert.equal(oldNode24.deploymentProfile, "local-single-host");
  assert.match(oldNode24.message, /experimental/i);
  assert.match(oldNode24.message, /24\.15\.0/);

  const releaseCandidate = describePersistenceRuntime({ provider: "sqlite", nodeVersion: "v24.15.0" });
  assert.equal(releaseCandidate.sqliteApiStability, "release-candidate");
  assert.match(releaseCandidate.message, /not a stable API/i);
  assert.equal(
    describePersistenceRuntime({ provider: "sqlite", nodeVersion: "v24.22.1" }).sqliteApiStability,
    "release-candidate",
  );
});

test("PostgreSQL startup notice recommends the production deployment profile without SQLite warnings", () => {
  const notice = describePersistenceRuntime({ provider: "postgres", nodeVersion: "v24.15.0" });
  assert.equal(notice.level, "info");
  assert.equal(notice.deploymentProfile, "production-recommended");
  assert.equal("sqliteApiStability" in notice, false);
  assert.match(notice.message, /recommended provider for production/i);
});
