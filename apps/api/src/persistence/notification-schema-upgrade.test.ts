import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runMigrations } from "./migrate.ts";
import { runSqliteMigrations } from "./sqlite.ts";
import { integrityOptions, integrityProviders, notificationIntegrityFixture } from "./test-support/notification-integrity-fixture.ts";

for (const provider of integrityProviders) {
  test(`${provider}: upgrading an occupied pre-integrity schema preserves history and fences contradictory terminal states`, integrityOptions(provider), async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "nw-notification-upgrade-"));
    const source = new URL(provider === "sqlite" ? "./migrations/sqlite/" : "./migrations/", import.meta.url);
    const version = provider === "sqlite" ? "0024_notification_integrity" : "0037_notification_integrity";
    for (const name of await readdir(source)) {
      if (/^\d{4}_.+\.sql$/.test(name) && name < `${version}.sql`) await copyFile(new URL(name, source), join(directory, name));
    }
    const f = await notificationIntegrityFixture(t, provider, { migrationDirectory: directory });
    t.after(() => rm(directory, { recursive: true, force: true }));
    const ids = { pending: randomUUID(), leased: randomUUID(), delivered: randomUUID(), exhausted: randomUUID() };
    const leaseToken = randomUUID();
    for (const [state, attempts, available, delivered, token] of [
      ["pending", 2, "2000-01-01T00:00:00.000Z", null, null],
      ["leased", 3, "2099-01-01T00:00:00.000Z", null, leaseToken],
      ["delivered", 1, "2000-01-01T00:00:00.000Z", "2026-11-12T00:00:00.000Z", null],
      ["exhausted", 8, "2000-01-01T00:00:00.000Z", null, randomUUID()],
    ] as const) {
      await f.query("INSERT INTO outbox_events (id,event_key,event_type,aggregate_id,payload,attempts,available_at,delivered_at,lease_token) VALUES (?,?,?,?,?,?,?,?,?)",
        [ids[state], `upgrade:${state}`, "message.created", state, "{}", attempts, available, delivered, token]);
    }
    const legacy = await f.store.createNotification({ userId: "legacy-author", eventKey: `user.followed:legacy-reader:${randomUUID()}`,
      payload: { type: "user.followed", followerId: "legacy-reader" } });
    await f.store.markNotificationRead({ actorId: "legacy-author", notificationId: legacy.id });
    const history = await f.store.listNotifications({ actorId: "legacy-author", limit: 100 });
    const oldColumns = "id,event_key,event_type,aggregate_id,attempts,available_at,delivered_at,lease_token";
    const before = await f.query(`SELECT ${oldColumns} FROM outbox_events ORDER BY id`);
    if (f.db) assert.deepEqual(await runSqliteMigrations(f.db), [version]);
    else assert.deepEqual((await runMigrations(f.sql!)).applied, [version]);
    assert.deepEqual(await f.query(`SELECT ${oldColumns} FROM outbox_events ORDER BY id`), before);
    assert.deepEqual(await f.store.listNotifications({ actorId: "legacy-author", limit: 100 }), history);
    assert.ok((await f.query("SELECT dead_lettered_at FROM outbox_events")).every(row => row.dead_lettered_at === null));
    for (const id of [ids.leased, ids.delivered]) {
      await assert.rejects(f.query("UPDATE outbox_events SET dead_lettered_at=? WHERE id=?", ["2026-11-12T00:01:00.000Z", id]), /constraint/i);
    }
    const [claimed] = await f.store.claimOutboxEvents();
    assert.equal(claimed.id, ids.pending);
    assert.equal(claimed.attempts, 3);
    assert.ok((await f.query("SELECT dead_lettered_at FROM outbox_events WHERE id=?", [ids.exhausted]))[0].dead_lettered_at);
    assert.equal((await f.query("SELECT lease_token FROM outbox_events WHERE id=?", [ids.leased]))[0].lease_token, leaseToken);
    const [index] = await f.query(f.db
      ? "SELECT sql FROM sqlite_master WHERE type='index' AND name='outbox_pending_idx'"
      : "SELECT indexdef AS sql FROM pg_indexes WHERE schemaname=current_schema() AND indexname='outbox_pending_idx'");
    assert.match(String(index.sql), /dead_lettered_at IS NULL/);
    const indexes = await f.query(f.db
      ? "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('notifications_like_identity_idx','notifications_follow_identity_idx')"
      : "SELECT indexname AS name FROM pg_indexes WHERE schemaname=current_schema() AND indexname IN ('notifications_like_identity_idx','notifications_follow_identity_idx')");
    assert.equal(indexes.length, 2);
    const [deadIndex] = await f.query(f.db
      ? "SELECT sql FROM sqlite_master WHERE type='index' AND name='outbox_dead_letter_idx'"
      : "SELECT indexdef AS sql FROM pg_indexes WHERE schemaname=current_schema() AND indexname='outbox_dead_letter_idx'");
    assert.ok(deadIndex, "dead-letter sampling must have its own partial index instead of scanning all delivered history");
    assert.match(String(deadIndex.sql), /dead_lettered_at IS NOT NULL/);
    assert.equal((await f.store.outboxBacklog()).deadLetterEvents, 1);
    if (f.db) assert.deepEqual(await runSqliteMigrations(f.db), []);
    else assert.deepEqual((await runMigrations(f.sql!)).applied, []);
  });
}
