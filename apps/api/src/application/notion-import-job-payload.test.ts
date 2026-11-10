import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { createNotionJobPayloadCipher, MAX_NOTION_JOB_PAYLOAD_BYTES, MAX_NOTION_JOB_PAYLOAD_TTL_MS } from "./notion-import-job-payload.ts";

const context = { jobId: "job", ownerId: "writer", expiresAt: 1000 };
const expected = { jobId: "job", ownerId: "writer" };

test("job input round trips with randomized ciphertext and an isolated key", () => {
  const key = randomBytes(32);
  const original = Buffer.from(key);
  const cipher = createNotionJobPayloadCipher(key);
  key.fill(0);
  const plaintext = Buffer.from('{"url":"https://example.invalid/?secret=private"}');
  const first = cipher.seal(plaintext, context, 10);
  const second = cipher.seal(plaintext, context, 10);
  assert.notEqual(first.nonce, second.nonce);
  assert.equal(JSON.stringify(first).includes("private"), false);
  assert.deepEqual(cipher.open(first, expected, 999), plaintext);
  assert.deepEqual(createNotionJobPayloadCipher(original).open(second, expected, 10), plaintext);
});

test("context, expiry, ciphertext and key are authenticated", () => {
  const cipher = createNotionJobPayloadCipher(randomBytes(32));
  const sealed = cipher.seal(Buffer.from("secret"), context, 10);
  const invalid = /Encrypted job payload unavailable or invalid/;
  assert.throws(() => cipher.open(sealed, { ...expected, ownerId: "other" }, 10), invalid);
  assert.throws(() => cipher.open(sealed, { ...expected, jobId: "other" }, 10), invalid);
  assert.throws(() => cipher.open(sealed, expected, 1000), invalid);
  assert.throws(() => cipher.open({ ...sealed, expiresAt: 1001 }, expected, 10), invalid);
  assert.throws(() => cipher.open({ ...sealed, jobId: "other" }, { ...expected, jobId: "other" }, 10), invalid);
  assert.throws(() => cipher.open({ ...sealed, ciphertext: Buffer.alloc(6).toString("base64") }, expected, 10), invalid);
  assert.throws(() => cipher.open({ ...sealed, ownerId: "other" }, { ...expected, ownerId: "other" }, 10), invalid);
  assert.throws(() => cipher.open({ ...sealed, ciphertext: "!!!!!!!!" }, expected, 10), invalid);
  assert.throws(() => cipher.open({ ...sealed, tag: Buffer.alloc(16).toString("base64") }, expected, 10), invalid);
  assert.throws(() => createNotionJobPayloadCipher(randomBytes(32)).open(sealed, expected, 10), invalid);
});

test("input size, expiry, key and encoded envelope are bounded", () => {
  assert.throws(() => createNotionJobPayloadCipher(Buffer.alloc(31)));
  const cipher = createNotionJobPayloadCipher(Buffer.alloc(32));
  assert.throws(() => cipher.seal(Buffer.alloc(MAX_NOTION_JOB_PAYLOAD_BYTES + 1), context, 10));
  assert.throws(() => cipher.seal(Buffer.alloc(0), { ...context, expiresAt: 10 }, 10));
  assert.throws(() => cipher.seal(Buffer.alloc(0), { ...context, expiresAt: 11 + MAX_NOTION_JOB_PAYLOAD_TTL_MS }, 10));
  const sealed = cipher.seal(Buffer.alloc(0), context, 10);
  assert.deepEqual(cipher.open(sealed, expected, 10), Buffer.alloc(0));
  assert.throws(() => cipher.open({ ...sealed, nonce: "A".repeat(100) }, expected, 10));
});
