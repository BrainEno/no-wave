import assert from "node:assert/strict";
import test from "node:test";
import { createSqliteClient, runSqliteMigrations } from "./sqlite.ts";
import { createSqliteProviderMigrationJournal } from "./sqlite-provider-migration-journal.ts";
import { canonicalJson, validateMigrationChange } from "./provider-migration-journal.ts";

function change(sessionId: string, changeId: string, transactionId: string, entityId: string, body: Record<string, unknown>) {
  return { sessionId, changeId, transactionId, entityType: "test-record", entityId, operation: "upsert" as const, payload: body };
}

test("migration payload hashes use deterministic canonical JSON and reject undefined/non-finite values", () => {
  assert.equal(canonicalJson({ z: 1, a: { y: true, x: null } }), canonicalJson({ a: { x: null, y: true }, z: 1 }));
  assert.equal(validateMigrationChange(change("s", "c", "t", "e", { z: 1, a: 2 })).changeHash,
    validateMigrationChange(change("s", "c", "t", "e", { a: 2, z: 1 })).changeHash);
  assert.throws(() => canonicalJson({ bad: undefined }), /undefined/i);
  assert.throws(() => canonicalJson({ bad: Number.POSITIVE_INFINITY }), /non-finite/i);
});

test("SQLite journal writes roll back with source changes and preserves complete transaction groups", async () => {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  try {
    await runSqliteMigrations(db);
    db.exec("CREATE TABLE journal_test_domain (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const journal = createSqliteProviderMigrationJournal(db);
    journal.createSession({ sessionId: "journal-source", sourceProvider: "sqlite", targetProvider: "postgres", schemaVersion: "1" });
    assert.equal(journal.transitionSession({ sessionId: "journal-source", expectedStatus: "prepared", nextStatus: "recording" }), true);

    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO journal_test_domain (id, value) VALUES (?, ?)").run("rolled-back", "no");
    journal.appendChangeInTransaction(db, change("journal-source", "rolled-back-change", "tx-rollback", "rolled-back", { value: "no" }));
    db.exec("ROLLBACK");
    assert.equal(db.prepare("SELECT count(*) AS count FROM journal_test_domain").get().count, 0);
    assert.equal(db.prepare("SELECT count(*) AS count FROM provider_migration_changes").get().count, 0);
    assert.equal(journal.getSession("journal-source").nextSequence, 1);

    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO journal_test_domain (id, value) VALUES (?, ?)").run("one", "first");
    const first = journal.appendChangeInTransaction(db, change("journal-source", "change-one", "tx-one", "one", { value: "first" }));
    const duplicate = journal.appendChangeInTransaction(db, change("journal-source", "change-one", "tx-one", "one", { value: "first" }));
    assert.equal(duplicate.sequence, first.sequence);
    assert.equal(duplicate.duplicate, true);
    db.prepare("INSERT INTO journal_test_domain (id, value) VALUES (?, ?)").run("two", "second");
    const second = journal.appendChangeInTransaction(db, change("journal-source", "change-two", "tx-one", "two", { value: "second" }));
    db.exec("COMMIT");

    assert.equal(first.sequence, 1);
    assert.equal(second.sequence, 2);
    assert.deepEqual(journal.readChangeBatch({ sessionId: "journal-source", afterSequence: 0, limit: 1 }).map(v => v.changeId), ["change-one", "change-two"]);
    assert.throws(() => {
      db.exec("BEGIN IMMEDIATE");
      try {
        journal.appendChangeInTransaction(db, change("journal-source", "change-one", "tx-other", "one", { value: "different" }));
      } finally { db.exec("ROLLBACK"); }
    }, /different payload/i);
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK");
    db.close();
  }
});

test("SQLite target apply is ordered, idempotent, and checkpoint-atomic", async () => {
  const sourceDb = createSqliteClient({ filename: ":memory:", enableWal: false });
  const targetDb = createSqliteClient({ filename: ":memory:", enableWal: false });
  try {
    await runSqliteMigrations(sourceDb);
    await runSqliteMigrations(targetDb);
    const source = createSqliteProviderMigrationJournal(sourceDb);
    const target = createSqliteProviderMigrationJournal(targetDb);
    const session = { sessionId: "journal-replay", sourceProvider: "sqlite" as const, targetProvider: "postgres" as const, schemaVersion: "1" };
    source.createSession(session);
    target.createSession(session);
    source.transitionSession({ sessionId: session.sessionId, expectedStatus: "prepared", nextStatus: "recording" });
    target.transitionSession({ sessionId: session.sessionId, expectedStatus: "prepared", nextStatus: "recording" });
    sourceDb.exec("BEGIN IMMEDIATE");
    const one = source.appendChangeInTransaction(sourceDb, change(session.sessionId, "replay-one", "replay-tx-1", "one", { value: 1 }));
    sourceDb.exec("COMMIT");
    sourceDb.exec("BEGIN IMMEDIATE");
    const two = source.appendChangeInTransaction(sourceDb, change(session.sessionId, "replay-two", "replay-tx-2", "two", { value: 2 }));
    sourceDb.exec("COMMIT");

    targetDb.exec("BEGIN IMMEDIATE");
    assert.throws(() => target.markAppliedInTransaction(targetDb, two), /expected sequence 1/i);
    targetDb.exec("ROLLBACK");
    assert.equal(target.getCheckpoint(session.sessionId), 0);

    targetDb.exec("BEGIN IMMEDIATE");
    assert.deepEqual(target.markAppliedInTransaction(targetDb, one), { duplicate: false, lastSequence: 1 });
    targetDb.exec("COMMIT");
    targetDb.exec("BEGIN IMMEDIATE");
    assert.deepEqual(target.markAppliedInTransaction(targetDb, two), { duplicate: false, lastSequence: 2 });
    targetDb.exec("COMMIT");
    targetDb.exec("BEGIN IMMEDIATE");
    assert.deepEqual(target.markAppliedInTransaction(targetDb, one), { duplicate: true, lastSequence: 2 });
    targetDb.exec("ROLLBACK");
    assert.equal(target.getCheckpoint(session.sessionId), 2);
  } finally {
    if (sourceDb.isTransaction) sourceDb.exec("ROLLBACK");
    if (targetDb.isTransaction) targetDb.exec("ROLLBACK");
    sourceDb.close();
    targetDb.close();
  }
});

test("migration sessions reject invalid state transitions and immutable-setting conflicts", async () => {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  try {
    await runSqliteMigrations(db);
    const journal = createSqliteProviderMigrationJournal(db);
    journal.createSession({ sessionId: "journal-state", sourceProvider: "sqlite", targetProvider: "postgres", schemaVersion: "v1" });
    assert.throws(() => journal.createSession({ sessionId: "journal-state", sourceProvider: "sqlite", targetProvider: "mongodb", schemaVersion: "v1" }), /different provider/i);
    assert.throws(() => journal.transitionSession({ sessionId: "journal-state", expectedStatus: "prepared", nextStatus: "stopped" }), /cannot transition/i);
    assert.equal(journal.transitionSession({ sessionId: "journal-state", expectedStatus: "prepared", nextStatus: "recording" }), true);
    assert.equal(journal.transitionSession({ sessionId: "journal-state", expectedStatus: "prepared", nextStatus: "recording" }), true);
    assert.equal(journal.transitionSession({ sessionId: "journal-state", expectedStatus: "recording", nextStatus: "aborted" }), true);
    assert.throws(() => journal.transitionSession({ sessionId: "journal-state", expectedStatus: "aborted", nextStatus: "recording" }), /cannot transition/i);
  } finally { db.close(); }
});
