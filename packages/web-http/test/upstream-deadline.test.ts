import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  MAXIMUM_UPSTREAM_TIMEOUT_MS,
  UpstreamTimeoutError,
  resolveUpstreamTimeoutMs,
  withUpstreamDeadline,
} from "../src/api.ts";

test("a bounded operation returns its value and the timer is cleared", async () => {
  const value = await withUpstreamDeadline(50, async () => "done");
  assert.equal(value, "done");
  // A cleared timer must not fire into the next test's event loop or keep the
  // process alive; if it had, the abort would surface as a later unhandled
  // rejection on this same signal.
  await new Promise((resolve) => setTimeout(resolve, 80));
});

test("a hanging operation fails with a typed timeout instead of waiting forever", async () => {
  const started = Date.now();
  await assert.rejects(
    withUpstreamDeadline(40, () => new Promise<never>(() => {})),
    (error: unknown) => {
      assert.ok(error instanceof UpstreamTimeoutError);
      assert.equal(error.name, "UpstreamTimeoutError");
      assert.equal(error.timeoutMs, 40);
      // No origin, path, header or credential may reach the message: it is
      // carried into a public error boundary.
      assert.equal(/https?:\/\//.test(error.message), false);
      return true;
    },
  );
  assert.ok(Date.now() - started < 2_000);
});

test("the operation receives a signal that is aborted when the deadline passes", async () => {
  let observed: AbortSignal | undefined;
  await assert.rejects(
    withUpstreamDeadline(30, (signal) => {
      observed = signal;
      return new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }),
    UpstreamTimeoutError,
  );
  assert.equal(observed?.aborted, true);
});

test("a transport that ignores the abort signal still times out", async () => {
  // The deadline must be a race, not a request that only ends when the
  // transport cooperates: an upstream socket stuck in a black hole does not
  // read signals.
  await assert.rejects(
    withUpstreamDeadline(30, () => new Promise<never>(() => {})),
    UpstreamTimeoutError,
  );
});

test("a failure that is not the deadline keeps its own error", async () => {
  const original = new TypeError("connection refused");
  await assert.rejects(
    withUpstreamDeadline(500, () => Promise.reject(original)),
    (error: unknown) => error === original,
  );
});

test("an invalid budget fails closed rather than defaulting silently", async () => {
  for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAXIMUM_UPSTREAM_TIMEOUT_MS + 1]) {
    await assert.rejects(
      withUpstreamDeadline(invalid, async () => "never"),
      RangeError,
      `expected ${String(invalid)} to be rejected`,
    );
  }
  for (const invalid of ["0", "-5", "1.5", "5s", "", "  ", "1e3"]) {
    assert.throws(() => resolveUpstreamTimeoutMs(invalid), RangeError, `expected ${JSON.stringify(invalid)} to be rejected`);
  }
});

test("resolving the budget accepts the documented shapes only", () => {
  assert.equal(resolveUpstreamTimeoutMs(undefined), DEFAULT_UPSTREAM_TIMEOUT_MS);
  assert.equal(resolveUpstreamTimeoutMs(null), DEFAULT_UPSTREAM_TIMEOUT_MS);
  assert.equal(resolveUpstreamTimeoutMs(2_500), 2_500);
  assert.equal(resolveUpstreamTimeoutMs("2500"), 2_500);
  assert.equal(resolveUpstreamTimeoutMs(" 2500 "), 2_500);
  assert.equal(resolveUpstreamTimeoutMs(MAXIMUM_UPSTREAM_TIMEOUT_MS), MAXIMUM_UPSTREAM_TIMEOUT_MS);
  assert.equal(resolveUpstreamTimeoutMs(1), 1);
  assert.ok(DEFAULT_UPSTREAM_TIMEOUT_MS > 0 && DEFAULT_UPSTREAM_TIMEOUT_MS <= MAXIMUM_UPSTREAM_TIMEOUT_MS);
});
