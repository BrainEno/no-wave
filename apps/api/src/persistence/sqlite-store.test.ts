import assert from "node:assert/strict";
import test from "node:test";
import { persistencePortMethods } from "../application/persistence-ports.ts";
import { createSqlitePersistence, createSqliteStore } from "./sqlite-store.ts";
import { createSqliteClient, runSqliteMigrations } from "./sqlite.ts";

test("SQLite slices compose into a complete adapter-shaped object without runtime registration", async () => {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  try {
    await runSqliteMigrations(db);
    const adapter = createSqliteStore(db);
    for (const methods of Object.values(persistencePortMethods)) {
      for (const method of methods) {
        assert.equal(typeof adapter[method], "function", `missing adapter method: ${method}`);
      }
    }
    assert.equal(await adapter.health(), true);
    assert.equal(Object.isFrozen(adapter), true);
  } finally {
    db.close();
  }
});

test("SQLite persistence helper migrates before exposing the adapter and closes cleanly", async () => {
  const runtime = await createSqlitePersistence({ filename: ":memory:", enableWal: false });
  try {
    assert.equal(await runtime.adapter.health(), true);
    assert.equal(
      runtime.adapter.listPublishedArticles instanceof Function,
      true,
    );
    assert.equal(Object.isFrozen(runtime), true);
  } finally {
    runtime.close();
  }
});

test("SQLite store rejects an invalid database connection", () => {
  assert.throws(() => createSqliteStore(null), /DatabaseSync connection is required/);
});
