import assert from "node:assert/strict";
import test from "node:test";
import { bindCatalogueRecovery } from "./authoring-catalogue-recovery.ts";

test("catalogue recovery coalesces focus/online/visibility, clears the private view synchronously on pagehide and only reconnects a persisted pageshow", () => {
  const window = new EventTarget(), document = new EventTarget();
  let visible = true;
  const calls: string[] = [];
  const stop = bindCatalogueRecovery({ verifyAccount: async () => { calls.push("verify"); }, connect: async () => { calls.push("connect"); } }, {
    window, document, visible: () => visible,
    flush: callback => { calls.push("flush-start"); callback(); calls.push("flush-end"); },
    suspend: () => calls.push("clear-private-view"),
  });
  window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("online")); document.dispatchEvent(new Event("visibilitychange"));
  assert.deepEqual(calls, ["verify"]);
  visible = false; document.dispatchEvent(new Event("visibilitychange"));
  assert.deepEqual(calls, ["verify"]);
  window.dispatchEvent(new Event("pagehide"));
  assert.deepEqual(calls.slice(-3), ["flush-start", "clear-private-view", "flush-end"]);
  visible = true; window.dispatchEvent(new Event("pageshow"));
  assert.equal(calls.includes("connect"), false, "ordinary initial pageshow must not duplicate mount's connect");
  const persisted = new Event("pageshow"); Object.defineProperty(persisted, "persisted", { value: true });
  window.dispatchEvent(persisted); assert.equal(calls.at(-1), "connect");
  stop(); const count = calls.length;
  for (const event of ["focus", "online", "pagehide", "pageshow"]) window.dispatchEvent(new Event(event));
  document.dispatchEvent(new Event("visibilitychange")); assert.equal(calls.length, count);
});

test("a completed identity probe must not mask a fast subsequent account switch inside the same second", async () => {
  const window = new EventTarget(), document = new EventTarget(); let calls = 0;
  const stop = bindCatalogueRecovery({ verifyAccount: async () => { calls++; }, connect: async () => {} }, {
    window, document, visible: () => true, flush: callback => callback(), suspend: () => {},
  });
  window.dispatchEvent(new Event("focus"));
  await new Promise(resolve => setImmediate(resolve));
  window.dispatchEvent(new Event("focus"));
  assert.equal(calls, 2);
  stop();
});
