import assert from "node:assert/strict";
import test from "node:test";
import { bindNotificationRecovery } from "./notification-recovery.ts";

function fixture() {
  const window = new EventTarget(), document = new EventTarget();
  const connections: boolean[] = [];
  let visible = true, hasSession = true;
  const stop = bindNotificationRecovery({ connect: async (active) => { connections.push(active); } }, {
    window, document, visible: () => visible, hasSessionHint: () => hasSession,
  });
  return { window, document, connections, stop,
    visibility: (next: boolean) => { visible = next; document.dispatchEvent(new Event("visibilitychange")); },
    session: (next: boolean) => { hasSession = next; },
  };
}
const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

test("binding clears private state synchronously and reads the session hint only after mount", async () => {
  const f = fixture();
  assert.deepEqual(f.connections, [false]);
  await tick();
  assert.deepEqual(f.connections, [false, true]);
  f.stop();
  assert.equal(f.connections.at(-1), false);
});

test("focus, online and pageshow in one event burst coalesce into one authoritative reconnect", async () => {
  const f = fixture();
  await tick();
  f.connections.length = 0;
  for (const event of ["focus", "online", "pageshow"]) f.window.dispatchEvent(new Event(event));
  assert.ok(f.connections.every((active) => active === false), "old rows disappear before the asynchronous read");
  await tick();
  assert.equal(f.connections.filter(Boolean).length, 1);
  f.stop();
});

test("hidden pages cancel and clear instead of fetching in the background, then reconcile on visibility", async () => {
  const f = fixture();
  await tick();
  f.connections.length = 0;
  f.visibility(false);
  f.window.dispatchEvent(new Event("online"));
  await tick();
  assert.equal(f.connections.filter(Boolean).length, 0);
  f.visibility(true);
  await tick();
  assert.equal(f.connections.filter(Boolean).length, 1);
  f.stop();
});

test("pagehide cancels a queued restoration even before visibilityState changes", async () => {
  const f = fixture();
  f.window.dispatchEvent(new Event("pagehide"));
  f.window.dispatchEvent(new Event("online"));
  await tick();
  assert.equal(f.connections.filter(Boolean).length, 0);
  f.window.dispatchEvent(new Event("pageshow"));
  await tick();
  assert.equal(f.connections.filter(Boolean).length, 1);
  f.stop();
});

test("a replaced or removed session marker is re-read; a previous active hint is never reused", async () => {
  const f = fixture();
  await tick();
  f.session(false);
  f.window.dispatchEvent(new Event("focus"));
  await tick();
  assert.equal(f.connections.at(-1), false);
  f.connections.length = 0;
  f.session(true);
  f.window.dispatchEvent(new Event("focus"));
  assert.equal(f.connections[0], false);
  await tick();
  assert.deepEqual(f.connections, [false, true]);
  f.stop();
});

test("cleanup removes every listener and prevents an already queued restore from reviving a disposed shell", async () => {
  const f = fixture();
  f.stop();
  const count = f.connections.length;
  for (const event of ["focus", "online", "pageshow", "pagehide"]) f.window.dispatchEvent(new Event(event));
  f.visibility(true);
  await tick();
  assert.equal(f.connections.length, count);
  assert.equal(f.connections.filter(Boolean).length, 0);
});

test("unreadable cookie hints fail closed, without an exception or a private fetch", async () => {
  const connections: boolean[] = [];
  const stop = bindNotificationRecovery({ connect: async (active) => { connections.push(active); } }, {
    window: new EventTarget(), document: new EventTarget(), visible: () => true,
    hasSessionHint: () => { throw new Error("synthetic-cookie-access-denied"); },
  });
  await tick();
  assert.deepEqual(connections, [false, false]);
  stop();
});

test("independent browser shells cannot deliver recovery events or private data to each other", async () => {
  const first = fixture(), second = fixture();
  await tick();
  second.connections.length = 0;
  first.window.dispatchEvent(new Event("focus"));
  await tick();
  assert.deepEqual(second.connections, []);
  first.stop(); second.stop();
});
