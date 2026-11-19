import assert from "node:assert/strict";
import test from "node:test";
import { handoffFixture } from "../infrastructure/test-support/alert-handoff-fixture.ts";
import {
  acceptAlertHandoff,
  consumeAlertInbox,
  parseHandoffInboxState,
  type HandoffInboxState,
} from "./alert-handoff-inbox.ts";
import {
  HandoffFault,
  createHandoffBatch,
  handoffHash,
  type HandoffBatch,
} from "./alert-handoff-protocol.ts";

const fault = (code: string) => (error: unknown) =>
  error instanceof HandoffFault && error.code === code;
test("inbox capacity fails closed at 1024, never prunes receipts, and resumes only after explicit prefix consumption", () => {
  const f = handoffFixture();
  let state: HandoffInboxState | null = null,
    previous: HandoffBatch | null = null;
  function batch(sequence: number) {
    const events = Array.from({ length: 256 }, (_, index) => {
      const revision = (sequence - 1) * 256 + index + 1,
        at = f.now + revision;
      const event = {
        ...f.monitor.events[0],
        revision,
        at,
        firingSince: f.now + 1,
        transition:
          revision === 1 ? ("firing" as const) : ("reminder" as const),
      };
      event.id = handoffHash([
        f.monitor.fingerprint,
        revision,
        event.targetId,
        event.rule,
        event.transition,
        at,
      ]);
      return event;
    });
    return createHandoffBatch(
      f.sender,
      events,
      f.monitor.fingerprint,
      sequence,
      previous?.id ?? null,
      f.now + sequence * 256,
    );
  }
  for (let sequence = 1; sequence <= 4; sequence++) {
    const next = batch(sequence);
    state = acceptAlertHandoff(f.inbox, state, next, next.preparedAt).state;
    previous = next;
  }
  assert.equal(state!.entries.length, 1024);
  const before = JSON.stringify(state),
    fifth = batch(5);
  assert.throws(
    () => acceptAlertHandoff(f.inbox, state, fifth, fifth.preparedAt),
    fault("state_full"),
  );
  assert.equal(JSON.stringify(state), before);
  const removed = consumeAlertInbox(
    f.inbox,
    state,
    state!.entries[511].id,
    fifth.preparedAt,
  );
  assert.equal(removed.consumed, 512);
  const next = acceptAlertHandoff(
    f.inbox,
    removed.state,
    fifth,
    fifth.preparedAt,
  );
  assert.equal(next.state.entries.length, 768);
  assert.equal(next.state.nextOrdinal, 1281);
  assert.equal(next.state.entries.at(-1)!.ordinal, 1280);
  assert.equal(next.state.cursors[0].sequence, 5);
  assert.equal(
    acceptAlertHandoff(f.inbox, next.state, fifth, f.now - 1).duplicate,
    true,
  );
  assert.throws(
    () => acceptAlertHandoff(f.inbox, next.state, previous, fifth.preparedAt),
    fault("batch_out_of_order"),
  );
});

test("a missing entry, modified acceptance record, fractional counter or future acceptance cannot become an empty/healthy view", () => {
  const f = handoffFixture(),
    batch = createHandoffBatch(
      f.sender,
      f.monitor.events,
      f.monitor.fingerprint,
      1,
      null,
      f.now,
    );
  const accepted = acceptAlertHandoff(f.inbox, null, batch, f.now + 1);
  const state = accepted.state,
    entry = state.entries[0];
  for (const patch of [
    { entries: [] },
    { entries: [{ ...entry, acceptedAt: f.now }] },
    { entries: [{ ...entry, inboxRevision: 2 }] },
    { lastMutationAt: f.now },
    { nextOrdinal: 2.5 },
    { entries: [{ ...entry, event: { ...entry.event, value: null } }] },
  ])
    assert.throws(
      () => parseHandoffInboxState({ ...state, ...patch }, f.inbox),
      fault("state_invalid"),
    );
  assert.throws(
    () => acceptAlertHandoff(f.inbox, null, batch, f.now - 1),
    fault("clock_rollback"),
  );
  assert.equal(state.entries.length, 1);
});
