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
import { createSqliteIdentityStore } from "./sqlite-identity-store.ts";
import { createSqliteOutboxStore } from "./sqlite-outbox-store.ts";
import { createSqliteProviderMigrationReplayer } from "./sqlite-provider-migration-replayer.ts";
import { prepareMigrationReplayTarget, replayNextMigrationBatch } from "./provider-migration-replay.ts";
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
    const identities = createSqliteIdentityStore(db);
    const outbox = createSqliteOutboxStore(db);
    taxonomies.createTaxonomy({ actorId: "author-1", kind: "category", slug: "capture-category", name: "Capture Category", locale: "en" });
    await identities.createIdentityAccount({
      userId: "identity-capture-user", email: "identity-capture@example.test", passwordHash: "test-password-hash",
      session: {
        sessionId: "identity-capture-session", accessTokenId: "identity-capture-access",
        refreshHash: "a".repeat(64), expiresAt: new Date(Date.now() + 3600000).toISOString(),
        accessExpiresAt: new Date(Date.now() + 1800000).toISOString(),
      },
    });
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
    const claimed = await outbox.claimOutboxEvents({ limit: 10, leaseSeconds: 60 });
    assert.equal(claimed.length, 1);
    assert.equal(await outbox.markOutboxDelivered({ eventId: claimed[0].id, leaseToken: claimed[0].lease_token }), true);
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
      "auth_accounts", "auth_sessions", "auth_access_tokens", "auth_refresh_tokens",
      "conversations", "conversation_participants", "messages", "outbox_events",
    ]) assert.ok(entityTypes.has(expected), "missing capture for " + expected);

    const messageChange = changes.find((change) => change.entityType === "messages" && change.entityId === message.id);
    const outboxChange = changes.find((change) => change.entityType === "outbox_events" && change.payload?.aggregate_id === message.id);
    assert.ok(messageChange);
    assert.ok(outboxChange);
    assert.equal(messageChange.transactionId, outboxChange.transactionId, "message and outbox events must share the same source transaction envelope");
    const outboxStateChanges = changes.filter((change) => change.entityType === "outbox_events" && change.entityId === claimed[0].id);
    assert.ok(outboxStateChanges.length >= 3, "message creation, lease claim and delivery must all be captured");
    assert.ok(outboxStateChanges.some((change) => change.payload?.attempts === 1));
    assert.ok(outboxStateChanges.some((change) => change.payload?.delivered_at != null));
    assert.ok(changes.some((change) => change.entityType === "auth_accounts" && change.entityId === "identity-capture-user"));
    assert.ok(changes.some((change) => change.entityType === "auth_refresh_tokens" && change.entityId === "a".repeat(64)));
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


test("SQLite migration replayer applies source transactions atomically, resumes, normalizes JSON and honors tombstones", async () => {
  const sourceDb = createSqliteClient({ filename: ":memory:", enableWal: false });
  const targetDb = createSqliteClient({ filename: ":memory:", enableWal: false });
  try {
    await runSqliteMigrations(sourceDb);
    await runSqliteMigrations(targetDb);
    const sourceJournal = createSqliteProviderMigrationJournal(sourceDb);
    const target = createSqliteProviderMigrationReplayer(targetDb);
    const sessionId = "sqlite-replay-transactional";
    sourceJournal.createSession({ sessionId, sourceProvider: "postgres", targetProvider: "sqlite", schemaVersion: "replay-v1" });
    sourceJournal.transitionSession({ sessionId, expectedStatus: "prepared", nextStatus: "recording" });
    await prepareMigrationReplayTarget({ sourceJournal, targetJournal: target, sessionId, targetProvider: "sqlite" });

    const append = (changeId: string, transactionId: string, entityType: string, entityId: string, operation: "upsert" | "delete", payload: Record<string, unknown> | null) => {
      sourceDb.exec("BEGIN IMMEDIATE");
      try {
        const result = sourceJournal.appendChangeInTransaction(sourceDb, {
          sessionId, changeId, transactionId, entityType, entityId, operation, payload,
        });
        sourceDb.exec("COMMIT");
        return result;
      } catch (error) {
        try { sourceDb.exec("ROLLBACK"); } catch {}
        throw error;
      }
    };

    append("article-upsert", "source-tx-article", "articles", "article-replay-1", "upsert", {
      id: "article-replay-1", author_id: "writer-1", slug: "replay-article", status: "draft",
      work_type: "essay", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", published_at: null,
    });
    append("translation-upsert", "source-tx-article", "article_translations", JSON.stringify(["article-replay-1", "en"]), "upsert", {
      article_id: "article-replay-1", locale: "en", title: "Replayable", summary: "Atomic row group",
      content_blocks: JSON.stringify([{ id: "block-1", type: "paragraph", text: "replayed" }]),
      content_blocks_version: 0, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    });
    append("notification-upsert", "source-tx-notification", "notifications", "notification-replay-1", "upsert", {
      id: "notification-replay-1", user_id: "reader-1", event_key: "replay-event-1",
      payload: JSON.stringify({ type: "replay.test", nested: { ok: true } }), payload_hash: "a".repeat(64),
      created_at: "2026-01-01T00:00:00.000Z", read_at: null,
    });
    append("outbox-upsert", "source-tx-outbox", "outbox_events", "outbox-replay-1", "upsert", {
      id: "outbox-replay-1", event_key: "replay-outbox-1", event_type: "replay.test",
      aggregate_id: "article-replay-1", payload: JSON.stringify({ operation: "replay", nested: [1, 2] }),
      attempts: 0, available_at: "2026-01-01T00:00:00.000Z", created_at: "2026-01-01T00:00:00.000Z",
      delivered_at: null, lease_token: null,
    });
    append("notification-delete", "source-tx-delete", "notifications", "notification-replay-1", "delete", null);

    const sourceChanges = sourceJournal.readChangeBatch({ sessionId, afterSequence: 0, limit: 100 });
    assert.equal(sourceChanges.length, 5);
    assert.equal(sourceJournal.transitionSession({ sessionId, expectedStatus: "recording", nextStatus: "catching_up" }), true);
    assert.equal(sourceJournal.transitionSession({ sessionId, expectedStatus: "catching_up", nextStatus: "stopped" }), true);

    assert.throws(() => target.applyTransaction([sourceChanges[1]]), /expected sequence 1/i);
    assert.equal(await target.getCheckpoint(sessionId), 0);

    targetDb.exec("CREATE TRIGGER block_replay_translation BEFORE INSERT ON article_translations BEGIN SELECT RAISE(ABORT, 'target apply failure'); END");
    await assert.rejects(
      replayNextMigrationBatch({ sourceJournal, target, sessionId, limit: 1 }),
      /target apply failure/i,
    );
    assert.equal(await target.getCheckpoint(sessionId), 0, "failed transaction must not advance the checkpoint");
    assert.equal(targetDb.prepare("SELECT count(*) AS count FROM articles WHERE id = ?").get("article-replay-1").count, 0, "parent insert must roll back with the failed child insert");
    assert.equal(targetDb.prepare("SELECT count(*) AS count FROM provider_migration_applied_changes WHERE session_id = ?").get(sessionId).count, 0);

    targetDb.exec("DROP TRIGGER block_replay_translation");
    const first = await replayNextMigrationBatch({ sourceJournal, target, sessionId, limit: 1 });
    assert.deepEqual({ appliedChanges: first.appliedChanges, transactions: first.transactions, lastSequence: first.lastSequence }, {
      appliedChanges: 2, transactions: 1, lastSequence: 2,
    });
    const translation = targetDb.prepare("SELECT content_blocks FROM article_translations WHERE article_id = ? AND locale = ?").get("article-replay-1", "en");
    assert.deepEqual(JSON.parse(translation.content_blocks), [{ id: "block-1", type: "paragraph", text: "replayed" }]);

    const second = await replayNextMigrationBatch({ sourceJournal, target, sessionId, limit: 1 });
    assert.equal(second.lastSequence, 3);
    const notificationPayload = targetDb.prepare("SELECT payload FROM notifications WHERE id = ?").get("notification-replay-1");
    assert.deepEqual(JSON.parse(notificationPayload.payload), { type: "replay.test", nested: { ok: true } });

    const third = await replayNextMigrationBatch({ sourceJournal, target, sessionId, limit: 1 });
    assert.equal(third.lastSequence, 4);
    const fourth = await replayNextMigrationBatch({ sourceJournal, target, sessionId, limit: 1 });
    assert.equal(fourth.lastSequence, 5);
    assert.equal(targetDb.prepare("SELECT count(*) AS count FROM notifications WHERE id = ?").get("notification-replay-1").count, 0, "delete tombstone must remove the target row");
    const outboxPayload = targetDb.prepare("SELECT payload FROM outbox_events WHERE id = ?").get("outbox-replay-1");
    assert.deepEqual(JSON.parse(outboxPayload.payload), { operation: "replay", nested: [1, 2] });

    await target.applyTransaction(sourceChanges.slice(0, 2));
    assert.equal(await target.getCheckpoint(sessionId), 5, "replaying an already-applied transaction must be idempotent");
    const done = await replayNextMigrationBatch({ sourceJournal, target, sessionId });
    assert.deepEqual({ appliedChanges: done.appliedChanges, lastSequence: done.lastSequence }, { appliedChanges: 0, lastSequence: 5 });
  } finally {
    if (sourceDb.isTransaction) sourceDb.exec("ROLLBACK");
    if (targetDb.isTransaction) targetDb.exec("ROLLBACK");
    sourceDb.close();
    targetDb.close();
  }
});
