import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryRefreshCoordinator, refreshCoordinatorKey } from "../src/refresh-coordinator.ts";
import { ROTATED, TOKENS } from "./helpers.ts";

/**
 * The coordinator is pure policy — no HTTP, no cookies — so its timing and
 * single-flight rules are pinned here. `forward.test.ts` and
 * `refresh-concurrency.test.ts` then check that the proxy applies its answer.
 */
test("concurrent callers share one rotation and receive the same outcome", async () => {
  let calls = 0;
  let release: (value: typeof ROTATED) => void = () => {};
  const gate = new Promise<typeof ROTATED>((resolve) => { release = resolve; });
  const coordinator = new InMemoryRefreshCoordinator({ now: () => 1_000 });

  const pending = [0, 1, 2, 3].map(() => coordinator.resolve("key", async () => {
    calls += 1;
    return gate;
  }));
  release(ROTATED);
  const outcomes = await Promise.all(pending);

  assert.equal(calls, 1, "only the first caller may present the refresh token");
  assert.ok(outcomes.every((outcome) => outcome === ROTATED));
});

test("a settled result is reusable for a short window and expires afterwards", async () => {
  let clock = 10_000;
  let calls = 0;
  const coordinator = new InMemoryRefreshCoordinator({ reuseMs: 1_000, now: () => clock });
  const rotate = async () => { calls += 1; return ROTATED; };

  assert.equal(await coordinator.resolve("key", rotate), ROTATED);
  clock += 999;
  assert.equal(await coordinator.resolve("key", rotate), ROTATED, "a late sibling still uses the winner's session");
  assert.equal(calls, 1);

  clock += 2;
  assert.equal(await coordinator.resolve("key", rotate), ROTATED, "after the window a new rotation is allowed");
  assert.equal(calls, 2);
});

test("a refused rotation and a transient failure are shared, not retried by each waiter", async () => {
  for (const outcome of [null, undefined] as const) {
    let calls = 0;
    const coordinator = new InMemoryRefreshCoordinator({ now: () => 5_000 });
    const results = await Promise.all(
      [0, 1, 2].map(() => coordinator.resolve("key", async () => { calls += 1; return outcome; })),
    );
    assert.equal(calls, 1);
    assert.ok(results.every((value) => value === outcome));
  }
});

test("a throwing rotation proves nothing about the session", async () => {
  const coordinator = new InMemoryRefreshCoordinator({ now: () => 0 });
  const outcome = await coordinator.resolve("key", async () => { throw new Error("network"); });
  assert.equal(outcome, undefined);
});

test("the result ledger is bounded", async () => {
  let clock = 0;
  const coordinator = new InMemoryRefreshCoordinator({ maxEntries: 2, reuseMs: 100_000, now: () => clock });
  for (const key of ["a", "b", "c"]) await coordinator.resolve(key, async () => ROTATED);

  // "a" had to be evicted, so it rotates again; "c" is still within the window.
  let calls = 0;
  const rotate = async () => { calls += 1; return ROTATED; };
  await coordinator.resolve("c", rotate);
  assert.equal(calls, 0);
  await coordinator.resolve("a", rotate);
  assert.equal(calls, 1);
});

test("the ledger key is a digest, not a credential, and separates every input", async () => {
  const base = await refreshCoordinatorKey("https://api.example.test", TOKENS.refreshToken, TOKENS.accessToken);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(base.includes(TOKENS.refreshToken), false);
  assert.equal(base.includes(TOKENS.accessToken), false);
  assert.notEqual(base, await refreshCoordinatorKey("https://other.example.test", TOKENS.refreshToken, TOKENS.accessToken));
  assert.notEqual(base, await refreshCoordinatorKey("https://api.example.test", "x".repeat(43), TOKENS.accessToken));
  assert.notEqual(base, await refreshCoordinatorKey("https://api.example.test", TOKENS.refreshToken, undefined));
  assert.equal(base, await refreshCoordinatorKey("https://api.example.test", TOKENS.refreshToken, TOKENS.accessToken));
});

/**
 * A transient failure must not become a five-second blackout (#244).
 *
 * The ledger exists so a request that reaches its 401 *after* a sibling's
 * rotation finished still gets that sibling's session. `undefined` is not a
 * session — it is "no answer, try again" — so remembering it made one dropped
 * connection tell every request in the reuse window to stop trying. The refusal
 * below is the control: it is a fact about the credential and stays reusable.
 */
test("a transient failure is shared for a moment, then retried — a refusal is kept", async () => {
  let clock = 1_000;
  const coordinator = new InMemoryRefreshCoordinator({ reuseMs: 5_000, transientMs: 250, now: () => clock });

  let attempts = 0;
  const flaky = async () => { attempts += 1; throw new Error("socket hang up"); };
  assert.equal(await coordinator.resolve("key", flaky), undefined);
  // A sibling whose 401 landed with the same burst but which was descheduled
  // until after the first attempt settled: one answer, not two rotations.
  clock += 100;
  assert.equal(await coordinator.resolve("key", flaky), undefined);
  assert.equal(attempts, 1, "a burst shares its failure");
  // Past the transient window the next caller rotates again instead of
  // inheriting a dropped connection for the whole reuse period.
  clock += 200;
  assert.equal(await coordinator.resolve("key", flaky), undefined);
  assert.equal(attempts, 2, "a transient failure must not be reused for the reuse window");

  let refusals = 0;
  const refused = async () => { refusals += 1; return null; };
  assert.equal(await coordinator.resolve("refused", refused), null);
  clock += 1;
  assert.equal(await coordinator.resolve("refused", refused), null);
  assert.equal(refusals, 1, "a definitive refusal is still reused: retrying only confirms it");
});

test("a 5xx-style undefined answer is settled for in-flight waiters but not reused", async () => {
  let clock = 0;
  let calls = 0;
  let release: (value: undefined) => void = () => {};
  const gate = new Promise<undefined>((resolve) => { release = resolve; });
  const coordinator = new InMemoryRefreshCoordinator({ reuseMs: 5_000, now: () => clock });
  const rotate = async () => { calls += 1; return gate; };

  const waiting = [0, 1].map(() => coordinator.resolve("key", rotate));
  release(undefined);
  assert.deepEqual(await Promise.all(waiting), [undefined, undefined]);
  assert.equal(calls, 1, "concurrent callers still share one attempt");

  clock += 100;
  await coordinator.resolve("key", async () => { calls += 1; return ROTATED; });
  assert.equal(calls, 1, "a sibling inside the transient window still shares the answer");

  clock += 250;
  await coordinator.resolve("key", async () => { calls += 1; return ROTATED; });
  assert.equal(calls, 2, "the next caller after a 5xx rotates instead of replaying the 5xx");
});

