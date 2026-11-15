import assert from "node:assert/strict";
import test from "node:test";
import { RefreshChangeFeed, refreshWakeupPayload } from "../refresh/change-feed.ts";

function fixture() {
  let notify!: (value: string) => void, reconnect!: () => void;
  const feed = new RefreshChangeFeed({ namespace: "fixture", maxKeys: 2, timeoutMs: 500,
    listen: async (_channel, onNotify, onListen) => { notify = onNotify; reconnect = onListen; onListen(); } });
  return { feed, notify: (value: string) => notify(value), reconnect: () => reconnect() };
}

test("notifications only wake a matching bounded subscription; data still comes from the store", async () => {
  const f = fixture(); await f.feed.start(); const watch = f.feed.watch("a".repeat(64)); const revision = watch.revision();
  for (const invalid of ["not-json", "x".repeat(2000), JSON.stringify(["nwr1", "other", "a".repeat(64)]), JSON.stringify(["nwr1", "fixture", "private-canary"]), JSON.stringify(["nwr1", "fixture", "b".repeat(64)])]) f.notify(invalid);
  assert.equal(watch.revision(), revision);
  f.notify(refreshWakeupPayload("fixture", "a".repeat(64)));
  await watch.wait(revision, 1000, new AbortController().signal);
  assert.ok(watch.revision() > revision);
  const another = f.feed.watch("b".repeat(64)); assert.throws(() => f.feed.watch("c".repeat(64)));
  watch.close(); another.close(); assert.equal(f.feed.snapshot().keys, 0); f.feed.close();
});

test("reconnect wakes subscribers, and close cancels a waiter without retaining timers", async () => {
  const f = fixture(); await f.feed.start(); const watch = f.feed.watch("a".repeat(64)); const revision = watch.revision();
  f.reconnect(); await watch.wait(revision, 1000, new AbortController().signal);
  const pending = watch.wait(watch.revision(), 10000, new AbortController().signal); const rejected = assert.rejects(pending);
  f.feed.close(); await rejected; assert.equal(f.feed.snapshot().keys, 0);
});
