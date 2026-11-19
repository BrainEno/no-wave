import assert from "node:assert/strict";
import test from "node:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { acknowledgeMonitorEvents } from "./operational-alerts.ts";
import { handoffFixture } from "../infrastructure/test-support/alert-handoff-fixture.ts";
import {
  HandoffFault,
  createHandoffBatch,
  handoffHash,
  verifyHandoffBatch,
  verifyHandoffReceipt,
} from "./alert-handoff-protocol.ts";
import {
  prepareAlertHandoff,
  parseHandoffSenderState,
  settleAlertHandoff,
  assertHandoffMonitorPrefix,
} from "./alert-handoff-sender.ts";
import {
  acceptAlertHandoff,
  consumeAlertInbox,
  parseHandoffInboxState,
  ALERT_INBOX_LIMIT,
} from "./alert-handoff-inbox.ts";
import {
  parseHandoffInboxConfig,
  parseHandoffSenderConfig,
} from "../infrastructure/alert-handoff-config.ts";

const binding = createHash("sha256")
  .update("isolated-monitor-path")
  .digest("hex");
function fault(code: string) {
  return (error: unknown) =>
    error instanceof HandoffFault && error.code === code;
}

test("signatures pin distinct peers, canonical content, source namespace and receipt direction", () => {
  const f = handoffFixture();
  const p = prepareAlertHandoff(f.sender, null, f.monitor, binding, f.now);
  assert.ok(p.batch);
  assert.deepEqual(verifyHandoffBatch(p.batch, f.inbox), p.batch);
  const accepted = acceptAlertHandoff(f.inbox, null, p.batch, f.now + 1);
  assert.deepEqual(
    verifyHandoffReceipt(accepted.receipt, f.sender, p.batch),
    accepted.receipt,
  );
  const reordered = Object.fromEntries(Object.entries(p.batch).reverse());
  assert.deepEqual(verifyHandoffBatch(reordered, f.inbox), p.batch);
  for (const patch of [
    { sequence: 2 },
    { receiverId: f.sender.streamId },
    { streamId: f.sender.receiverId },
    { signature: "A".repeat(88) },
    { events: [] },
    { extra: "untrusted-canary" },
    { events: [{ ...p.batch.events[0], value: 99 }] },
  ])
    assert.throws(
      () => verifyHandoffBatch({ ...p.batch, ...patch }, f.inbox),
      fault("artifact_invalid"),
    );
  const foreign = handoffFixture();
  assert.throws(
    () => verifyHandoffBatch(p.batch, foreign.inbox),
    fault("artifact_invalid"),
  );
  assert.throws(
    () => verifyHandoffReceipt(p.batch, f.sender, p.batch),
    fault("artifact_invalid"),
  );
  assert.throws(
    () =>
      verifyHandoffReceipt(
        { ...accepted.receipt, count: 2 },
        f.sender,
        p.batch,
      ),
    fault("artifact_invalid"),
  );
  assert.throws(
    () =>
      verifyHandoffReceipt(
        { ...accepted.receipt, through: "b".repeat(64) },
        f.sender,
        p.batch,
      ),
    fault("artifact_invalid"),
  );
});

test("configuration rejects unexpected keys, algorithm confusion, key aliases and peer self-trust", () => {
  const f = handoffFixture();
  for (const patch of [
    { enabled: true },
    { signingKey: "invalid-private-canary" },
    { streamId: "not-a-uuid" },
    { receiverKey: f.senderDocument.signingKey },
  ]) {
    assert.throws(
      () => parseHandoffSenderConfig({ ...f.senderDocument, ...patch }),
      fault("config_invalid"),
    );
  }
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(
    () =>
      parseHandoffSenderConfig({
        ...f.senderDocument,
        signingKey: rsa.privateKey
          .export({ format: "der", type: "pkcs8" })
          .toString("base64"),
      }),
    fault("config_invalid"),
  );
  assert.throws(
    () =>
      parseHandoffInboxConfig({
        ...f.inboxDocument,
        sources: [...f.inboxDocument.sources, ...f.inboxDocument.sources],
      }),
    fault("config_invalid"),
  );
  const ownPublic = f.sender.publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64");
  assert.throws(
    () =>
      parseHandoffSenderConfig({ ...f.senderDocument, receiverKey: ownPublic }),
    fault("config_invalid"),
  );
  assert.equal(
    parseHandoffSenderConfig(
      Object.fromEntries(Object.entries(f.senderDocument).reverse()),
    ).fingerprint,
    f.sender.fingerprint,
  );
});

test("preparation is durable intent, retries freeze the exact batch while monitor observations advance", () => {
  const f = handoffFixture(),
    p = prepareAlertHandoff(f.sender, null, f.monitor, binding, f.now);
  assert.equal(p.state!.revision, 1);
  assert.equal(p.state!.sequence, 0);
  const later = f.observe(f.monitor, f.now + 30_000);
  const retry = prepareAlertHandoff(
    f.sender,
    p.state,
    later,
    binding,
    f.now + 30_000,
  );
  assert.deepEqual(retry, p);
  assert.equal(later.events.length, 2);
  assert.equal(assertHandoffMonitorPrefix(p.batch!, later), 1);
  assert.throws(
    () =>
      prepareAlertHandoff(
        f.sender,
        p.state,
        later,
        "a".repeat(64),
        f.now + 30_000,
      ),
    fault("state_binding_mismatch"),
  );
  const acknowledged = acknowledgeMonitorEvents(
    f.monitorConfig,
    later,
    later.events[1].id,
  ).state;
  assert.throws(
    () =>
      prepareAlertHandoff(
        f.sender,
        p.state,
        acknowledged,
        binding,
        f.now + 30_000,
      ),
    fault("monitor_prefix_changed"),
  );
  assert.throws(
    () => prepareAlertHandoff(f.sender, null, f.monitor, binding, f.now - 1),
    fault("clock_rollback"),
  );
});

test("a signed durable receipt does not acknowledge the monitor until explicit settlement", async () => {
  const f = handoffFixture(),
    p = prepareAlertHandoff(f.sender, null, f.monitor, binding, f.now);
  const received = acceptAlertHandoff(f.inbox, null, p.batch!, f.now + 1);
  const monitorBefore = structuredClone(f.monitor);
  const writes: string[] = [];
  const settled = await settleAlertHandoff(
    f.sender,
    p.state!,
    received.receipt,
    {
      persist: (state) => {
        writes.push(state.pending?.receipt ? "receipt" : "settled");
      },
      acknowledge: (batch) => {
        writes.push("ack");
        return assertHandoffMonitorPrefix(batch, f.monitor);
      },
    },
  );
  assert.deepEqual(writes, ["receipt", "ack", "settled"]);
  assert.equal(settled.state.pending, null);
  assert.equal(settled.state.sequence, 1);
  assert.deepEqual(f.monitor, monitorBefore);
  let called = false;
  const retry = await settleAlertHandoff(
    f.sender,
    settled.state,
    received.receipt,
    {
      persist: () => {
        called = true;
      },
      acknowledge: () => {
        called = true;
        return 0;
      },
    },
  );
  assert.equal(called, false);
  assert.equal(retry.acknowledged, 0);
});

test("crashes after receipt persistence or monitor ack resume without losing new events", async () => {
  const f = handoffFixture(),
    p = prepareAlertHandoff(f.sender, null, f.monitor, binding, f.now);
  const received = acceptAlertHandoff(f.inbox, null, p.batch!, f.now + 1);
  let durable = p.state!,
    monitor = f.observe(f.monitor, f.now + 30_000);
  await assert.rejects(
    settleAlertHandoff(f.sender, durable, received.receipt, {
      persist: (state) => {
        durable = state;
      },
      acknowledge: () => {
        throw new Error("simulated-process-stop");
      },
    }),
    /simulated-process-stop/,
  );
  assert.ok(durable.pending!.receipt);
  await assert.rejects(
    settleAlertHandoff(f.sender, durable, received.receipt, {
      persist: () => {
        throw new Error("disk-stop-after-ack");
      },
      acknowledge: (batch) => {
        assertHandoffMonitorPrefix(batch, monitor);
        monitor = acknowledgeMonitorEvents(
          f.monitorConfig,
          monitor,
          batch.events.at(-1)!.id,
        ).state;
        return 1;
      },
    }),
    /disk-stop-after-ack/,
  );
  assert.equal(monitor.events.length, 1);
  const result = await settleAlertHandoff(f.sender, durable, received.receipt, {
    persist: (state) => {
      durable = state;
    },
    acknowledge: (batch) => assertHandoffMonitorPrefix(batch, monitor),
  });
  assert.equal(result.acknowledged, 0);
  assert.equal(durable.pending, null);
  const next = prepareAlertHandoff(
    f.sender,
    durable,
    monitor,
    binding,
    f.now + 30_000,
  );
  assert.equal(next.batch!.sequence, 2);
  assert.equal(next.batch!.previous, p.batch!.id);
  assert.equal(next.batch!.events[0].id, monitor.events[0].id);
});

test("inbox retries reuse an identical receipt even after consumption, old or forked chains are refused", async () => {
  const f = handoffFixture(),
    p = prepareAlertHandoff(f.sender, null, f.monitor, binding, f.now);
  const accepted = acceptAlertHandoff(f.inbox, null, p.batch!, f.now + 1);
  assert.equal(accepted.state.entries.length, 1);
  const consumed = consumeAlertInbox(
    f.inbox,
    accepted.state,
    accepted.state.entries[0].id,
    f.now + 2,
  );
  assert.equal(consumed.consumed, 1);
  assert.deepEqual(
    consumeAlertInbox(
      f.inbox,
      consumed.state,
      accepted.state.entries[0].id,
      f.now + 3,
    ).state,
    consumed.state,
  );
  const replay = acceptAlertHandoff(
    f.inbox,
    consumed.state,
    p.batch!,
    f.now + 3,
  );
  assert.equal(replay.duplicate, true);
  assert.deepEqual(replay.receipt, accepted.receipt);
  assert.equal(replay.state.entries.length, 0);
  const settled = await settleAlertHandoff(
    f.sender,
    p.state!,
    accepted.receipt,
    { persist() {}, acknowledge: () => 1 },
  );
  const monitor = f.observe(
    acknowledgeMonitorEvents(f.monitorConfig, f.monitor, f.monitor.events[0].id)
      .state,
    f.now + 30_000,
  );
  const next = prepareAlertHandoff(
    f.sender,
    settled.state,
    monitor,
    binding,
    f.now + 30_000,
  );
  const second = acceptAlertHandoff(
    f.inbox,
    consumed.state,
    next.batch!,
    f.now + 30_001,
  );
  assert.equal(second.state.entries[0].ordinal, 2);
  assert.throws(
    () => acceptAlertHandoff(f.inbox, second.state, p.batch!, f.now + 30_002),
    fault("batch_out_of_order"),
  );
  const fork = prepareAlertHandoff(
    f.sender,
    p.state,
    monitor,
    binding,
    f.now + 30_000,
  );
  assert.deepEqual(fork.batch, p.batch);
  assert.throws(
    () =>
      consumeAlertInbox(f.inbox, second.state, "d".repeat(64), f.now + 30_002),
    fault("entry_not_found"),
  );
});

test("damaged sender and inbox state cannot fabricate receipts, empty an inbox or rebind keys", () => {
  const f = handoffFixture(),
    p = prepareAlertHandoff(f.sender, null, f.monitor, binding, f.now);
  const accepted = acceptAlertHandoff(f.inbox, null, p.batch!, f.now + 1);
  for (const patch of [
    { sequence: 1 },
    { lastBatchId: "a".repeat(64) },
    { revision: -1 },
    { unknown: true },
  ]) {
    assert.throws(
      () =>
        parseHandoffSenderState({ ...p.state, ...patch }, f.sender, binding),
      fault("state_invalid"),
    );
  }
  assert.throws(
    () =>
      parseHandoffSenderState(
        { ...p.state, fingerprint: "a".repeat(64) },
        f.sender,
        binding,
      ),
    fault("state_config_mismatch"),
  );
  for (const patch of [
    { nextOrdinal: 1 },
    { entries: [...accepted.state.entries, ...accepted.state.entries] },
    { entries: [{ ...accepted.state.entries[0], id: "f".repeat(64) }] },
    { cursors: [] },
    { lastMutationAt: f.now - 1 },
  ])
    assert.throws(
      () => parseHandoffInboxState({ ...accepted.state, ...patch }, f.inbox),
      fault("state_invalid"),
    );
  assert.equal(
    handoffHash({ version: 1 }),
    createHash("sha256")
      .update(JSON.stringify({ version: 1 }))
      .digest("hex"),
  );
  assert.equal(ALERT_INBOX_LIMIT, 1024);
});

test("signed batches cannot carry numerically impossible event facts or malformed event continuity", () => {
  const f = handoffFixture(),
    event = f.monitor.events[0];
  for (const patch of [
    { value: null },
    { value: 0 },
    { value: 2 },
    { firingSince: event.at - 1 },
    { transition: "reminder", reason: "source_unavailable", value: 1 },
  ]) {
    const altered = { ...event, ...patch };
    altered.id = handoffHash([
      f.monitor.fingerprint,
      altered.revision,
      altered.targetId,
      altered.rule,
      altered.transition,
      altered.at,
    ]);
    assert.throws(
      () =>
        createHandoffBatch(
          f.sender,
          [altered as typeof event],
          f.monitor.fingerprint,
          1,
          null,
          f.now,
        ),
      fault("artifact_invalid"),
    );
  }
});
