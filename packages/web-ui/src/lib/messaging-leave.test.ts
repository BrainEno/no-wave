import assert from "node:assert/strict";
import test from "node:test";
import { createMessagingController } from "./messaging-intent.ts";
import { bindMessagingUnload } from "./messaging-leave.ts";
import { MessagingRequestError, type MessagingReceipt } from "./messaging-transport.ts";

const actor = "31a46c14-5e70-40ac-a253-c57560aebdea";
const target = { kind: "start" as const };
const recipient = "278c4a27-0186-48d4-8f23-a5758a43b012";
const receipt: MessagingReceipt = { kind: "start", conversationId: "67742ffa-b39a-4f5e-8a55-cb3b157b384f" };
function unload(events: EventTarget): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  events.dispatchEvent(event);
  return event.defaultPrevented;
}

test("unload is unrestricted before a user intent and after an acknowledged write", async () => {
  const events = new EventTarget();
  const controller = createMessagingController(target, { transport: { async actor() { return actor; }, async submit() { return receipt; } } });
  const cleanup = bindMessagingUnload(controller, events);
  assert.equal(unload(events), false);
  await controller.attempt(recipient, actor);
  assert.equal(unload(events), false);
  cleanup();
});

test("a submit followed by unload in the same tick sees the pending request", async () => {
  const events = new EventTarget();
  const controller = createMessagingController(target, { transport: { async actor() { return actor; }, async submit() { return new Promise<MessagingReceipt>(() => {}); } } });
  const cleanup = bindMessagingUnload(controller, events);
  const operation = controller.attempt(recipient, actor);
  assert.equal(unload(events), true, "the guard reads live state, not the previous React render");
  assert.equal(controller.discard(), false);
  assert.equal(unload(events), true);
  controller.cancel();
  await operation;
  assert.equal(unload(events), true, "aborting a request does not prove that it never committed");
  cleanup();
});

test("a failed response and a changed draft preserve the warning until explicit discard", async () => {
  const events = new EventTarget();
  const controller = createMessagingController(target, { transport: { async actor() { return actor; }, async submit() { throw new MessagingRequestError("unavailable"); } } });
  const cleanup = bindMessagingUnload(controller, events);
  await controller.attempt(recipient, actor);
  assert.equal(unload(events), true);
  controller.dismissProblem();
  await controller.attempt("a-different-recipient", actor);
  assert.equal(controller.getSnapshot().problem, "changed");
  assert.equal(unload(events), true);
  assert.equal(controller.discard(), true);
  assert.equal(unload(events), false);
  cleanup();
});

test("same-key recovery after a lost response removes the warning only on acknowledgment", async () => {
  const events = new EventTarget();
  let offline = true;
  const keys: (string | null)[] = [];
  const controller = createMessagingController(target, { transport: { async actor() { return actor; }, async submit(intent) {
    keys.push(intent.key);
    if (offline) throw new MessagingRequestError("timeout");
    return receipt;
  } } });
  const cleanup = bindMessagingUnload(controller, events);
  await controller.attempt(recipient, actor);
  assert.equal(unload(events), true);
  offline = false;
  await controller.attempt(recipient, actor);
  assert.equal(keys.length, 2);
  assert.equal(keys[1], keys[0]);
  assert.equal(unload(events), false);
  cleanup();
});

test("cleanup detaches the warning and is idempotent without discarding the pending identity", async () => {
  const events = new EventTarget();
  const controller = createMessagingController(target, { transport: { async actor() { return actor; }, async submit() { throw new MessagingRequestError("unavailable"); } } });
  const cleanup = bindMessagingUnload(controller, events);
  await controller.attempt(recipient, actor);
  const original = controller.getSnapshot().intent;
  assert.equal(unload(events), true);
  cleanup();
  cleanup();
  assert.equal(unload(events), false);
  assert.equal(controller.getSnapshot().intent, original);
  const rebound = bindMessagingUnload(controller, events);
  assert.equal(unload(events), true);
  rebound();
});

test("focus, connectivity, visibility and pageshow events never replay an uncertain mutation", async () => {
  const events = new EventTarget();
  let calls = 0;
  const controller = createMessagingController(target, { transport: { async actor() { return actor; }, async submit() { calls++; throw new MessagingRequestError("unavailable"); } } });
  const cleanup = bindMessagingUnload(controller, events);
  await controller.attempt(recipient, actor);
  for (const type of ["focus", "online", "pageshow", "visibilitychange"]) events.dispatchEvent(new Event(type));
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(unload(events), true);
  cleanup();
});
