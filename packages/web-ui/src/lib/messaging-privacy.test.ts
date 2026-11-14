import assert from "node:assert/strict";
import test from "node:test";
import { createMessagingPrivacy, bindMessagingPrivacyWrite } from "./messaging-privacy.ts";
import { createMessagingController } from "./messaging-intent.ts";
import { MessagingRequestError, type MessagingReceipt } from "./messaging-transport.ts";

const ACTOR = "54e4e0db-3f69-458b-8eee-e58ad4755f31";
const OTHER = "b3e3bac3-341f-4d64-a247-38069ad34123";
const CONVERSATION = "76e59a17-10b2-4272-9089-e2a475d7aa66";
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { resolve, reject, promise };
}
function fixture() {
  const calls: { signal: AbortSignal; result: ReturnType<typeof deferred<string>> }[] = [];
  const privacy = createMessagingPrivacy(async (signal) => {
    const result = deferred<string>();
    calls.push({ signal, result });
    return result.promise;
  });
  async function identify(id = ACTOR) {
    const operation = privacy.check();
    await Promise.resolve();
    calls.at(-1)!.result.resolve(id);
    await operation;
  }
  async function fail(code: "unavailable" | "unauthenticated" | "invalid-response" | "timeout" = "unavailable") {
    const operation = privacy.check();
    await Promise.resolve();
    calls.at(-1)!.result.reject(new MessagingRequestError(code));
    await operation;
  }
  return { privacy, calls, identify, fail };
}

test("private reads and writes cannot start while the first identity check is still pending", async () => {
  const { privacy, calls } = fixture();
  assert.equal(privacy.beginRead(), null);
  assert.equal(privacy.currentId(), "");
  const operation = privacy.check();
  const same = privacy.check();
  assert.equal(operation, same, "concurrent identity checks share one operation");
  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.equal(privacy.getSnapshot().readable, false);
  calls[0].result.resolve(ACTOR);
  await operation;
  assert.equal(privacy.currentId(), ACTOR);
});

test("a successful identity pins the account and stamps every read with a fresh epoch", async () => {
  const { privacy, identify } = fixture();
  await identify();
  const lease = privacy.beginRead();
  assert.ok(lease);
  assert.equal(lease.actorId, ACTOR);
  assert.equal(lease.epoch, privacy.getSnapshot().epoch);
  assert.equal(lease.headers["x-expected-messaging-actor"], ACTOR);
  assert.equal(lease.headers.accept, "application/json");
  assert.equal(lease.current(), true);
  assert.equal(privacy.getSnapshot().status, "ready");
  lease.finish();
  assert.equal(lease.current(), false);
});

test("a first temporary identity failure preserves the existing read-only fallback, never mutation identity", async () => {
  const { privacy, fail } = fixture();
  await fail("invalid-response");
  assert.equal(privacy.getSnapshot().status, "failed");
  assert.equal(privacy.getSnapshot().readable, true);
  assert.equal(privacy.currentId(), "");
  const lease = privacy.beginRead();
  assert.ok(lease);
  assert.equal(lease.actorId, "");
  assert.deepEqual(lease.headers, { accept: "application/json" });
  lease.finish();
});

test("a first definitive 401 is signed-out, not permission to read a blank-account inbox", async () => {
  const { privacy, fail } = fixture();
  await fail("unauthenticated");
  assert.equal(privacy.getSnapshot().status, "signed-out");
  assert.equal(privacy.getSnapshot().readable, false);
  assert.equal(privacy.beginRead(), null);
  assert.equal(privacy.currentId(), "");
});

test("identity retry invalidates an initial fallback response before it can be rebound", async () => {
  const { privacy, fail, identify } = fixture();
  await fail();
  const old = privacy.beginRead()!;
  await identify();
  assert.equal(old.signal.aborted, true);
  assert.equal(old.current(), false);
  const fresh = privacy.beginRead()!;
  assert.equal(fresh.actorId, ACTOR);
  assert.notEqual(fresh.epoch, old.epoch);
});

test("conceal synchronously hides data, removes the mutation identity and aborts every outstanding read", async () => {
  const { privacy, identify } = fixture();
  await identify();
  const inbox = privacy.beginRead()!;
  const history = privacy.beginRead()!;
  const epoch = privacy.getSnapshot().epoch;
  privacy.conceal();
  assert.equal(privacy.getSnapshot().status, "hidden");
  assert.equal(privacy.getSnapshot().readable, false);
  assert.ok(privacy.getSnapshot().epoch > epoch);
  assert.equal(privacy.currentId(), "");
  for (const lease of [inbox, history]) {
    assert.equal(lease.signal.aborted, true);
    assert.equal(lease.current(), false);
  }
  assert.equal(privacy.beginRead(), null);
});

test("a read that ignores abort cannot become current again after same-account recovery", async () => {
  const { privacy, identify } = fixture();
  await identify();
  const before = privacy.beginRead()!;
  privacy.conceal();
  await identify();
  assert.equal(before.current(), false);
  assert.equal(privacy.accepts(before.epoch), false);
  const after = privacy.beginRead()!;
  assert.equal(after.current(), true);
  assert.equal(privacy.accepts(after.epoch), true);
  assert.notEqual(after.epoch, before.epoch);
});

test("an account replacement cannot silently re-pin the page even when it shares conversation membership", async () => {
  const { privacy, identify } = fixture();
  await identify();
  privacy.conceal();
  await identify(OTHER);
  assert.equal(privacy.getSnapshot().status, "changed");
  assert.equal(privacy.getSnapshot().id, "");
  assert.equal(privacy.getSnapshot().readable, false);
  assert.equal(privacy.currentId(), "");
  assert.equal(privacy.beginRead(), null);
  await identify(OTHER);
  assert.equal(privacy.getSnapshot().status, "changed", "repeated retries do not adopt replacement cookies");
});

test("explicitly returning to the original account recovers fresh reads without changing the pinned owner", async () => {
  const { privacy, identify } = fixture();
  await identify();
  privacy.conceal();
  await identify(OTHER);
  const changedEpoch = privacy.getSnapshot().epoch;
  await identify();
  assert.equal(privacy.getSnapshot().status, "ready");
  assert.equal(privacy.currentId(), ACTOR);
  assert.ok(privacy.getSnapshot().epoch > changedEpoch);
  assert.equal(privacy.beginRead()!.actorId, ACTOR);
});

test("a recovered identity failure must not revive the initial read-only fallback", async () => {
  for (const code of ["unavailable", "timeout", "invalid-response"] as const) {
    const { privacy, identify, fail } = fixture();
    await identify();
    privacy.conceal();
    await fail(code);
    assert.equal(privacy.getSnapshot().status, "failed", code);
    assert.equal(privacy.getSnapshot().readable, false, code);
    assert.equal(privacy.beginRead(), null, code);
    assert.equal(privacy.currentId(), "", code);
  }
});

test("an unknown initial account cannot use fallback after a page privacy boundary either", async () => {
  const { privacy, fail } = fixture();
  privacy.conceal();
  await fail();
  assert.equal(privacy.getSnapshot().readable, false);
  assert.equal(privacy.beginRead(), null);
});

test("a canceled identity request resolves even if its transport ignores abort", async () => {
  const { privacy, calls } = fixture();
  const pending = privacy.check();
  await Promise.resolve();
  privacy.conceal();
  await pending;
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(privacy.getSnapshot().status, "hidden");
  calls[0].result.resolve(ACTOR);
  await Promise.resolve();
  assert.equal(privacy.currentId(), "");
});

test("late success from an obsolete identity lookup cannot settle a newer account check", async () => {
  const { privacy, calls } = fixture();
  const old = privacy.check();
  await Promise.resolve();
  privacy.conceal();
  const fresh = privacy.check();
  await Promise.resolve();
  calls[0].result.resolve(OTHER);
  await old;
  assert.equal(privacy.getSnapshot().status, "loading");
  assert.equal(privacy.currentId(), "");
  calls[1].result.resolve(ACTOR);
  await fresh;
  assert.equal(privacy.currentId(), ACTOR);
});

test("late failure from an obsolete identity lookup cannot sign out a newly verified page", async () => {
  const { privacy, calls, identify } = fixture();
  const old = privacy.check();
  await Promise.resolve();
  privacy.conceal();
  await identify();
  calls[0].result.reject(new MessagingRequestError("unauthenticated"));
  await old;
  assert.equal(privacy.getSnapshot().status, "ready");
  assert.equal(privacy.currentId(), ACTOR);
});

test("malformed identities cannot pin a page or throw private transport details into state", async () => {
  for (const invalid of ["", " padded", "x".repeat(301), "with\u0000control", "\ud800"]) {
    const { privacy, identify } = fixture();
    await identify(invalid);
    assert.equal(privacy.getSnapshot().status, "failed");
    assert.equal(privacy.currentId(), "");
    assert.equal(JSON.stringify(privacy.getSnapshot()).includes(invalid), invalid === "");
  }
});

test("encoded actor headers preserve Unicode and percent/comma/space identities exactly", async () => {
  for (const id of ["讀者甲", "reader name", "reader,name", "reader%2Fname"]) {
    const { privacy, identify } = fixture();
    await identify(id);
    const lease = privacy.beginRead()!;
    assert.equal(lease.actorId, id);
    assert.equal(lease.headers["x-expected-messaging-actor"], encodeURIComponent(id));
    assert.equal(Object.isFrozen(lease.headers), true);
  }
});

test("a current private 401 conceals all page reads; it is never converted into an empty successful list", async () => {
  const { privacy, identify } = fixture();
  await identify();
  const inbox = privacy.beginRead()!;
  const history = privacy.beginRead()!;
  inbox.fail("unauthenticated");
  assert.equal(privacy.getSnapshot().status, "signed-out");
  assert.equal(privacy.getSnapshot().readable, false);
  assert.equal(history.current(), false);
  assert.equal(history.signal.aborted, true);
});

test("a current proxy account-change response revokes display even before a focus event", async () => {
  const { privacy, identify } = fixture();
  await identify();
  const lease = privacy.beginRead()!;
  lease.fail("account-changed");
  assert.equal(privacy.getSnapshot().status, "changed");
  assert.equal(privacy.currentId(), "");
  assert.equal(lease.current(), false);
  assert.equal(privacy.beginRead(), null);
});

test("stale or released leases cannot revoke a newer verified page", async () => {
  const { privacy, identify } = fixture();
  await identify();
  const old = privacy.beginRead()!;
  privacy.conceal();
  await identify();
  old.fail("unauthenticated");
  const finished = privacy.beginRead()!;
  finished.finish();
  finished.fail("account-changed");
  assert.equal(privacy.getSnapshot().status, "ready");
  assert.equal(privacy.currentId(), ACTOR);
});

test("ordinary missing and transient page failures do not pretend that the account changed", async () => {
  const { privacy, identify } = fixture();
  await identify();
  for (const problem of ["missing", "unavailable", "timeout", "invalid-response"] as const) {
    const lease = privacy.beginRead()!;
    lease.fail(problem);
    assert.equal(privacy.getSnapshot().status, "ready");
    assert.equal(lease.current(), true);
    lease.finish();
  }
});

test("finishing a lease is idempotent and does not abort unrelated reads", async () => {
  const { privacy, identify } = fixture();
  await identify();
  const finished = privacy.beginRead()!;
  const active = privacy.beginRead()!;
  finished.finish();
  finished.finish();
  assert.equal(finished.current(), false);
  assert.equal(active.current(), true);
  privacy.conceal();
  assert.equal(active.signal.aborted, true);
});

test("subscriptions see revocation before any new identity request starts, and cleanup detaches", async () => {
  const { privacy, identify, calls } = fixture();
  await identify();
  const events: { readable: boolean; calls: number }[] = [];
  const unsubscribe = privacy.subscribe(() => events.push({ readable: privacy.getSnapshot().readable, calls: calls.length }));
  const pending = privacy.check();
  assert.deepEqual(events[0], { readable: false, calls: 1 });
  await Promise.resolve();
  calls[1].result.resolve(ACTOR);
  await pending;
  assert.equal(events.at(-1)?.readable, true);
  unsubscribe();
  unsubscribe();
  const count = events.length;
  privacy.conceal();
  assert.equal(events.length, count);
});

test("SSR and another mounted private screen never receive an existing page's pinned identity", async () => {
  const first = fixture(), second = fixture();
  await first.identify();
  assert.equal(first.privacy.currentId(), ACTOR);
  assert.equal(first.privacy.getServerSnapshot().id, "");
  assert.equal(first.privacy.getServerSnapshot().readable, false);
  assert.equal(second.privacy.currentId(), "");
  assert.equal(second.calls.length, 0);
  assert.equal(Object.isFrozen(first.privacy.getSnapshot()), true);
});

test("effect cleanup cancels work, and a Strict Mode reattachment can perform a fresh initial check", async () => {
  const { privacy, calls, fail } = fixture();
  const before = privacy.check();
  await Promise.resolve();
  privacy.cancel();
  await before;
  assert.equal(calls[0].signal.aborted, true);
  await fail();
  assert.equal(privacy.getSnapshot().status, "failed");
  assert.equal(privacy.getSnapshot().readable, true, "cleanup alone does not invent an account-change event");
});

test("conceal cancels a pending message but preserves its exact actor, payload and key for manual recovery", async () => {
  const { privacy, identify } = fixture();
  await identify();
  const receipt: MessagingReceipt = { kind: "reply", message: { id: CONVERSATION, conversationId: CONVERSATION, senderId: ACTOR, body: "original", createdAt: "2026-11-01T00:00:00.000Z" } };
  const blocked = deferred<MessagingReceipt>();
  const calls: string[] = [];
  let online = false;
  const writer = createMessagingController({ kind: "reply", conversationId: CONVERSATION }, {
    mint: () => "same-original-key", transport: { async actor() { return ACTOR; }, async submit(intent) {
      calls.push(intent.key!); return online ? receipt : blocked.promise;
    } },
  });
  const cleanup = bindMessagingPrivacyWrite(privacy, writer);
  const pending = writer.attempt("original", privacy.currentId());
  await Promise.resolve();
  const original = writer.getSnapshot().intent;
  privacy.conceal();
  assert.equal(await pending, null);
  assert.equal(writer.getSnapshot().intent, original);
  assert.equal(writer.getSnapshot().busy, false);
  blocked.resolve(receipt);
  await identify(OTHER);
  assert.equal(writer.getSnapshot().intent, original);
  await identify();
  assert.equal(calls.length, 1, "identity recovery must not replay a mutation");
  online = true;
  await writer.attempt("original", privacy.currentId());
  assert.deepEqual(calls, ["same-original-key", "same-original-key"]);
  assert.equal(writer.getSnapshot().intent, null);
  cleanup();
});
