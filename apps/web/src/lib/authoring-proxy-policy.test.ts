import assert from "node:assert/strict";
import test from "node:test";
import { isSameOriginMutation, safeRedirectPath, setIdempotencyKeyHeader, tokenMaxAge } from "./authoring-proxy-policy.ts";

test("authoring mutations require an exact same-origin browser origin", () => {
  assert.equal(isSameOriginMutation("https://example.test/api/authoring/articles", "https://example.test"), true);
  assert.equal(isSameOriginMutation("https://example.test/api/authoring/articles", "https://attacker.test"), false);
  assert.equal(isSameOriginMutation("https://example.test/api/authoring/articles", "https://example.test.evil"), false);
  assert.equal(isSameOriginMutation("https://example.test/api/authoring/articles", "https://example.test/path"), false);
  assert.equal(isSameOriginMutation("https://example.test/api/authoring/articles", null), false);
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
