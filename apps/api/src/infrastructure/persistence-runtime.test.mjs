import test from "node:test";
import assert from "node:assert/strict";
import { createPersistenceRuntime } from "./persistence-runtime.mjs";
import { persistencePortMethods } from "../application/persistence-ports.mjs";

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
