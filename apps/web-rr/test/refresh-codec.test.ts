import assert from "node:assert/strict";
import test from "node:test";
import { RefreshResultCodec } from "../refresh/result-codec.ts";

const key = Buffer.alloc(32, 19);
const binding = { namespace: "fixture", key: "a".repeat(64), owner: "00000000-0000-4000-8000-000000000001", expiresAt: "2026-11-12T12:00:00.000Z" };
const tokens = { accessToken: "fixture-access-credential-".repeat(3), tokenType: "Bearer" as const, accessExpiresAt: "2026-11-12T11:59:00.000Z", refreshToken: "a".repeat(43), refreshExpiresAt: "2026-12-01T00:00:00.000Z" };

test("shared refresh values are randomized authenticated ciphertext bound to their row", () => {
  const codec = new RefreshResultCodec(key);
  const first = codec.seal(tokens, binding), second = codec.seal(tokens, binding);
  assert.notEqual(first, second);
  assert.ok(!first.includes(tokens.refreshToken) && !first.includes(tokens.accessToken));
  assert.deepEqual(codec.open(first, binding), tokens);
  for (const other of [{ ...binding, key: "b".repeat(64) }, { ...binding, namespace: "other" }, { ...binding, owner: "00000000-0000-4000-8000-000000000002" }, { ...binding, expiresAt: "2026-11-12T12:00:01.000Z" }]) assert.throws(() => codec.open(first, other));
  assert.throws(() => new RefreshResultCodec(Buffer.alloc(32, 20)).open(first, binding));
  const changed = first.slice(0, -5) + (first.at(-5) === "a" ? "b" : "a") + first.slice(-4);
  assert.throws(() => codec.open(changed, binding));
});

test("shared outcome decoding is bounded and preserves typed retry/cookie semantics", () => {
  const codec = new RefreshResultCodec(key);
  const throttled = { kind: "failed" as const, status: 429, code: "RATE_LIMITED", message: "Please wait.", retryAfterSeconds: 12 };
  for (const value of [null, undefined, throttled]) assert.deepEqual(codec.open(codec.seal(value, binding), binding), value);
  for (const value of [{ ...tokens, accessToken: "x".repeat(8193) }, { ...tokens, refreshToken: "bad" }, { ...tokens, accessExpiresAt: "bad" }, { ...throttled, retryAfterSeconds: -1 }, { ...throttled, status: 200 }, { ...throttled, message: "x".repeat(241) }]) assert.throws(() => codec.seal(value, binding));
  assert.throws(() => codec.open("v1." + "x".repeat(50000), binding));
});
