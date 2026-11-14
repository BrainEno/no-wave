import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { createPostgresProviderMigrationJournal } from "./postgres-provider-migration-journal.ts";
import { createPostgresProviderMigrationReplayer } from "./postgres-provider-migration-replayer.ts";
import { createSqliteProviderMigrationJournal } from "./sqlite-provider-migration-journal.ts";
import { createSqliteProviderMigrationReplayer } from "./sqlite-provider-migration-replayer.ts";
import { assertMigrationReplaySchema, MIGRATION_REPLAY_SCHEMA_VERSION, MigrationJournalError } from "./provider-migration-journal.ts";
import { prepareMigrationReplayTarget, replayNextMigrationBatch } from "./provider-migration-replay.ts";
import { prepareMigrationRowPayload } from "./provider-migration-row-applier.ts";
import { transferProviderData } from "./provider-migration-transfer.ts";
import { integrityOptions, integrityProviders, notificationIntegrityFixture, type IntegrityProvider } from "./test-support/notification-integrity-fixture.ts";

const crossProvider = { skip: !process.env.TEST_DATABASE_URL && "Set TEST_DATABASE_URL for real notification migration contracts." };
async function replayFixture(t: TestContext, provider: IntegrityProvider) {
  const source = await notificationIntegrityFixture(t, provider);
  const targetProvider = provider === "sqlite" ? "postgres" : "sqlite";
  const target = await notificationIntegrityFixture(t, targetProvider);
  const journal = source.db ? createSqliteProviderMigrationJournal(source.db) : createPostgresProviderMigrationJournal(source.sql!);
  const replayer = target.db ? createSqliteProviderMigrationReplayer(target.db) : createPostgresProviderMigrationReplayer(target.sql!);
  const sessionId = randomUUID();
  await journal.createSession({ sessionId, sourceProvider: provider, targetProvider, schemaVersion: MIGRATION_REPLAY_SCHEMA_VERSION });
  await journal.transitionSession({ sessionId, expectedStatus: "prepared", nextStatus: "recording" });
  await prepareMigrationReplayTarget({ sourceJournal: journal, targetJournal: replayer, sessionId, targetProvider });
  async function drain() {
    let remaining: number;
    do {
      const result = await replayNextMigrationBatch({ sourceJournal: journal, target: replayer, sessionId, limit: 1 });
      remaining = result.remainingAtRead;
    } while (remaining > 0);
  }
  async function captured(afterSequence: number) {
    return journal.readChangeBatch({ sessionId, afterSequence, limit: 100 });
  }
  return { source, target, journal, replayer, sessionId, drain, captured };
}

for (const provider of integrityProviders) {
  test(`${provider}: replay carries retries, quarantine, and crash recovery without resurrecting a dead event`, crossProvider, async (t) => {
    const f = await replayFixture(t, provider);
    const poison = await f.source.enqueue("retry-then-dead");
    const [first] = await f.source.store.claimOutboxEvents({ maxAttempts: 2 });
    await f.source.store.rescheduleOutboxEvent({ eventId: poison.eventId, leaseToken: first.lease_token, delaySeconds: 120, maxAttempts: 2 });
    await f.drain();
    assert.equal((await f.target.store.outboxBacklog()).pendingEvents, 1);
    assert.deepEqual(await f.target.store.claimOutboxEvents(), []);
    await f.source.expire(poison.eventId);
    const [second] = await f.source.store.claimOutboxEvents({ maxAttempts: 2 });
    await f.source.store.rescheduleOutboxEvent({ eventId: poison.eventId, leaseToken: second.lease_token, maxAttempts: 2 });
    await f.drain();
    const columns = "id,attempts,available_at,dead_lettered_at,delivered_at,lease_token";
    assert.deepEqual(await f.target.query(`SELECT ${columns} FROM outbox_events`), await f.source.query(`SELECT ${columns} FROM outbox_events`));
    assert.deepEqual(await f.target.store.outboxBacklog(), { pendingEvents: 0, deadLetterEvents: 1, oldestPendingAgeMs: 0 });
    assert.deepEqual(await f.target.store.claimOutboxEvents({ maxAttempts: 100 }), []);
    const crashed = await f.source.enqueue("abandoned-attempt");
    await f.source.store.claimOutboxEvents({ maxAttempts: 1 });
    await f.source.expire(crashed.eventId);
    assert.deepEqual(await f.source.store.claimOutboxEvents({ maxAttempts: 1 }), []);
    await f.drain();
    assert.deepEqual(await f.target.store.outboxBacklog(), { pendingEvents: 0, deadLetterEvents: 2, oldestPendingAgeMs: 0 });
    const batch = await f.captured(0);
    const terminalChanges = batch.filter(change => change.entityType === "outbox_events" && change.payload?.dead_lettered_at);
    assert.equal(terminalChanges.length, 2, "both failure and crash quarantine are journaled");
    assert.ok(terminalChanges.every(change => change.payload!.lease_token === null));
  });

  test(`${provider}: duplicate engagement does not append fictitious notification captures or reset target unread state`, crossProvider, async (t) => {
    const f = await replayFixture(t, provider);
    const article = await f.source.work();
    await f.source.profile(article.authorId);
    const like = { slug: article.slug, locale: "en", actorId: "replayed-reader" };
    const follow = { actorId: like.actorId, targetUserId: article.authorId };
    await f.source.store.setArticleLike({ ...like, liked: true });
    await f.source.store.followUser(follow);
    await f.source.store.markAllNotificationsRead({ actorId: article.authorId });
    await f.drain();
    const history = await f.target.store.listNotifications({ actorId: article.authorId, limit: 100 });
    assert.equal(history.length, 2);
    assert.ok(history.every(row => row.readAt));
    const start = (await f.journal.getSession(f.sessionId)).nextSequence - 1;
    await f.source.store.toggleArticleLike(like);
    await f.source.store.toggleArticleLike(like);
    await f.source.store.unfollowUser(follow);
    await f.source.store.followUser(follow);
    const captured = await f.captured(start);
    assert.ok(captured.some(change => change.entityType === "article_likes"));
    assert.ok(captured.some(change => change.entityType === "user_follows"));
    assert.ok(captured.every(change => change.entityType !== "notifications"), "an existing notification is not a new write");
    await f.drain();
    assert.deepEqual(await f.target.store.listNotifications({ actorId: article.authorId, limit: 100 }), history);
    assert.equal(await f.target.store.getUnreadNotificationCount({ actorId: article.authorId }), 0);
  });

  test(`${provider}: failed journal capture rolls back both quarantine and normal claims in the same transaction`, integrityOptions(provider), async (t) => {
    const source = await notificationIntegrityFixture(t, provider);
    const journal = source.db ? createSqliteProviderMigrationJournal(source.db) : createPostgresProviderMigrationJournal(source.sql!);
    const sessionId = randomUUID();
    await journal.createSession({ sessionId, sourceProvider: provider, targetProvider: provider === "sqlite" ? "postgres" : "sqlite", schemaVersion: MIGRATION_REPLAY_SCHEMA_VERSION });
    await journal.transitionSession({ sessionId, expectedStatus: "prepared", nextStatus: "recording" });
    const poison = await source.enqueue("capture-rollback");
    const [lease] = await source.store.claimOutboxEvents({ maxAttempts: 1 });
    const healthy = await source.enqueue("claim-capture-rollback");
    const sequence = (await journal.getSession(sessionId)).nextSequence;
    if (source.db) {
      source.db.exec("CREATE TRIGGER fail_outbox_capture BEFORE INSERT ON provider_migration_changes WHEN NEW.entity_type='outbox_events' BEGIN SELECT RAISE(ABORT,'outbox capture blocked'); END");
    } else {
      await source.sql!.unsafe("CREATE FUNCTION fail_outbox_capture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity_type='outbox_events' THEN RAISE EXCEPTION 'outbox capture blocked'; END IF; RETURN NEW; END $$");
      await source.sql!.unsafe("CREATE TRIGGER fail_outbox_capture BEFORE INSERT ON provider_migration_changes FOR EACH ROW EXECUTE FUNCTION fail_outbox_capture()");
    }
    const before = await source.query("SELECT * FROM outbox_events");
    await assert.rejects(source.store.rescheduleOutboxEvent({ eventId: poison.eventId, leaseToken: lease.lease_token, maxAttempts: 1 }), /outbox capture blocked/);
    assert.deepEqual(await source.query("SELECT * FROM outbox_events"), before);
    await source.expire(poison.eventId);
    const expired = await source.query("SELECT * FROM outbox_events");
    await assert.rejects(source.store.claimOutboxEvents({ maxAttempts: 1 }), /outbox capture blocked/);
    assert.deepEqual(await source.query("SELECT * FROM outbox_events"), expired);
    assert.equal((await journal.getSession(sessionId)).nextSequence, sequence);
    if (source.db) source.db.exec("DROP TRIGGER fail_outbox_capture");
    else await source.sql!.unsafe("DROP TRIGGER fail_outbox_capture ON provider_migration_changes");
    const [claimed] = await source.store.claimOutboxEvents({ maxAttempts: 1 });
    assert.equal(claimed.id, healthy.eventId);
    assert.equal((await source.store.outboxBacklog()).deadLetterEvents, 1);
    assert.equal((await journal.getSession(sessionId)).nextSequence, sequence + 2);
    const changes = await journal.readChangeBatch({ sessionId, afterSequence: sequence - 1, limit: 100 });
    assert.equal(changes.length, 2);
    assert.equal(new Set(changes.map(change => change.transactionId)).size, 1, "quarantine and ordinary claim share one capture transaction");
  });
}

for (const [sourceProvider, targetProvider] of [["sqlite", "sqlite"], ["sqlite", "postgres"], ["postgres", "sqlite"]] as const) {
  test(`${sourceProvider} → ${targetProvider}: offline copy reconciles dead, delayed and delivered outbox states`, sourceProvider === "postgres" || targetProvider === "postgres" ? crossProvider : {}, async (t) => {
    const source = await notificationIntegrityFixture(t, sourceProvider), target = await notificationIntegrityFixture(t, targetProvider);
    const dead = await source.enqueue("copy-dead");
    const [terminal] = await source.store.claimOutboxEvents();
    await source.store.rescheduleOutboxEvent({ eventId: dead.eventId, leaseToken: terminal.lease_token, maxAttempts: 1 });
    const pending = await source.enqueue("copy-delayed");
    const [retry] = await source.store.claimOutboxEvents();
    await source.store.rescheduleOutboxEvent({ eventId: pending.eventId, leaseToken: retry.lease_token, delaySeconds: 3600 });
    const delivered = await source.enqueue("copy-delivered");
    const [done] = await source.store.claimOutboxEvents();
    await source.store.markOutboxDelivered({ eventId: delivered.eventId, leaseToken: done.lease_token });
    const report = await transferProviderData({ source: source.endpoint, target: target.endpoint });
    assert.equal(report.ok, true);
    assert.equal(report.applied, true);
    assert.ok(report.tables.every(table => table.matched));
    assert.equal(report.tables.find(table => table.table === "outbox_events")!.sourceRows, 3);
    const select = "SELECT id,attempts,available_at,dead_lettered_at,delivered_at,lease_token FROM outbox_events ORDER BY id";
    assert.deepEqual(await target.query(select), await source.query(select));
    const backlog = await target.store.outboxBacklog();
    assert.equal(backlog.pendingEvents, 1);
    assert.equal(backlog.deadLetterEvents, 1);
    assert.deepEqual(await target.store.claimOutboxEvents(), []);
    await target.expire(pending.eventId);
    const [next] = await target.store.claimOutboxEvents();
    assert.equal(next.id, pending.eventId);
    assert.equal(next.attempts, 2);
    assert.equal(await target.store.markOutboxDelivered({ eventId: next.id, leaseToken: next.lease_token }), true);
    assert.deepEqual(await target.store.outboxBacklog(), { pendingEvents: 0, deadLetterEvents: 1, oldestPendingAgeMs: 0 });
  });
}

test("portable outbox rows require explicit terminal state and reject pre-integrity replay versions", () => {
  const id = randomUUID();
  const row = { id, event_key: "message:portable", event_type: "message.created", aggregate_id: "message", payload: {}, attempts: 8,
    available_at: "2026-11-12T00:00:00.000Z", created_at: "2026-11-12T00:00:00.000Z", delivered_at: null, lease_token: null };
  for (const targetProvider of integrityProviders) {
    assert.throws(() => prepareMigrationRowPayload(targetProvider, "outbox_events", id, row), (error: unknown) => error instanceof MigrationJournalError && error.code === "INCOMPATIBLE_SCHEMA");
    const terminal = { ...row, dead_lettered_at: "2026-11-12T00:01:00.000Z" };
    const prepared = prepareMigrationRowPayload(targetProvider, "outbox_events", id, terminal);
    assert.equal(prepared.payload.dead_lettered_at, terminal.dead_lettered_at);
    assert.equal(prepareMigrationRowPayload(targetProvider, "outbox_events", id, { ...row, dead_lettered_at: null }).payload.dead_lettered_at, null);
    assert.throws(() => prepareMigrationRowPayload(targetProvider, "outbox_events", id, { ...row, dead_lettered_at: "yesterday" }), /timezone-qualified timestamp/);
  }
  assert.equal(MIGRATION_REPLAY_SCHEMA_VERSION, "notification-integrity-v3");
  assert.throws(() => assertMigrationReplaySchema("media-identity-snapshots-v2"), (error: unknown) => error instanceof MigrationJournalError && error.code === "INCOMPATIBLE_SCHEMA");
  assert.doesNotThrow(() => assertMigrationReplaySchema(MIGRATION_REPLAY_SCHEMA_VERSION));
});
