import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { dispatchOutboxBatch, type OutboxDeliveryFailure } from "./outbox-worker.ts";
import { createMessageNotificationDelivery } from "./message-notification-delivery.ts";
import { createOutboxMetrics } from "./outbox-metrics.ts";
import { runOutboxDrain } from "./outbox-drain.ts";
import { integrityOptions, integrityProviders, notificationIntegrityFixture } from "./test-support/notification-integrity-fixture.ts";

for (const provider of integrityProviders) {
  test(`${provider}: failures back off exponentially, cap the delay and become durable dead letters`, integrityOptions(provider), async (t) => {
    const f = await notificationIntegrityFixture(t, provider);
    const { eventId } = await f.enqueue("poison");
    const failures: OutboxDeliveryFailure[] = [];
    const deliver = async () => { throw new Error("private message body and credential must not escape"); };
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const before = Date.now();
      const result = await dispatchOutboxBatch({
        store: f.store, deliver, limit: 1, retryDelaySeconds: 10, maxRetryDelaySeconds: 25, maxAttempts: 5,
        onDeliveryFailure: failure => { failures.push(failure); },
      });
      assert.deepEqual(result, { claimed: 1, delivered: 0, failed: 1, deadLettered: attempt === 5 ? 1 : 0 });
      const [row] = await f.query("SELECT * FROM outbox_events WHERE id = ?", [eventId]);
      assert.equal(row.attempts, attempt);
      assert.equal(row.lease_token, null);
      assert.equal(row.delivered_at, null);
      assert.deepEqual(await f.store.claimOutboxEvents({ maxAttempts: 5 }), []);
      if (attempt < 5) {
        const expected = Math.min(25, 10 * 2 ** (attempt - 1));
        const available = Date.parse(String(row.available_at));
        assert.ok(available >= before + expected * 1000 - 20);
        assert.ok(available <= Date.now() + expected * 1000 + 20);
        assert.equal(row.dead_lettered_at, null);
        assert.equal(failures.at(-1)!.retryDelaySeconds, expected);
        await f.expire(eventId);
      } else {
        assert.ok(Number.isFinite(Date.parse(String(row.dead_lettered_at))));
        assert.equal(failures.at(-1)!.deadLettered, true);
        assert.equal(failures.at(-1)!.retryScheduled, false);
        assert.equal(failures.at(-1)!.retryDelaySeconds, null);
      }
    }
    assert.equal(failures.length, 5);
    assert.ok(!JSON.stringify(failures).includes("credential"));
    const [snapshot] = await f.query("SELECT * FROM outbox_events WHERE id = ?", [eventId]);
    assert.deepEqual(await f.store.outboxBacklog(), { pendingEvents: 0, deadLetterEvents: 1, oldestPendingAgeMs: 0 });
    assert.deepEqual(await dispatchOutboxBatch({ store: f.store, deliver, maxAttempts: 100 }), { claimed: 0, delivered: 0, failed: 0, deadLettered: 0 });
    assert.deepEqual(await f.query("SELECT * FROM outbox_events WHERE id = ?", [eventId]), [snapshot], "raising a worker budget cannot resurrect a dead letter");
  });

  test(`${provider}: a poison event never blocks healthy delivery and dead letters do not inflate pending age`, integrityOptions(provider), async (t) => {
    const f = await notificationIntegrityFixture(t, provider);
    const poison = await f.enqueue("poison"), healthy = await f.enqueue("healthy");
    await f.query("UPDATE outbox_events SET created_at = ? WHERE id = ?", ["2001-01-01T00:00:00.000Z", poison.eventId]);
    const deliver = createMessageNotificationDelivery({ store: f.store });
    const result = await runOutboxDrain({
      store: f.store, batchLimit: 1, maxAttempts: 1,
      deliver: async event => { if (event.id === poison.eventId) throw new TypeError("poison payload"); await deliver(event); },
    });
    assert.equal(result.stopReason, "empty");
    assert.equal(result.errorName, null);
    assert.equal(result.claimed, 2);
    assert.equal(result.delivered, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.deadLettered, 1);
    const notifications = await f.store.listNotifications({ actorId: "integrity-recipient", limit: 100 });
    assert.deepEqual(notifications.map(row => row.eventKey), [`message:${healthy.message.id}`]);
    const backlog = await f.store.outboxBacklog();
    assert.deepEqual(backlog, { pendingEvents: 0, deadLetterEvents: 1, oldestPendingAgeMs: 0 });
    const metrics = createOutboxMetrics();
    metrics.recordBacklog(backlog);
    assert.match(metrics.render(), /^api_outbox_pending_events 0$/m);
    assert.match(metrics.render(), /^api_outbox_dead_letter_events 1$/m);
    assert.match(metrics.render(), /^api_outbox_oldest_pending_age_seconds 0\.000$/m);
  });

  test(`${provider}: an expired final attempt is quarantined even if the worker crashed before rescheduling`, integrityOptions(provider), async (t) => {
    const f = await notificationIntegrityFixture(t, provider);
    const poison = await f.enqueue("crashed-final-attempt");
    const [lease] = await f.store.claimOutboxEvents({ maxAttempts: 1, leaseSeconds: 60 });
    assert.equal(lease.attempts, 1);
    assert.deepEqual(await f.store.claimOutboxEvents({ maxAttempts: 1 }), [], "live final lease cannot be killed by another worker");
    assert.equal((await f.query("SELECT dead_lettered_at FROM outbox_events WHERE id = ?", [poison.eventId]))[0].dead_lettered_at, null);
    await f.expire(poison.eventId);
    const healthy = await f.enqueue("after-crash");
    const [claimed] = await f.store.claimOutboxEvents({ maxAttempts: 1 });
    assert.equal(claimed.id, healthy.eventId);
    const [dead] = await f.query("SELECT * FROM outbox_events WHERE id = ?", [poison.eventId]);
    assert.equal(dead.attempts, 1, "crash recovery cannot spend a ninth attempt");
    assert.ok(dead.dead_lettered_at);
    assert.equal(dead.lease_token, null);
    assert.equal(await f.store.markOutboxDelivered({ eventId: lease.id, leaseToken: lease.lease_token }), false);
    assert.equal(await f.store.rescheduleOutboxEvent({ eventId: lease.id, leaseToken: lease.lease_token, maxAttempts: 1 }), false);
    assert.equal(await f.store.markOutboxDelivered({ eventId: claimed.id, leaseToken: claimed.lease_token }), true);
    assert.deepEqual(await f.store.outboxBacklog(), { pendingEvents: 0, deadLetterEvents: 1, oldestPendingAgeMs: 0 });
  });

  test(`${provider}: stale and expired leases cannot dead-letter another worker's event`, integrityOptions(provider), async (t) => {
    const f = await notificationIntegrityFixture(t, provider);
    const { eventId } = await f.enqueue("lease-fencing");
    const [old] = await f.store.claimOutboxEvents({ maxAttempts: 3 });
    await f.expire(eventId);
    assert.equal(await f.store.rescheduleOutboxEvent({ eventId, leaseToken: old.lease_token, maxAttempts: 1 }), false);
    const [current] = await f.store.claimOutboxEvents({ maxAttempts: 3 });
    assert.equal(current.attempts, 2);
    assert.notEqual(old.lease_token, current.lease_token);
    const [before] = await f.query("SELECT * FROM outbox_events WHERE id = ?", [eventId]);
    for (const token of [old.lease_token, randomUUID()]) {
      assert.equal(await f.store.rescheduleOutboxEvent({ eventId, leaseToken: token, maxAttempts: 1 }), false);
      assert.equal(await f.store.markOutboxDelivered({ eventId, leaseToken: token }), false);
    }
    assert.deepEqual(await f.query("SELECT * FROM outbox_events WHERE id = ?", [eventId]), [before]);
    assert.equal(await f.store.rescheduleOutboxEvent({ eventId, leaseToken: current.lease_token, maxAttempts: 2 }), true);
    assert.deepEqual(await f.store.claimOutboxEvents(), []);
    assert.equal((await f.store.outboxBacklog()).deadLetterEvents, 1);
  });

  test(`${provider}: retry budget validation runs before any lease or timestamp changes`, integrityOptions(provider), async (t) => {
    const f = await notificationIntegrityFixture(t, provider);
    const { eventId } = await f.enqueue("validation");
    for (const maxAttempts of [0, -1, 101, 1.5, NaN, Infinity]) {
      await assert.rejects(f.store.claimOutboxEvents({ maxAttempts }), TypeError);
    }
    assert.equal((await f.query("SELECT attempts FROM outbox_events WHERE id = ?", [eventId]))[0].attempts, 0);
    const [lease] = await f.store.claimOutboxEvents();
    const before = await f.query("SELECT * FROM outbox_events WHERE id = ?", [eventId]);
    for (const maxAttempts of [0, 101, 1.5, NaN]) {
      await assert.rejects(f.store.rescheduleOutboxEvent({ eventId, leaseToken: lease.lease_token, maxAttempts }), TypeError);
    }
    assert.deepEqual(await f.query("SELECT * FROM outbox_events WHERE id = ?", [eventId]), before);
    assert.equal(await f.store.markOutboxDelivered({ eventId, leaseToken: lease.lease_token }), true);
    assert.equal((await f.store.outboxBacklog()).deadLetterEvents, 0);
  });

  test(`${provider}: pending backlog includes delayed and leased rows but excludes delivered and dead rows`, integrityOptions(provider), async (t) => {
    const f = await notificationIntegrityFixture(t, provider);
    const oldest = await f.enqueue("oldest-dead");
    await f.query("UPDATE outbox_events SET created_at = ? WHERE id = ?", ["2001-01-01T00:00:00.000Z", oldest.eventId]);
    const [deadLease] = await f.store.claimOutboxEvents();
    await f.store.rescheduleOutboxEvent({ eventId: oldest.eventId, leaseToken: deadLease.lease_token, maxAttempts: 1 });
    await f.enqueue("delivered");
    const [done] = await f.store.claimOutboxEvents();
    await f.store.markOutboxDelivered({ eventId: done.id, leaseToken: done.lease_token });
    await f.enqueue("delayed");
    const [delayed] = await f.store.claimOutboxEvents();
    await f.store.rescheduleOutboxEvent({ eventId: delayed.id, leaseToken: delayed.lease_token, delaySeconds: 3600 });
    await f.enqueue("leased");
    const [leased] = await f.store.claimOutboxEvents();
    const backlog = await f.store.outboxBacklog();
    assert.equal(backlog.pendingEvents, 2);
    assert.equal(backlog.deadLetterEvents, 1);
    assert.ok(backlog.oldestPendingAgeMs >= 0 && backlog.oldestPendingAgeMs < 60_000);
    assert.deepEqual(await f.store.claimOutboxEvents(), []);
    assert.equal(await f.store.markOutboxDelivered({ eventId: leased.id, leaseToken: leased.lease_token }), true);
    assert.equal((await f.store.outboxBacklog()).pendingEvents, 1);
  });

  test(`${provider}: bounded crash cleanup skips a larger exhausted backlog and still leases healthy work`, integrityOptions(provider), async (t) => {
    const f = await notificationIntegrityFixture(t, provider);
    const healthy = await f.enqueue("healthy-behind-exhausted-backlog");
    for (let index = 0; index < 101; index += 1) {
      await f.query("INSERT INTO outbox_events (id,event_key,event_type,aggregate_id,payload,attempts,available_at,created_at) VALUES (?,?,'unsupported.notification','poison','{}',8,?,?)",
        [randomUUID(), `exhausted:${index}`, "2001-01-01T00:00:00.000Z", "2001-01-01T00:00:00.000Z"]);
    }
    const [lease] = await f.store.claimOutboxEvents({ limit: 1 });
    assert.equal(lease.id, healthy.eventId, "exhausted rows do not consume the normal claim limit");
    const backlog = await f.store.outboxBacklog();
    assert.equal(backlog.deadLetterEvents, 100, "one claim bounds its maintenance independently of the delivery batch size");
    assert.equal(backlog.pendingEvents, 2, "the live lease and unswept nonterminal row are still pending");
    assert.deepEqual(await f.store.claimOutboxEvents({ limit: 1 }), []);
    assert.equal((await f.store.outboxBacklog()).deadLetterEvents, 101);
    assert.equal(await f.store.markOutboxDelivered({ eventId: lease.id, leaseToken: lease.lease_token }), true);
    assert.deepEqual(await f.store.outboxBacklog(), { pendingEvents: 0, deadLetterEvents: 101, oldestPendingAgeMs: 0 });
  });

  test(`${provider}: simultaneous claims respect a final live lease and persist exactly one terminal state`, integrityOptions(provider), async (t) => {
    const f = await notificationIntegrityFixture(t, provider);
    const { eventId } = await f.enqueue("concurrent-final-claim");
    const results = await Promise.all(Array.from({ length: 6 }, () => f.store.claimOutboxEvents({ maxAttempts: 1 })));
    const leases = results.flat();
    assert.equal(leases.length, 1);
    const lease = leases[0];
    assert.equal(lease.attempts, 1);
    const settled = await Promise.all([
      f.store.markOutboxDelivered({ eventId, leaseToken: lease.lease_token }),
      f.store.rescheduleOutboxEvent({ eventId, leaseToken: lease.lease_token, maxAttempts: 1 }),
    ]);
    assert.equal(settled.filter(Boolean).length, 1);
    const [row] = await f.query("SELECT * FROM outbox_events WHERE id = ?", [eventId]);
    assert.notEqual(row.delivered_at === null, row.dead_lettered_at === null);
    assert.equal(row.lease_token, null);
    assert.deepEqual(await f.store.claimOutboxEvents(), []);
  });
}
