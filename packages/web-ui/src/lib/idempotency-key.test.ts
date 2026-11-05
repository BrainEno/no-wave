import assert from "node:assert/strict";
import test from "node:test";
import { IDEMPOTENCY_KEY_HEADER, intentForAttempt, mintKey } from "./idempotency-key.ts";

test("new intents receive distinct, usable keys", () => {
  const keys = new Set(Array.from({ length: 100 }, () => mintKey()));
  assert.equal(keys.size, 100);
  for (const key of keys) assert.match(key, /^[0-9a-f-]{32,36}$/i);
  assert.equal(new Headers({ [IDEMPOTENCY_KEY_HEADER]: "key" }).get("Idempotency-Key"), "key");
});

test("a failed attempt retries the same payload and key", () => {
  const first = intentForAttempt(null, '{"body":"hello"}');
  assert.ok(first);
  assert.strictEqual(intentForAttempt(first, '{"body":"hello"}'), first);
  assert.equal(intentForAttempt(first, '{"body":"changed"}'), null);
  assert.strictEqual(intentForAttempt(first, '{"body":"hello"}'), first);
});

test("success or explicit discard starts a new intent with a new key", () => {
  const first = intentForAttempt(null, '{"participantIds":["a"]}');
  assert.ok(first);
  const next = intentForAttempt(null, '{"participantIds":["a"]}');
  assert.ok(next);
  assert.notEqual(next.key, first.key);
});

test("getRandomValues is used when randomUUID is unavailable", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const realCrypto = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", {
    value: { getRandomValues: realCrypto.getRandomValues.bind(realCrypto) }, configurable: true,
  });
  try {
    assert.match(mintKey(), /^[0-9a-f]{32}$/);
    assert.notEqual(mintKey(), mintKey());
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
    else Reflect.deleteProperty(globalThis, "crypto");
  }
});

test("missing secure randomness fails closed rather than reusing predictable keys", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
  try {
    assert.throws(() => mintKey(), /randomness/);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
    else Reflect.deleteProperty(globalThis, "crypto");
  }
});
