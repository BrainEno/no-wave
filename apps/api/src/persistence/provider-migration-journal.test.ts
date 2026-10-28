import assert from "node:assert/strict";
import test from "node:test";
import { createSqliteClient, runSqliteMigrations } from "./sqlite.ts";
import { createSqliteProviderMigrationJournal } from "./sqlite-provider-migration-journal.ts";
import { createSqliteArticleStore } from "./sqlite-article-store.ts";
import { createSqliteEngagementStore } from "./sqlite-engagement-store.ts";
import { createSqliteProfileStore } from "./sqlite-profile-store.ts";
import { createSqliteConversationStore } from "./sqlite-conversation-store.ts";
import { createSqliteTaxonomyStore } from "./sqlite-taxonomy-store.ts";
import { createSqliteNotificationStore } from "./sqlite-notification-store.ts";
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


test("SQLite domain writes atomically capture article, engagement, profile, conversation and outbox snapshots", async () => {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  try {
    await runSqliteMigrations(db);
    const journal = createSqliteProviderMigrationJournal(db);
    journal.createSession({ sessionId: "business-capture", sourceProvider: "sqlite", targetProvider: "postgres", schemaVersion: "1" });
    journal.transitionSession({ sessionId: "business-capture", expectedStatus: "prepared", nextStatus: "recording" });

    const articles = createSqliteArticleStore(db);
    const engagement = createSqliteEngagementStore(db);
    const profiles = createSqliteProfileStore(db);
    const conversations = createSqliteConversationStore(db);
    const taxonomies = createSqliteTaxonomyStore(db);
    const notifications = createSqliteNotificationStore(db);
    taxonomies.createTaxonomy({ actorId: "author-1", kind: "category", slug: "capture-category", name: "Capture Category", locale: "en" });
    const article = articles.createArticle({
      authorId: "author-1", slug: "capture-article", title: "Capture Article",
      locale: "en", contentBlocks: [{ id: "p1", type: "paragraph", text: "Capture me" }], publish: true,
    });
    engagement.setArticleLike({ slug: article.slug, locale: "en", actorId: "reader-1", liked: true });
    engagement.createArticleComment({ slug: article.slug, locale: "en", actorId: "reader-1", content: "A captured comment" });
    profiles.upsertAuthorProfile({ userId: "author-1", displayName: "Author", bio: "Profile snapshot", locale: "en" });
    const notice = await notifications.createNotification({ userId: "reader-1", eventKey: "capture-notification-1", payload: { type: "capture.test", label: "journal" } });
    assert.equal(notice.duplicate, false);
    const markedNotice = await notifications.markNotificationRead({ notificationId: notice.id, actorId: "reader-1" });
    assert.ok(markedNotice?.readAt);
    const conversation = await conversations.createConversation({ actorId: "author-1", participantIds: ["reader-1"] });
    const message = await conversations.persistMessage({
      conversationId: conversation.id, senderId: "author-1", body: "Captured message", idempotencyKey: "capture-message-1",
    });
    const beforeDuplicate = db.prepare("SELECT count(*) AS count FROM provider_migration_changes WHERE session_id = ?").get("business-capture").count;
    const duplicate = await conversations.persistMessage({
      conversationId: conversation.id, senderId: "author-1", body: "Captured message", idempotencyKey: "capture-message-1",
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(db.prepare("SELECT count(*) AS count FROM provider_migration_changes WHERE session_id = ?").get("business-capture").count, beforeDuplicate);

    const changes = journal.readChangeBatch({ sessionId: "business-capture", afterSequence: 0, limit: 1000 });
    const entityTypes = new Set(changes.map((change) => change.entityType));
    for (const expected of [
      "articles", "article_translations", "article_likes", "article_comments", "user_profiles",
      "user_profile_translations", "taxonomies", "taxonomy_translations", "notifications",
      "conversations", "conversation_participants", "messages", "outbox_events",
    ]) assert.ok(entityTypes.has(expected), "missing capture for " + expected);

    const messageChange = changes.find((change) => change.entityType === "messages" && change.entityId === message.id);
    const outboxChange = changes.find((change) => change.entityType === "outbox_events" && change.payload?.aggregate_id === message.id);
    assert.ok(messageChange);
    assert.ok(outboxChange);
    assert.equal(messageChange.transactionId, outboxChange.transactionId, "message and outbox events must share the same source transaction envelope");
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK");
    db.close();
  }
});

test("SQLite domain writes roll back when change capture fails", async () => {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  try {
    await runSqliteMigrations(db);
    const journal = createSqliteProviderMigrationJournal(db);
    journal.createSession({ sessionId: "business-capture-failure", sourceProvider: "sqlite", targetProvider: "postgres", schemaVersion: "1" });
    journal.transitionSession({ sessionId: "business-capture-failure", expectedStatus: "prepared", nextStatus: "recording" });
    const articles = createSqliteArticleStore(db);
    db.exec("CREATE TRIGGER fail_provider_capture BEFORE INSERT ON provider_migration_changes BEGIN SELECT RAISE(ABORT, 'capture blocked for test'); END");
    assert.throws(() => articles.createArticle({
      authorId: "author-rollback", slug: "capture-rollback", title: "Must Roll Back",
      locale: "en", contentBlocks: [{ id: "p1", type: "paragraph", text: "Rollback" }], publish: false,
    }), /capture blocked for test/);
    assert.equal(db.prepare("SELECT count(*) AS count FROM articles WHERE slug = ?").get("capture-rollback").count, 0);
    assert.equal(db.prepare("SELECT count(*) AS count FROM provider_migration_changes WHERE session_id = ?").get("business-capture-failure").count, 0);
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK");
    db.close();
  }
});
