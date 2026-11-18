import assert from "node:assert/strict";
import test from "node:test";
import { UpstreamByteBuffer } from "../src/upstream-byte-buffer.ts";
import { UpstreamResponseError } from "../src/upstream-errors.ts";

 test("one-byte fragmentation consumes bounded slab storage, copies backing buffers and releases it on transfer", () => {
  const size = 160_017;
  const buffer = new UpstreamByteBuffer(size);
  const byte = Buffer.alloc(1);
  for (let index = 0; index < size; index++) { byte[0] = index % 256; buffer.append(byte); }
  byte.fill(0);
  assert.equal(buffer.size, size);
  assert.equal(buffer.capacity, size);
  assert.equal(buffer.peakCapacity, size);
  assert.throws(() => buffer.append(byte), error => error instanceof UpstreamResponseError && error.reason === "too-large");
  const output = buffer.take();
  assert.equal(output.length, size);
  for (let index = 0; index < size; index++) assert.equal(output[index], index % 256);
  assert.equal(buffer.size, 0);
  assert.equal(buffer.capacity, 0);
  assert.equal(buffer.take().length, 0);
});

test("byte transfer checks deadlines between slabs and releases retained bytes even when copying fails", () => {
  const failure = new Error("copy deadline");
  let fail = false;
  const buffer = new UpstreamByteBuffer(100_000, () => { if (fail) throw failure; });
  buffer.append(new Uint8Array(90_000));
  fail = true;
  assert.throws(() => buffer.take(), error => error === failure);
  assert.equal(buffer.capacity, 0);
  assert.equal(buffer.size, 0);
  for (const limit of [0, -1, 0.5, NaN, Infinity]) assert.throws(() => new UpstreamByteBuffer(limit), RangeError);
  assert.throws(() => new UpstreamByteBuffer(1).append(new Uint8Array(2), 0, 3), RangeError);
});
