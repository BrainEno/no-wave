import assert from "node:assert/strict";
import test from "node:test";
import { bindMessagingPrivacyRecovery } from "./messaging-privacy-recovery.ts";
import { createMessagingPrivacy } from "./messaging-privacy.ts";
import { MessagingRequestError } from "./messaging-transport.ts";

function fixture(initiallyVisible = true) {
  const window = new EventTarget(), document = new EventTarget();
  let visible = initiallyVisible;
  const calls: string[] = [];
  const cleanup = bindMessagingPrivacyRecovery({
    async check() { calls.push("check"); }, conceal() { calls.push("conceal"); }, cancel() { calls.push("cancel"); },
  }, { window, document, visible: () => visible });
  return { window, document, calls, cleanup, visible: (value: boolean) => { visible = value; } };
}
function restored(): Event {
  const event = new Event("pageshow");
  Object.defineProperty(event, "persisted", { value: true });
  return event;
}

test("a visible mounted page starts one private identity check without inventing a recovery boundary", () => {
  const f = fixture();
  assert.deepEqual(f.calls, ["check"]);
  f.window.dispatchEvent(new Event("pageshow"));
  assert.deepEqual(f.calls, ["check"], "initial pageshow cannot silently retry a failed first identity lookup");
  f.cleanup();
});

test("a hidden initial document never starts private network work until it is visible", async () => {
  const f = fixture(false);
  assert.deepEqual(f.calls, ["conceal"]);
  f.window.dispatchEvent(new Event("online"));
  await Promise.resolve();
  assert.deepEqual(f.calls, ["conceal", "conceal"]);
  f.visible(true);
  f.document.dispatchEvent(new Event("visibilitychange"));
  await Promise.resolve();
  assert.deepEqual(f.calls.slice(-2), ["conceal", "check"]);
  f.cleanup();
});

test("focus conceals synchronously before scheduling a new account verification", async () => {
  const f = fixture();
  f.window.dispatchEvent(new Event("focus"));
  assert.deepEqual(f.calls, ["check", "conceal"]);
  await Promise.resolve();
  assert.deepEqual(f.calls, ["check", "conceal", "check"]);
  f.cleanup();
});

test("focus, online and visible events in one burst coalesce identity reads but each revoke old leases immediately", async () => {
  const f = fixture();
  f.window.dispatchEvent(new Event("focus"));
  f.window.dispatchEvent(new Event("online"));
  f.document.dispatchEvent(new Event("visibilitychange"));
  assert.deepEqual(f.calls, ["check", "conceal", "conceal", "conceal"]);
  await Promise.resolve();
  assert.equal(f.calls.filter((call) => call === "check").length, 2);
  f.cleanup();
});

test("pagehide invalidates even when visibilityState has not caught up, and online cannot revive that page", async () => {
  const f = fixture();
  f.window.dispatchEvent(new Event("pagehide"));
  f.window.dispatchEvent(new Event("online"));
  await Promise.resolve();
  assert.deepEqual(f.calls, ["check", "conceal", "conceal"]);
  f.window.dispatchEvent(restored());
  await Promise.resolve();
  assert.deepEqual(f.calls.slice(-2), ["conceal", "check"]);
  f.cleanup();
});

test("a persisted pageshow revalidates even without a prior pagehide observed by this listener", async () => {
  const f = fixture();
  f.window.dispatchEvent(restored());
  assert.deepEqual(f.calls, ["check", "conceal"]);
  await Promise.resolve();
  assert.deepEqual(f.calls, ["check", "conceal", "check"]);
  f.cleanup();
});

test("becoming hidden during a queued focus prevents the queued request instead of reading new cookies in background", async () => {
  const f = fixture();
  f.window.dispatchEvent(new Event("focus"));
  f.visible(false);
  f.document.dispatchEvent(new Event("visibilitychange"));
  await Promise.resolve();
  assert.equal(f.calls.filter((call) => call === "check").length, 1);
  f.visible(true);
  f.document.dispatchEvent(new Event("visibilitychange"));
  await Promise.resolve();
  assert.equal(f.calls.filter((call) => call === "check").length, 2);
  f.cleanup();
});

test("cleanup removes all listeners and prevents a queued recovery from starting after unmount", async () => {
  const f = fixture();
  f.window.dispatchEvent(new Event("focus"));
  f.cleanup();
  const count = f.calls.length;
  for (const type of ["focus", "online", "pagehide", "pageshow"]) f.window.dispatchEvent(new Event(type));
  f.document.dispatchEvent(new Event("visibilitychange"));
  await Promise.resolve();
  assert.equal(f.calls.length, count);
  assert.equal(f.calls.at(-1), "cancel");
  assert.equal(f.calls.filter((call) => call === "check").length, 1);
});

test("a failing visibility capability defaults to concealed rather than assuming the private page is visible", async () => {
  const calls: string[] = [];
  const window = new EventTarget(), document = new EventTarget();
  const cleanup = bindMessagingPrivacyRecovery({ async check() { calls.push("check"); }, conceal() { calls.push("conceal"); }, cancel() {} }, {
    window, document, visible() { throw new Error("blocked capability"); },
  });
  window.dispatchEvent(new Event("focus"));
  await Promise.resolve();
  assert.deepEqual(calls, ["conceal", "conceal"]);
  cleanup();
});

test("real read leases are revoked on pagehide and a replacement identity never reopens private display", async () => {
  const window = new EventTarget(), document = new EventTarget();
  let actor = "original-reader";
  const privacy = createMessagingPrivacy(async () => actor);
  const cleanup = bindMessagingPrivacyRecovery(privacy, { window, document, visible: () => true });
  await privacy.check();
  const old = privacy.beginRead()!;
  window.dispatchEvent(new Event("pagehide"));
  assert.equal(old.current(), false);
  assert.equal(old.signal.aborted, true);
  actor = "replacement-reader";
  window.dispatchEvent(restored());
  await Promise.resolve();
  await privacy.check();
  assert.equal(privacy.getSnapshot().status, "changed");
  assert.equal(privacy.beginRead(), null);
  cleanup();
});

test("initial read-only fallback is preserved, but online recovery cannot use it after identity becomes uncertain again", async () => {
  const window = new EventTarget(), document = new EventTarget();
  const privacy = createMessagingPrivacy(async () => { throw new MessagingRequestError("invalid-response"); });
  const cleanup = bindMessagingPrivacyRecovery(privacy, { window, document, visible: () => true });
  await privacy.check();
  assert.equal(privacy.getSnapshot().readable, true);
  const initial = privacy.beginRead()!;
  window.dispatchEvent(new Event("online"));
  assert.equal(initial.current(), false);
  await Promise.resolve();
  await privacy.check();
  assert.equal(privacy.getSnapshot().readable, false);
  assert.equal(privacy.beginRead(), null);
  cleanup();
});

test("the UI flush adapter encloses event concealment, not effect setup or later verification", async () => {
  const window = new EventTarget(), document = new EventTarget();
  const calls: string[] = [];
  const cleanup = bindMessagingPrivacyRecovery({
    async check() { calls.push("check"); }, conceal() { calls.push("conceal"); }, cancel() { calls.push("cancel"); },
  }, { window, document, visible: () => true, flush(work) { calls.push("flush-start"); work(); calls.push("flush-end"); } });
  assert.deepEqual(calls, ["check"], "effect initialization must not call React flushSync");
  window.dispatchEvent(new Event("pagehide"));
  assert.deepEqual(calls.slice(-3), ["flush-start", "conceal", "flush-end"]);
  window.dispatchEvent(restored());
  assert.deepEqual(calls.slice(-3), ["flush-start", "conceal", "flush-end"]);
  await Promise.resolve();
  assert.equal(calls.at(-1), "check");
  cleanup();
  const count = calls.length;
  window.dispatchEvent(new Event("focus"));
  assert.equal(calls.length, count);
});
