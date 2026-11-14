import assert from "node:assert/strict";
import test from "node:test";
import { bindNotificationRecovery } from "./notification-recovery.ts";

const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));
function fixture() {
  const window = new EventTarget(), document = new EventTarget();
  const events: string[] = [];
  let visible = true;
  const stop = bindNotificationRecovery({ connect: async (active) => { events.push(active ? "verify" : "clear"); } }, {
    window, document, visible: () => visible, hasSessionHint: () => true,
    flush: (work) => { events.push("flush-begin"); work(); events.push("flush-end"); },
  });
  return { window, document, events, stop, visibility: (next: boolean) => { visible = next; document.dispatchEvent(new Event("visibilitychange")); } };
}

test("pagehide clears both consumers inside the synchronous UI flush, not after the browser snapshot", async () => {
  const f = fixture();
  await tick();
  f.events.length = 0;
  f.window.dispatchEvent(new Event("pagehide"));
  assert.deepEqual(f.events, ["flush-begin", "clear", "flush-end"]);
  f.window.dispatchEvent(new Event("online"));
  await tick();
  assert.equal(f.events.filter((event) => event === "verify").length, 0);
  f.stop();
});

test("effect setup and cleanup do not invoke React's synchronous flush inside a lifecycle", async () => {
  const f = fixture();
  assert.deepEqual(f.events, ["clear"]);
  await tick();
  assert.deepEqual(f.events, ["clear", "verify"]);
  f.events.length = 0;
  f.stop();
  assert.deepEqual(f.events, ["clear"]);
});

test("a visibility restoration can recover after pagehide even without a pageshow or focus event", async () => {
  const f = fixture();
  await tick();
  f.window.dispatchEvent(new Event("pagehide"));
  f.visibility(false);
  f.events.length = 0;
  f.visibility(true);
  assert.deepEqual(f.events, ["flush-begin", "clear", "flush-end"]);
  await tick();
  assert.equal(f.events.at(-1), "verify");
  assert.equal(f.events.filter((event) => event === "verify").length, 1);
  f.stop();
});

test("an ordinary initial pageshow cannot silently retry a failed first identity check", async () => {
  const f = fixture();
  await tick();
  f.events.length = 0;
  f.window.dispatchEvent(new Event("pageshow"));
  await tick();
  assert.deepEqual(f.events, []);
  const persisted = new Event("pageshow");
  Object.defineProperty(persisted, "persisted", { value: true });
  f.window.dispatchEvent(persisted);
  await tick();
  assert.deepEqual(f.events, ["flush-begin", "clear", "flush-end", "verify"]);
  f.stop();
});

test("a final pagehide wins over an already-queued visible recovery", async () => {
  const f = fixture();
  await tick();
  f.events.length = 0;
  f.window.dispatchEvent(new Event("focus"));
  f.window.dispatchEvent(new Event("pagehide"));
  await tick();
  assert.equal(f.events.filter((event) => event === "verify").length, 0);
  assert.equal(f.events.filter((event) => event === "clear").length, 2);
  f.stop();
});

test("a throwing visibility reader fails closed instead of leaving the old account on screen", async () => {
  const window = new EventTarget(), document = new EventTarget();
  const active: boolean[] = [];
  const stop = bindNotificationRecovery({ connect: async (next) => { active.push(next); } }, {
    window, document, hasSessionHint: () => true,
    visible: () => { throw new Error("synthetic-visibility-access-failure"); },
  });
  await tick();
  assert.deepEqual(active, [false]);
  window.dispatchEvent(new Event("focus"));
  await tick();
  assert.deepEqual(active, [false, false]);
  stop();
});
