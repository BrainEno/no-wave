import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { createPostgresClient } from "./postgres.ts";
import { runMigrations } from "./migrate.ts";
import { createPostgresProviderMigrationJournal } from "./postgres-provider-migration-journal.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const options = { skip: !connectionString && "Set TEST_DATABASE_URL to run PostgreSQL provider-migration journal integration tests." };
let sql: any;

before(async () => {
  if (!connectionString) return;
  sql = await createPostgresClient({ connectionString, max: 4 });
  await runMigrations(sql);
});
after(async () => { if (sql) await sql.end({ timeout: 5 }); });

test("PostgreSQL migration journal orders transactional changes and commits replay checkpoint atomically", options, async () => {
  const suffix = randomUUID();
  const sessionId = "journal-it-" + suffix;
  const journal = createPostgresProviderMigrationJournal(sql);
  try {
    await journal.createSession({ sessionId, sourceProvider: "postgres", targetProvider: "sqlite", schemaVersion: "integration-v1" });
    assert.equal(await journal.transitionSession({ sessionId, expectedStatus: "prepared", nextStatus: "recording" }), true);

    const rollback = new Error("rollback test journal transaction");
    await assert.rejects(sql.begin(async (tx: any) => {
      await journal.appendChangeInTransaction(tx, { sessionId, changeId: "rolled-back", transactionId: "tx-rollback", entityType: "test", entityId: "none", operation: "upsert", payload: { value: 0 } });
      throw rollback;
    }), error => error === rollback);
    assert.deepEqual(await journal.readChangeBatch({ sessionId, afterSequence: 0 }), []);

    let first: any;
    let second: any;
    await sql.begin(async (tx: any) => {
      first = await journal.appendChangeInTransaction(tx, { sessionId, changeId: "change-1", transactionId: "tx-1", entityType: "test", entityId: "a", operation: "upsert", payload: { a: 1 } });
      second = await journal.appendChangeInTransaction(tx, { sessionId, changeId: "change-2", transactionId: "tx-1", entityType: "test", entityId: "b", operation: "upsert", payload: { b: 2 } });
    });
    assert.equal(first.sequence, 1);
    assert.equal(second.sequence, 2);
    assert.deepEqual((await journal.readChangeBatch({ sessionId, afterSequence: 0, limit: 1 })).map((item: any) => item.changeId), ["change-1", "change-2"]);

    await assert.rejects(sql.begin((tx: any) => journal.markAppliedInTransaction(tx, second)), /expected sequence 1/i);
    await sql.begin(async (tx: any) => { assert.deepEqual(await journal.markAppliedInTransaction(tx, first), { duplicate: false, lastSequence: 1 }); });
    await sql.begin(async (tx: any) => { assert.deepEqual(await journal.markAppliedInTransaction(tx, second), { duplicate: false, lastSequence: 2 }); });
    await sql.begin(async (tx: any) => { assert.deepEqual(await journal.markAppliedInTransaction(tx, first), { duplicate: true, lastSequence: 2 }); });
    assert.equal(await journal.getCheckpoint(sessionId), 2);
  } finally {
    if (sql) await sql.unsafe("DELETE FROM provider_migration_sessions WHERE session_id = $1", [sessionId]);
  }
});
