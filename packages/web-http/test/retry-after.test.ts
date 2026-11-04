import assert from "node:assert/strict";
import test from "node:test";

import { parseRetryAfterSeconds } from "../src/retry-after.ts";

/**
 * The proxy relays exactly one upstream header. These are the values worth
 * pinning: everything that is not a usable, bounded wait must be dropped rather
 * than copied into a browser response.
 */
test("integer seconds are relayed as bounded positive integers", () => {
  const now = Date.UTC(2026, 10, 4, 6, 0, 0);
  assert.equal(parseRetryAfterSeconds("12", now), 12);
  assert.equal(parseRetryAfterSeconds(" 30 ", now), 30);
  assert.equal(parseRetryAfterSeconds("1", now), 1);
  assert.equal(parseRetryAfterSeconds("999999999", now), 86_400, "an absurd wait is capped, not echoed");
});

test("an HTTP-date is converted to the remaining seconds", () => {
  const now = Date.UTC(2026, 10, 4, 6, 0, 0);
  assert.equal(parseRetryAfterSeconds(new Date(now + 90_000).toISOString(), now), 90);
  assert.equal(parseRetryAfterSeconds(new Date(now + 1_500).toISOString(), now), 2, "partial seconds round up");
});

test("absent, malformed, zero, past and injected values are dropped", () => {
  const now = Date.UTC(2026, 10, 4, 6, 0, 0);
  for (const value of [
    null, "", "   ", "0", "-5", "1.5", "soon",
    "12\r\nx-evil: 1", "x".repeat(200),
    new Date(now - 1_000).toISOString(),
  ]) {
    assert.equal(parseRetryAfterSeconds(value, now), null, `${JSON.stringify(value)} must not reach the browser`);
  }
});
