import assert from "node:assert/strict";
import test from "node:test";
import { createMessagingController } from "./messaging-intent.ts";
import { MessagingRequestError, type MessagingIntent, type MessagingProblem, type MessagingReceipt, type MessagingTarget, type MessagingTransport } from "./messaging-transport.ts";

const ACTOR = "12672fa1-e9bf-4192-a5f5-159db712232f";
const OTHER = "e6e7879a-c751-4634-ad56-e09625deea23";
const CONVERSATION = "ff35eeb3-587a-4175-8a76-3002a6160183";
const reply: MessagingTarget = { kind: "reply", conversationId: CONVERSATION };
const receipt: MessagingReceipt = { kind: "reply", message: { id: "d23f8749-09bd-4c0c-807f-ed82d058a131", conversationId: CONVERSATION, senderId: ACTOR, body: "one message", createdAt: "2026-11-01T00:00:00.000Z" } };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(target = reply) {
  const calls: { intent: MessagingIntent; signal: AbortSignal }[] = [];
  let problem: MessagingProblem | null = null;
  let result = receipt;
  let blocked: ReturnType<typeof deferred<MessagingReceipt>> | null = null;
  let keys = 0;
  const transport: MessagingTransport = {
    async actor() { throw new Error("an intent must not silently rebind to the account behind new cookies"); },
    async submit(intent, signal) {
      calls.push({ intent, signal });
      if (blocked) return blocked.promise;
      if (problem) throw new MessagingRequestError(problem);
      return result;
    },
  };
  const controller = createMessagingController(target, { transport, mint: () => `intent-${++keys}` });
  return { controller, calls, fail: (value: MessagingProblem | null) => { problem = value; }, result: (value: MessagingReceipt) => { result = value; }, hold: () => { blocked = deferred<MessagingReceipt>(); return blocked; }, keys: () => keys };
}

test("the first intent pins actor, destination, canonical body and key before the write", async () => {
  const { controller, calls, hold, keys } = fixture();
  const blocked = hold();
  const operation = controller.attempt("  one message  ", ACTOR);
  const pending = controller.getSnapshot();
  assert.equal(pending.busy, true);
  assert.equal(pending.problem, null);
  assert.deepEqual(pending.intent, { target: reply, actorId: ACTOR, value: "one message", key: "intent-1", payload: '{"body":"one message"}' });
  assert.equal(keys(), 1);
  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].intent, pending.intent);
  blocked.resolve(receipt);
  assert.deepEqual(await operation, receipt);
  assert.deepEqual(controller.getSnapshot(), { busy: false, intent: null, problem: null });
});

test("a lost response retains the exact intent and a retry does not look up a new actor", async () => {
  const { controller, calls, fail, keys } = fixture();
  fail("unavailable");
  assert.equal(await controller.attempt("one message", ACTOR), null);
  const original = controller.getSnapshot().intent;
  assert.ok(original);
  assert.equal(controller.getSnapshot().problem, "unavailable");
  fail(null);
  assert.deepEqual(await controller.attempt("one message", ACTOR), receipt);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].intent, original);
  assert.equal(calls[0].intent, original);
  assert.equal(keys(), 1);
});

test("a changed draft cannot borrow the uncertain request's key or send a new intent", async () => {
  const { controller, calls, fail, keys } = fixture();
  fail("timeout");
  await controller.attempt("one message", ACTOR);
  const original = controller.getSnapshot().intent;
  await controller.attempt("different words", ACTOR);
  assert.equal(controller.getSnapshot().problem, "changed");
  assert.equal(controller.getSnapshot().intent, original);
  assert.equal(calls.length, 1);
  assert.equal(keys(), 1);
  assert.equal(original?.value, "one message", "the original text can be explicitly restored");
  fail(null);
  await controller.attempt(original!.value, ACTOR);
  assert.equal(calls[1].intent, original);
});

test("a changed view identity cannot replay or reveal a newly rebound intent", async () => {
  const { controller, calls, fail, keys } = fixture();
  fail("unavailable");
  await controller.attempt("one message", ACTOR);
  const original = controller.getSnapshot().intent;
  await controller.attempt("one message", OTHER);
  assert.equal(controller.getSnapshot().problem, "account-changed");
  assert.equal(controller.getSnapshot().intent, original);
  assert.equal(original?.actorId, ACTOR);
  assert.equal(calls.length, 1);
  assert.equal(keys(), 1);
  fail(null);
  await controller.attempt("one message", ACTOR);
  assert.equal(calls[1].intent, original);
});

test("an account-change answer keeps the original request for an explicit same-account retry", async () => {
  const { controller, calls, fail, keys } = fixture();
  fail("account-changed");
  await controller.attempt("one message", ACTOR);
  const original = controller.getSnapshot().intent;
  fail(null);
  await controller.attempt("one message", ACTOR);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].intent, original);
  assert.equal(keys(), 1);
  assert.equal(controller.getSnapshot().intent, null);
});

test("unknown, signed-out, malformed, timed-out and conflicting outcomes never retire a key", async () => {
  for (const problem of ["unavailable", "unauthenticated", "invalid-response", "timeout", "conflict", "invalid", "missing", "cancelled"] as const) {
    const { controller, calls, fail, keys } = fixture();
    fail(problem);
    await controller.attempt("one message", ACTOR);
    const original = controller.getSnapshot().intent;
    assert.ok(original, problem);
    assert.equal(controller.getSnapshot().busy, false, problem);
    assert.equal(controller.getSnapshot().problem, problem);
    fail(null);
    await controller.attempt("one message", ACTOR);
    assert.equal(calls[1].intent, original, problem);
    assert.equal(keys(), 1, problem);
    assert.equal(controller.getSnapshot().intent, null, problem);
  }
});

test("only an explicit discard can retire an unconfirmed request before acknowledgment", async () => {
  const { controller, calls, fail, keys } = fixture();
  fail("conflict");
  await controller.attempt("one message", ACTOR);
  const original = controller.getSnapshot().intent;
  controller.dismissProblem();
  assert.equal(controller.getSnapshot().problem, null);
  assert.equal(controller.getSnapshot().intent, original, "editing does not quietly abandon the request");
  assert.equal(controller.discard(), true);
  assert.deepEqual(controller.getSnapshot(), { busy: false, intent: null, problem: null });
  fail(null);
  await controller.attempt("a new intent", OTHER);
  assert.equal(keys(), 2);
  assert.equal(calls[1].intent.key, "intent-2");
  assert.equal(calls[1].intent.actorId, OTHER);
  assert.equal(calls[1].intent.value, "a new intent");
});

test("a confirmed send retires its key and a second user intent gets a new key", async () => {
  const { controller, calls, keys } = fixture();
  await controller.attempt("one message", ACTOR);
  await controller.attempt("one message", ACTOR);
  assert.equal(keys(), 2);
  assert.notEqual(calls[0].intent.key, calls[1].intent.key);
  assert.notEqual(calls[0].intent, calls[1].intent);
  assert.equal(controller.getSnapshot().intent, null);
});

test("rapid duplicate submits share one in-flight operation, including its returned result", async () => {
  const { controller, calls, hold, keys } = fixture();
  const blocked = hold();
  const first = controller.attempt("one message", ACTOR);
  const second = controller.attempt("different body during a click race", OTHER);
  assert.equal(first, second);
  assert.equal(controller.discard(), false, "an in-flight intent cannot be replaced");
  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.equal(keys(), 1);
  blocked.resolve(receipt);
  assert.equal(await first, receipt);
  assert.equal(await second, receipt);
  assert.equal(controller.getSnapshot().busy, false);
});

test("cancelling an in-flight request aborts it without claiming that the write failed", async () => {
  const { controller, calls, hold } = fixture();
  const blocked = hold();
  const operation = controller.attempt("one message", ACTOR);
  await Promise.resolve();
  const original = controller.getSnapshot().intent;
  controller.cancel();
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(await operation, null, "even a transport ignoring AbortSignal cannot keep the view waiting");
  assert.equal(controller.getSnapshot().intent, original);
  assert.equal(controller.getSnapshot().busy, false);
  blocked.resolve(receipt);
  await Promise.resolve();
  assert.equal(controller.getSnapshot().intent, original, "a late acknowledgment cannot clear the retry identity");
});

test("late success after cancellation cannot settle a newer retry", async () => {
  const { controller, calls, hold } = fixture();
  const old = hold();
  const first = controller.attempt("one message", ACTOR);
  await Promise.resolve();
  const intent = controller.getSnapshot().intent;
  controller.cancel();
  const next = hold();
  const second = controller.attempt("one message", ACTOR);
  await Promise.resolve();
  old.resolve(receipt);
  assert.equal(await first, null);
  assert.equal(controller.getSnapshot().busy, true);
  assert.equal(controller.getSnapshot().intent, intent);
  assert.equal(calls[1].intent, intent);
  next.resolve(receipt);
  assert.equal(await second, receipt);
  assert.equal(controller.getSnapshot().intent, null);
});

test("late rejection after cancellation cannot replace the active retry's error or result", async () => {
  const { controller, hold } = fixture();
  const old = hold();
  const first = controller.attempt("one message", ACTOR);
  await Promise.resolve();
  controller.cancel();
  const next = hold();
  const second = controller.attempt("one message", ACTOR);
  await Promise.resolve();
  old.reject(new MessagingRequestError("unauthenticated"));
  assert.equal(await first, null);
  assert.equal(controller.getSnapshot().busy, true);
  assert.equal(controller.getSnapshot().problem, null);
  next.resolve(receipt);
  await second;
  assert.equal(controller.getSnapshot().problem, null);
});

test("identity must be verified before a first attempt; the controller never sends anonymous writes", async () => {
  for (const actor of ["", " ", " padded", "x".repeat(301), "with\u0000control"]) {
    const { controller, calls, keys } = fixture();
    await controller.attempt("one message", actor);
    assert.equal(controller.getSnapshot().problem, "unverified", JSON.stringify(actor));
    assert.equal(controller.getSnapshot().intent, null);
    assert.equal(calls.length, 0);
    assert.equal(keys(), 0);
  }
});

test("input validation does not allocate keys or erase an existing uncertain intent", async () => {
  const { controller, calls, fail, keys } = fixture();
  for (const value of ["", "  ", "x".repeat(20_001)]) await controller.attempt(value, ACTOR);
  assert.equal(calls.length, 0);
  assert.equal(keys(), 0);
  assert.equal(controller.getSnapshot().problem, "too-long");
  fail("unavailable");
  await controller.attempt("one message", ACTOR);
  const intent = controller.getSnapshot().intent;
  await controller.attempt("x".repeat(20_001), ACTOR);
  assert.equal(controller.getSnapshot().intent, intent);
  assert.equal(controller.getSnapshot().problem, "too-long");
  assert.equal(keys(), 1);
});

test("the exact legal message bound accepts Chinese and UTF-16 without byte truncation", async () => {
  const { controller, calls } = fixture();
  await controller.attempt("读".repeat(20_000), ACTOR);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].intent.value.length, 20_000);
  assert.deepEqual(JSON.parse(calls[0].intent.payload!), { body: "读".repeat(20_000) });
  await controller.attempt("🙂".repeat(10_000), ACTOR);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].intent.value.length, 20_000);
});

test("unavailable secure randomness fails visibly before any mutation", async () => {
  let calls = 0;
  const controller = createMessagingController(reply, {
    mint: () => { throw new Error("random source failure with private context"); },
    transport: { async actor() { return ACTOR; }, async submit() { calls++; return receipt; } },
  });
  await controller.attempt("one message", ACTOR);
  assert.equal(controller.getSnapshot().problem, "unavailable");
  assert.equal(controller.getSnapshot().intent, null);
  assert.equal(calls, 0);
});

test("a bad key supplier cannot install an unusable pending request", async () => {
  for (const key of ["", " ", "x".repeat(301)]) {
    let calls = 0;
    const controller = createMessagingController(reply, {
      mint: () => key,
      transport: { async actor() { return ACTOR; }, async submit() { calls++; return receipt; } },
    });
    await controller.attempt("one message", ACTOR);
    assert.equal(controller.getSnapshot().problem, "unavailable");
    assert.equal(controller.getSnapshot().intent, null);
    assert.equal(calls, 0);
  }
});

test("conversation creation canonicalizes the recipient and never inserts the actor into the request body", async () => {
  const { controller, calls, result } = fixture({ kind: "start" });
  result({ kind: "start", conversationId: CONVERSATION });
  assert.deepEqual(await controller.attempt(` ${OTHER} `, ACTOR), { kind: "start", conversationId: CONVERSATION });
  assert.equal(calls[0].intent.actorId, ACTOR);
  assert.equal(calls[0].intent.payload, JSON.stringify({ participantIds: [OTHER] }));
  assert.equal(calls[0].intent.key, "intent-1");
  assert.equal(controller.getSnapshot().intent, null);
});

test("self, blank and oversized recipients cannot become conversation intents", async () => {
  const { controller, calls, keys } = fixture({ kind: "start" });
  for (const value of [ACTOR, "", " ", "x".repeat(301), "with\u0000control"]) {
    await controller.attempt(value, ACTOR);
    assert.equal(controller.getSnapshot().problem, "invalid", JSON.stringify(value));
    assert.equal(controller.getSnapshot().intent, null);
  }
  assert.equal(calls.length, 0);
  assert.equal(keys(), 0);
});

test("read-all is explicit and bodyless; it does not mint an idempotency key or auto-retry", async () => {
  const { controller, calls, fail, result, keys } = fixture({ kind: "read", conversationId: CONVERSATION });
  result({ kind: "read" });
  fail("unavailable");
  await controller.attempt("", ACTOR);
  assert.equal(calls.length, 1);
  const original = controller.getSnapshot().intent;
  assert.equal(original?.key, null);
  assert.equal(original?.payload, undefined);
  assert.equal(original?.actorId, ACTOR);
  assert.equal(keys(), 0);
  fail(null);
  assert.equal(calls.length, 1, "recovery itself never replays a mark-all");
  await controller.attempt("", OTHER);
  assert.equal(controller.getSnapshot().problem, "account-changed");
  assert.equal(calls.length, 1);
  assert.deepEqual(await controller.attempt("", ACTOR), { kind: "read" });
  assert.equal(calls[1].intent, original);
});

test("an invalid conversation cannot become a path, even with a valid actor", async () => {
  for (const kind of ["reply", "read"] as const) {
    const { controller, calls, keys } = fixture({ kind, conversationId: "../another-route" });
    await controller.attempt(kind === "read" ? "" : "one message", ACTOR);
    assert.equal(controller.getSnapshot().problem, "invalid");
    assert.equal(calls.length, 0);
    assert.equal(keys(), 0);
  }
});

test("the destination and snapshots are immutable and isolated from callers", async () => {
  const target = { kind: "reply" as const, conversationId: CONVERSATION };
  const { controller, hold, calls } = fixture(target);
  target.conversationId = "d23f8749-09bd-4c0c-807f-ed82d058a131";
  const blocked = hold();
  const operation = controller.attempt("one message", ACTOR);
  const snapshot = controller.getSnapshot();
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.intent), true);
  assert.equal(Object.isFrozen(snapshot.intent?.target), true);
  await Promise.resolve();
  assert.deepEqual(calls[0].intent.target, reply);
  assert.throws(() => Object.assign(snapshot.intent!, { actorId: OTHER }), TypeError);
  blocked.resolve(receipt);
  await operation;
});

test("SSR sees no private intent and independent controllers never share pending data", async () => {
  const first = fixture();
  const second = fixture();
  first.fail("unavailable");
  await first.controller.attempt("one message", ACTOR);
  assert.ok(first.controller.getSnapshot().intent);
  assert.deepEqual(first.controller.getServerSnapshot(), { busy: false, intent: null, problem: null });
  assert.deepEqual(second.controller.getSnapshot(), { busy: false, intent: null, problem: null });
  assert.equal(second.calls.length, 0);
});

test("subscriptions observe pending-before-send and acknowledged completion, and cleanup detaches them", async () => {
  const { controller, hold } = fixture();
  const events: { busy: boolean; pending: boolean }[] = [];
  const unsubscribe = controller.subscribe(() => events.push({ busy: controller.getSnapshot().busy, pending: controller.getSnapshot().intent !== null }));
  const blocked = hold();
  const operation = controller.attempt("one message", ACTOR);
  assert.deepEqual(events[0], { busy: true, pending: true });
  blocked.resolve(receipt);
  await operation;
  assert.deepEqual(events.at(-1), { busy: false, pending: false });
  unsubscribe();
  unsubscribe();
  const count = events.length;
  controller.dismissProblem();
  controller.discard();
  assert.equal(events.length, count);
});
