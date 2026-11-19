import assert from "node:assert/strict";
import test from "node:test";
import { handoffFixture } from "../infrastructure/test-support/alert-handoff-fixture.ts";
import { acknowledgeMonitorEvents } from "./operational-alerts.ts";
import {
  HandoffFault,
  createHandoffBatch,
  handoffHash,
} from "./alert-handoff-protocol.ts";
import {
  prepareAlertHandoff,
  settleAlertHandoff,
} from "./alert-handoff-sender.ts";
import {
  acceptAlertHandoff,
  consumeAlertInbox,
} from "./alert-handoff-inbox.ts";
import {
  readAlertInboxPage,
  recoverAlertReceipt,
} from "./alert-handoff-reader.ts";
import { reconcileAlertHandoff } from "./alert-handoff-reconcile.ts";
import { alertInboxStatus, alertSenderStatus } from "./alert-handoff-status.ts";

const binding = handoffHash(["monitor-config", "monitor-state"]);
const fault = (code: string) => (e: unknown) =>
  e instanceof HandoffFault && e.code === code;
function prepared() {
  const f = handoffFixture(),
    p = prepareAlertHandoff(f.sender, null, f.monitor, binding, f.now);
  return { ...f, p };
}

test("reconciliation distinguishes not received, durable receipt, consumed receipt and settled evidence without mutation", async () => {
  const f = prepared(),
    before = JSON.stringify(f.p.state);
  const reconcile = (sender: unknown, inbox: unknown, monitor = f.monitor) =>
    reconcileAlertHandoff({
      senderConfig: f.sender,
      senderState: sender,
      sourceBinding: binding,
      inboxConfig: f.inbox,
      inboxState: inbox,
      monitorConfig: f.monitorConfig,
      monitorState: monitor,
      now: f.now + 100,
    });
  const missing = reconcile(f.p.state, null);
  assert.equal(missing.stage, "receiver_not_observed");
  assert.equal(missing.exitCode, 3);
  const accepted = acceptAlertHandoff(f.inbox, null, f.p.batch!, f.now + 1);
  const report = reconcile(f.p.state, accepted.state);
  assert.equal(report.stage, "received_awaiting_settlement");
  assert.equal(report.exitCode, 1);
  assert.equal(report.receipt?.batchId, f.p.batch!.id);
  const consumed = consumeAlertInbox(
    f.inbox,
    accepted.state,
    accepted.state.entries[0].id,
    f.now + 2,
  );
  assert.equal(reconcile(f.p.state, consumed.state).receipt?.pendingEntries, 0);
  const settled = await settleAlertHandoff(
    f.sender,
    f.p.state!,
    accepted.receipt,
    { persist() {}, acknowledge: () => 1 },
  );
  const monitor = acknowledgeMonitorEvents(
    f.monitorConfig,
    f.monitor,
    f.monitor.events[0].id,
  ).state;
  const done = reconcile(settled.state, consumed.state, monitor);
  assert.equal(done.stage, "settled");
  assert.equal(done.exitCode, 0);
  assert.equal(done.scope, "non_atomic_offline_evidence");
  assert.equal(JSON.stringify(f.p.state), before);
  assert.equal(f.monitor.events.length, 1);
});

test("reconciliation detects receiver rollback, fork, source-prefix loss, unprepared events and future clocks", async () => {
  const f = prepared(),
    accepted = acceptAlertHandoff(f.inbox, null, f.p.batch!, f.now + 1);
  const settle = await settleAlertHandoff(
    f.sender,
    f.p.state!,
    accepted.receipt,
    { persist() {}, acknowledge: () => 1 },
  );
  const monitor = f.observe(
    acknowledgeMonitorEvents(f.monitorConfig, f.monitor, f.monitor.events[0].id)
      .state,
    f.now + 30_000,
  );
  const p2 = prepareAlertHandoff(
    f.sender,
    settle.state,
    monitor,
    binding,
    f.now + 30_000,
  );
  const opts = {
    senderConfig: f.sender,
    senderState: p2.state,
    sourceBinding: binding,
    inboxConfig: f.inbox,
    inboxState: accepted.state,
    monitorConfig: f.monitorConfig,
    monitorState: monitor,
    now: f.now + 30_001,
  };
  assert.equal(reconcileAlertHandoff(opts).stage, "awaiting_receive");
  assert.equal(
    reconcileAlertHandoff({ ...opts, senderState: settle.state }).stage,
    "unprepared_events",
  );
  const advanced = acknowledgeMonitorEvents(
    f.monitorConfig,
    monitor,
    monitor.events[0].id,
  ).state;
  const extra = f.observe(advanced, f.now + 60_000);
  const changed = acknowledgeMonitorEvents(
    f.monitorConfig,
    extra,
    extra.events[0].id,
  ).state;
  assert.equal(
    reconcileAlertHandoff({
      ...opts,
      monitorState: changed,
      now: f.now + 60_001,
    }).stage,
    "source_prefix_changed",
  );
  assert.equal(
    reconcileAlertHandoff({ ...opts, now: f.now - 1 }).stage,
    "clock_invalid",
  );
  const second = acceptAlertHandoff(
    f.inbox,
    accepted.state,
    p2.batch!,
    f.now + 30_001,
  );
  assert.equal(
    reconcileAlertHandoff({
      ...opts,
      senderState: f.p.state,
      inboxState: second.state,
    }).stage,
    "receiver_ahead",
  );
  // A trusted signer can still fork a sequence. The receiver must reject it.
  const fork = createHandoffBatch(
    f.sender,
    f.monitor.events,
    f.monitor.fingerprint,
    1,
    null,
    f.now + 1,
  );
  assert.throws(
    () => acceptAlertHandoff(f.inbox, accepted.state, fork, f.now + 2),
    fault("batch_out_of_order"),
  );
});

test("inbox pages are signed, exact-snapshot bound, bounded and safe to repeat under a held write lock", async () => {
  const f = prepared(),
    first = acceptAlertHandoff(f.inbox, null, f.p.batch!, f.now + 1);
  const settled = await settleAlertHandoff(
    f.sender,
    f.p.state!,
    first.receipt,
    { persist() {}, acknowledge: () => 1 },
  );
  const monitor = f.observe(
    acknowledgeMonitorEvents(f.monitorConfig, f.monitor, f.monitor.events[0].id)
      .state,
    f.now + 30_000,
  );
  const second = prepareAlertHandoff(
    f.sender,
    settled.state,
    monitor,
    binding,
    f.now + 30_000,
  );
  const accepted = acceptAlertHandoff(
    f.inbox,
    first.state,
    second.batch!,
    f.now + 30_001,
  );
  const page = readAlertInboxPage(f.inbox, accepted.state, 1, null);
  assert.equal(page.entries.length, 1);
  assert.equal(page.remaining, 1);
  assert.ok(page.continuation);
  const next = readAlertInboxPage(
    f.inbox,
    accepted.state,
    1,
    page.continuation,
  );
  assert.equal(next.entries[0].ordinal, 2);
  assert.equal(next.continuation, null);
  assert.deepEqual(
    readAlertInboxPage(f.inbox, accepted.state, 1, page.continuation),
    next,
  );
  assert.throws(
    () => readAlertInboxPage(f.inbox, accepted.state, 257, null),
    fault("arguments_invalid"),
  );
  assert.throws(
    () =>
      readAlertInboxPage(
        f.inbox,
        accepted.state,
        1,
        page.continuation!.slice(0, -3) + "xyz",
      ),
    fault("cursor_invalid"),
  );
  const consumed = consumeAlertInbox(
    f.inbox,
    accepted.state,
    page.entries[0].id,
    f.now + 30_002,
  );
  assert.throws(
    () => readAlertInboxPage(f.inbox, consumed.state, 1, page.continuation),
    fault("page_stale"),
  );
  const foreign = handoffFixture();
  assert.throws(() =>
    readAlertInboxPage(foreign.inbox, accepted.state, 1, page.continuation),
  );
});

test("latest receipt recovery survives consumption but cannot invent proof for another sequence or source", () => {
  const f = prepared(),
    accepted = acceptAlertHandoff(f.inbox, null, f.p.batch!, f.now + 1);
  const consumed = consumeAlertInbox(
    f.inbox,
    accepted.state,
    accepted.state.entries[0].id,
    f.now + 2,
  );
  assert.deepEqual(
    recoverAlertReceipt(
      f.inbox,
      consumed.state,
      f.sender.streamId,
      1,
      f.p.batch!.id,
    ),
    accepted.receipt,
  );
  assert.throws(
    () =>
      recoverAlertReceipt(
        f.inbox,
        consumed.state,
        f.sender.streamId,
        2,
        f.p.batch!.id,
      ),
    fault("receipt_not_found"),
  );
  assert.throws(
    () =>
      recoverAlertReceipt(
        f.inbox,
        consumed.state,
        f.sender.receiverId,
        1,
        f.p.batch!.id,
      ),
    fault("receipt_not_found"),
  );
  assert.throws(
    () =>
      recoverAlertReceipt(
        f.inbox,
        consumed.state,
        f.sender.streamId,
        1,
        "a".repeat(64),
      ),
    fault("receipt_not_found"),
  );
});

test("status ages distinguish event time from durable acceptance and never refresh progress by reading", () => {
  const f = prepared(),
    accepted = acceptAlertHandoff(f.inbox, null, f.p.batch!, f.now + 10_000);
  const before = JSON.stringify(accepted.state);
  const sender = alertSenderStatus(
    f.sender,
    f.p.state!,
    binding,
    f.monitor,
    f.now + 20_000,
    15_000,
  );
  assert.equal(sender.age, "overdue");
  assert.equal(sender.pendingAgeMs, 20_000);
  assert.equal(sender.exitCode, 1);
  const inbox = alertInboxStatus(
    f.inbox,
    accepted.state,
    f.now + 20_000,
    15_000,
  );
  assert.equal(inbox.age, "within_budget");
  assert.equal(inbox.oldestAcceptanceAgeMs, 10_000);
  assert.equal(inbox.oldestEventAgeMs, 20_000);
  assert.equal(inbox.exitCode, 1);
  assert.equal(JSON.stringify(accepted.state), before);
  assert.throws(
    () => alertInboxStatus(f.inbox, accepted.state, f.now, 15_000),
    fault("clock_rollback"),
  );
  assert.throws(
    () =>
      alertSenderStatus(
        f.sender,
        f.p.state!,
        binding,
        f.monitor,
        f.now - 1,
        15_000,
      ),
    fault("clock_rollback"),
  );
  assert.throws(
    () => alertInboxStatus(f.inbox, accepted.state, f.now + 20_000, 0),
    fault("arguments_invalid"),
  );
});

test("a failed final sender commit cannot mutate the earlier persisted receipt-intent object", async () => {
  const f = prepared(),
    accepted = acceptAlertHandoff(f.inbox, null, f.p.batch!, f.now + 1);
  let durable = f.p.state!,
    writes = 0;
  await assert.rejects(
    settleAlertHandoff(f.sender, f.p.state!, accepted.receipt, {
      persist(state) {
        if (++writes === 2) throw new Error("final-commit-failed");
        durable = state;
      },
      acknowledge: () => 1,
    }),
    /final-commit-failed/,
  );
  assert.equal(durable.sequence, 0);
  assert.ok(durable.pending?.receipt);
});
