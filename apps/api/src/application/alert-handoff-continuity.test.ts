import assert from "node:assert/strict";
import test from "node:test";
import { handoffFixture } from "../infrastructure/test-support/alert-handoff-fixture.ts";
import {
  createHandoffBatch,
  handoffHash,
  HandoffFault,
} from "./alert-handoff-protocol.ts";
import { assertHandoffMonitorPrefix } from "./alert-handoff-sender.ts";
import type { MonitorEvent } from "./operational-monitor.ts";

test("a signed queue cannot fork an evaluation time, duplicate a rule transition or rewrite an active episode", () => {
  const f = handoffFixture();
  function event(
    revision: number,
    transition: MonitorEvent["transition"],
    patch: Partial<MonitorEvent> = {},
  ): MonitorEvent {
    const at = f.now + (revision - 1) * 30_000;
    const row = {
      ...f.monitor.events[0],
      revision,
      at,
      transition,
      reason:
        transition === "resolved"
          ? ("within_threshold" as const)
          : ("breached" as const),
      value: transition === "resolved" ? 0 : 1,
      firingSince: transition === "firing" ? at : f.now,
      ...patch,
    };
    row.id = handoffHash([
      f.monitor.fingerprint,
      row.revision,
      row.targetId,
      row.rule,
      row.transition,
      row.at,
    ]);
    return row;
  }
  const sign = (events: MonitorEvent[]) =>
    createHandoffBatch(
      f.sender,
      events,
      f.monitor.fingerprint,
      1,
      null,
      f.now + 120_000,
    );
  assert.equal(
    sign([
      event(1, "firing"),
      event(2, "reminder"),
      event(3, "resolved"),
      event(4, "firing"),
    ]).events.length,
    4,
  );
  const invalid = [
    [event(1, "firing"), event(1, "reminder")],
    [event(1, "firing"), event(1, "reminder", { at: f.now + 1 })],
    [event(1, "firing"), event(2, "firing")],
    [event(1, "firing"), event(2, "reminder", { firingSince: f.now + 1 })],
    [event(2, "resolved"), event(3, "reminder")],
    [event(1, "firing"), event(2, "reminder", { at: f.now })],
    [event(2, "reminder", { reason: "source_unavailable", value: null })],
    Array.from({ length: 17 }, (_, index) =>
      event(1, "firing", { targetId: "worker-" + index }),
    ),
  ];
  for (const events of invalid)
    assert.throws(
      () => sign(events),
      (error: unknown) =>
        error instanceof HandoffFault && error.code === "artifact_invalid",
    );
});

test("an acknowledged-through ID cannot substitute for a non-rollback source revision and observation timestamp", () => {
  const f = handoffFixture(),
    batch = createHandoffBatch(
      f.sender,
      f.monitor.events,
      f.monitor.fingerprint,
      1,
      null,
      f.now,
    );
  const restored = {
    ...f.monitor,
    events: [],
    acknowledgedThrough: batch.events[0].id,
  };
  assert.throws(() => assertHandoffMonitorPrefix(batch, restored), {
    code: "monitor_prefix_changed",
  });
  assert.throws(
    () =>
      assertHandoffMonitorPrefix(batch, {
        ...restored,
        revision: 2,
        lastEvaluatedAt: f.now - 1,
      }),
    { code: "monitor_prefix_changed" },
  );
  assert.equal(
    assertHandoffMonitorPrefix(batch, { ...restored, revision: 2 }),
    0,
  );
});
