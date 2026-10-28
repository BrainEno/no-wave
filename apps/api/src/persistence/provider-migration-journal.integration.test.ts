import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { createPostgresClient, createPostgresStore } from "./postgres.ts";
import { createPostgresIdentityStore } from "./postgres-identity-store.ts";
import { createPostgresProviderMigrationReplayer } from "./postgres-provider-migration-replayer.ts";
import { prepareMigrationReplayTarget, replayNextMigrationBatch } from "./provider-migration-replay.ts";
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


test("PostgreSQL domain writes capture profile, taxonomy-independent notification and read-state updates", options, async () => {
  const suffix = randomUUID();
  const sessionId = "business-capture-" + suffix;
  const userId = "migration-user-" + suffix;
  const notificationEventKey = "migration-notification-" + suffix;
  const identitySessionId = randomUUID();
  const initialAccessTokenId = randomUUID();
  const nextAccessTokenId = randomUUID();
  const initialRefreshHash = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
  const nextRefreshHash = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
  const outboxEventId = randomUUID();
  const outboxEventKey = "migration-outbox-" + suffix;
  const outboxAggregateId = "migration-aggregate-" + suffix;
  const journal = createPostgresProviderMigrationJournal(sql);
  const store = createPostgresStore(sql);
  const identity = createPostgresIdentityStore(sql);
  try {
    await journal.createSession({ sessionId, sourceProvider: "postgres", targetProvider: "sqlite", schemaVersion: "integration-v1" });
    await journal.transitionSession({ sessionId, expectedStatus: "prepared", nextStatus: "recording" });

    await store.upsertAuthorProfile({ userId, displayName: "Migration Capture", bio: "profile snapshot", locale: "en" });
    const notification = await store.createNotification({
      userId, eventKey: notificationEventKey, payload: { type: "capture.test", source: "postgres-integration" },
    });
    assert.equal(notification.duplicate, false);
    const marked = await store.markNotificationRead({ notificationId: notification.id, actorId: userId });
    assert.ok(marked?.readAt);

    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    assert.equal(await identity.createIdentityAccount({
      userId, email: userId + "@example.test", passwordHash: "test-password-hash",
      session: {
        sessionId: identitySessionId, userId, accessTokenId: initialAccessTokenId,
        refreshHash: initialRefreshHash, expiresAt, accessExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
      },
    }), true);
    const rotated = await identity.rotateIdentityRefresh({
      refreshHash: initialRefreshHash, nextRefreshHash, accessTokenId: nextAccessTokenId,
      issuedAt: new Date().toISOString(), accessExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });
    assert.equal(rotated.status, "rotated");

    await sql.unsafe(
      "INSERT INTO outbox_events (id, event_key, event_type, aggregate_id, payload, created_at, available_at) VALUES ($1, $2, $3, $4, $5::jsonb, '2000-01-01T00:00:00Z', clock_timestamp())",
      [outboxEventId, outboxEventKey, "migration.capture.test", outboxAggregateId, { type: "migration.capture.test", source: "integration" }],
    );
    const claimed = await store.claimOutboxEvents({ limit: 1, leaseSeconds: 120 });
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].id, outboxEventId);
    assert.equal(await store.markOutboxDelivered({ eventId: outboxEventId, leaseToken: claimed[0].lease_token }), true);

    const changes = await journal.readChangeBatch({ sessionId, afterSequence: 0, limit: 200 });
    const entityTypes = new Set(changes.map((change: any) => change.entityType));
    assert.ok(entityTypes.has("user_profiles"));
    assert.ok(entityTypes.has("user_profile_translations"));
    assert.ok(entityTypes.has("notifications"));
    assert.ok(entityTypes.has("auth_accounts"));
    assert.ok(entityTypes.has("auth_sessions"));
    assert.ok(entityTypes.has("auth_access_tokens"));
    assert.ok(entityTypes.has("auth_refresh_tokens"));
    assert.ok(entityTypes.has("outbox_events"));

    const profileChange = changes.find((change: any) => change.entityType === "user_profiles" && change.entityId === userId);
    const translationChange = changes.find((change: any) => change.entityType === "user_profile_translations" && change.entityId === JSON.stringify([userId, "en"]));
    assert.ok(profileChange);
    assert.ok(translationChange);
    assert.equal(profileChange.transactionId, translationChange.transactionId);

    const notificationChanges = changes.filter((change: any) => change.entityType === "notifications" && change.entityId === notification.id);
    assert.equal(notificationChanges.length, 2, "creation and read state must each be captured");
    assert.notEqual(notificationChanges[0].transactionId, notificationChanges[1].transactionId);

    assert.ok(changes.some((change: any) => change.entityType === "auth_accounts" && change.entityId === userId));
    assert.ok(changes.some((change: any) => change.entityType === "auth_sessions" && change.entityId === identitySessionId));
    assert.ok(changes.some((change: any) => change.entityType === "auth_refresh_tokens" && change.entityId === initialRefreshHash));
    assert.ok(changes.some((change: any) => change.entityType === "auth_refresh_tokens" && change.entityId === nextRefreshHash));
    const outboxChanges = changes.filter((change: any) => change.entityType === "outbox_events" && change.entityId === outboxEventId);
    assert.equal(outboxChanges.length, 2, "claim and delivered transitions must each be captured");
    assert.ok(outboxChanges[0].payload.attempts === 1);
    assert.ok(outboxChanges[0].payload.lease_token);
    assert.ok(outboxChanges[1].payload.delivered_at);
  } finally {
    if (sql) {
      await sql.unsafe("DELETE FROM outbox_events WHERE id = $1", [outboxEventId]);
      await sql.unsafe("DELETE FROM notifications WHERE user_id = $1", [userId]);
      await sql.unsafe("DELETE FROM auth_sessions WHERE id = $1", [identitySessionId]);
      await sql.unsafe("DELETE FROM auth_accounts WHERE user_id = $1", [userId]);
      await sql.unsafe("DELETE FROM user_profiles WHERE user_id = $1", [userId]);
      await sql.unsafe("DELETE FROM provider_migration_sessions WHERE session_id = $1", [sessionId]);
    }
  }
});


test("PostgreSQL migration replayer applies JSON snapshots and tombstones with a durable resumable checkpoint", options, async () => {
  const suffix = randomUUID();
  const sessionId = "replay-postgres-" + suffix;
  const notificationId = randomUUID();
  const userId = "replay-user-" + suffix;
  const eventKey = "replay-event-" + suffix;
  const journal = createPostgresProviderMigrationJournal(sql);
  const target = createPostgresProviderMigrationReplayer(sql);
  try {
    await journal.createSession({ sessionId, sourceProvider: "sqlite", targetProvider: "postgres", schemaVersion: "replay-integration-v1" });
    await journal.transitionSession({ sessionId, expectedStatus: "prepared", nextStatus: "recording" });
    await prepareMigrationReplayTarget({ sourceJournal: journal, targetJournal: target, sessionId, targetProvider: "postgres" });

    await sql.begin(async (tx: any) => {
      await journal.appendChangeInTransaction(tx, {
        sessionId, changeId: "notification-upsert-" + suffix, transactionId: "notification-upsert-tx-" + suffix,
        entityType: "notifications", entityId: notificationId, operation: "upsert",
        payload: {
          id: notificationId, user_id: userId, event_key: eventKey,
          payload: JSON.stringify({ type: "replay.integration", nested: { valid: true } }),
          payload_hash: "b".repeat(64), created_at: new Date().toISOString(), read_at: null,
        },
      });
    });
    await sql.begin(async (tx: any) => {
      await journal.appendChangeInTransaction(tx, {
        sessionId, changeId: "notification-delete-" + suffix, transactionId: "notification-delete-tx-" + suffix,
        entityType: "notifications", entityId: notificationId, operation: "delete", payload: null,
      });
    });

    const changes = await journal.readChangeBatch({ sessionId, afterSequence: 0, limit: 10 });
    assert.equal(changes.length, 2);
    await assert.rejects(target.applyTransaction([changes[1]]), /expected sequence 1/i);
    assert.equal(await target.getCheckpoint(sessionId), 0);

    const first = await replayNextMigrationBatch({ sourceJournal: journal, target, sessionId, limit: 1 });
    assert.equal(first.lastSequence, 1);
    const rows = await sql.unsafe("SELECT payload FROM notifications WHERE id = $1", [notificationId]);
    assert.deepEqual(rows[0].payload, { type: "replay.integration", nested: { valid: true } });

    const second = await replayNextMigrationBatch({ sourceJournal: journal, target, sessionId, limit: 1 });
    assert.equal(second.lastSequence, 2);
    assert.equal((await sql.unsafe("SELECT id FROM notifications WHERE id = $1", [notificationId])).length, 0);

    await target.applyTransaction([changes[0]]);
    assert.equal(await target.getCheckpoint(sessionId), 2, "duplicate replay must not rewind the checkpoint or recreate a tombstoned row");
    assert.equal((await sql.unsafe("SELECT id FROM notifications WHERE id = $1", [notificationId])).length, 0);
    const done = await replayNextMigrationBatch({ sourceJournal: journal, target, sessionId });
    assert.equal(done.appliedChanges, 0);
  } finally {
    if (sql) {
      await sql.unsafe("DELETE FROM notifications WHERE id = $1", [notificationId]);
      await sql.unsafe("DELETE FROM provider_migration_sessions WHERE session_id = $1", [sessionId]);
    }
  }
});
