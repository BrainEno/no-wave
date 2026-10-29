import assert from "node:assert/strict";
import test from "node:test";
import { isSameOriginMutation, safeRedirectPath, setIdempotencyKeyHeader, tokenMaxAge } from "../src/policy.ts";

test("authoring mutations require an exact same-origin browser origin", () => {
  assert.equal(isSameOriginMutation("https://example.test/api/authoring/articles", "https://example.test"), true);
  assert.equal(isSameOriginMutation("https://example.test/api/authoring/articles", "https://attacker.test"), false);
  assert.equal(isSameOriginMutation("https://example.test/api/authoring/articles", "https://example.test.evil"), false);
  assert.equal(isSameOriginMutation("https://example.test/api/authoring/articles", "https://example.test/path"), false);
  assert.equal(isSameOriginMutation("https://example.test/api/authoring/articles", null), false);
});

// Regression: Next.js derives request.url from the hostname the server was
// started with, so `next dev --hostname 0.0.0.0` (and the container image's
// HOSTNAME) produced `http://0.0.0.0:3000/...`. Comparing it with the browser's
// Origin rejected every legitimate sign-in and authoring write with 403.
test("authoring mutations compare the browser Host header, not the listen hostname", () => {
  assert.equal(
    isSameOriginMutation("http://0.0.0.0:3000/api/auth/login", "http://127.0.0.1:3000", "127.0.0.1:3000"),
    true,
  );
  assert.equal(
    isSameOriginMutation("http://0.0.0.0:3000/api/auth/login", "http://localhost:3000", "localhost:3000"),
    true,
  );
  assert.equal(
    isSameOriginMutation("http://0.0.0.0:3000/api/auth/login", "http://192.168.1.10:3000", "192.168.1.10:3000"),
    true,
  );
  // The listen-hostname mismatch must not become a cross-origin bypass.
  assert.equal(
    isSameOriginMutation("http://0.0.0.0:3000/api/auth/login", "https://attacker.test", "127.0.0.1:3000"),
    false,
  );
  assert.equal(
    isSameOriginMutation("http://0.0.0.0:3000/api/auth/login", "http://127.0.0.1:4000", "127.0.0.1:3000"),
    false,
  );
  // A scheme downgrade is still rejected.
  assert.equal(
    isSameOriginMutation("https://no-wave.test/api/auth/login", "http://no-wave.test", "no-wave.test"),
    false,
  );
  // A malformed Host header falls back to request.url and cannot widen the check.
  assert.equal(
    isSameOriginMutation("http://0.0.0.0:3000/api/auth/login", "http://127.0.0.1:3000", "127.0.0.1:3000/../evil"),
    false,
  );
  assert.equal(
    isSameOriginMutation("http://127.0.0.1:3000/api/auth/login", "http://127.0.0.1:3000", null),
    true,
  );
});

test("post-login redirects stay relative to the current site", () => {
  assert.equal(safeRedirectPath("/write"), "/write");
  assert.equal(safeRedirectPath("/account?tab=profile#top"), "/account?tab=profile#top");
  assert.equal(safeRedirectPath("//attacker.test"), "/write");
  assert.equal(safeRedirectPath("https://attacker.test"), "/write");
  assert.equal(safeRedirectPath("/\\\\attacker.test"), "/write");
});

test("cookie lifetimes are finite and capped", () => {
  const now = Date.parse("2026-10-28T00:00:00.000Z");
  assert.equal(tokenMaxAge("2026-10-28T00:01:00.000Z", now), 60);
  assert.equal(tokenMaxAge("2027-12-01T00:00:00.000Z", now), 30 * 24 * 60 * 60);
  assert.equal(tokenMaxAge("not-a-date", now), 0);
});

test("idempotency keys are forwarded unchanged and absent keys stay absent", () => {
  const forwarded = new Headers({ accept: "application/json" });
  setIdempotencyKeyHeader(forwarded, "comment-once-7");
  assert.equal(forwarded.get("idempotency-key"), "comment-once-7");

  const absent = new Headers({ accept: "application/json" });
  setIdempotencyKeyHeader(absent, null);
  assert.equal(absent.has("idempotency-key"), false);

  const undefinedKey = new Headers();
  setIdempotencyKeyHeader(undefinedKey);
  assert.equal(undefinedKey.has("idempotency-key"), false);
});
