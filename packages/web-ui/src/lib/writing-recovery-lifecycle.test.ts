import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { bindWritingRecovery } from "./writing-recovery-lifecycle.ts";
import { WritingRecoveryBoundary } from "./writing-recovery-boundary.ts";

test("hidden and bfcache boundaries synchronously remove cached DOM, coalesce identity reads and detach on unmount", async () => {
  const window = new EventTarget(),
    document = new EventTarget();
  let visible = true,
    connected = 0,
    suspended = 0,
    invalidated = 0,
    flushed = 0;
  const source = randomUUID();
  const boundary = new WritingRecoveryBoundary({
    id: randomUUID,
    send: () => {},
    store: () => ({ purge: async () => {}, close: () => {} }),
  });
  const stop = bindWritingRecovery(
    {
      connect: async (actor) => {
        assert.equal(actor, "pinned-account");
        connected++;
      },
      suspend: () => {
        suspended++;
      },
      invalidate: () => {
        invalidated++;
      },
    },
    "pinned-account",
    source,
    boundary,
    {
      window,
      document,
      visible: () => visible,
      flush: (work) => {
        flushed++;
        work();
      },
    },
  );
  assert.equal(suspended, 1);
  await Promise.resolve();
  assert.equal(connected, 1);
  visible = false;
  document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(suspended, 2);
  assert.equal(flushed, 1);
  window.dispatchEvent(new Event("focus"));
  await Promise.resolve();
  assert.equal(connected, 1);
  visible = true;
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("focus"));
  await Promise.resolve();
  assert.equal(connected, 2);
  window.dispatchEvent(new Event("pagehide"));
  window.dispatchEvent(new Event("online"));
  await Promise.resolve();
  assert.equal(
    connected,
    2,
    "pagehide wins while visibilityState is still stale; online cannot revive the page",
  );
  const show = new Event("pageshow");
  Object.defineProperty(show, "persisted", { value: true });
  window.dispatchEvent(show);
  await Promise.resolve();
  assert.equal(connected, 3);
  boundary.announce(source);
  assert.equal(invalidated, 0);
  boundary.announce();
  assert.equal(invalidated, 1);
  stop();
  const last = suspended;
  window.dispatchEvent(new Event("focus"));
  boundary.announce();
  await Promise.resolve();
  assert.equal(connected, 3);
  assert.equal(suspended, last);
  assert.equal(invalidated, 1);
});
