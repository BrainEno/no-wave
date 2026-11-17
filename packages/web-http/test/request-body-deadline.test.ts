import assert from "node:assert/strict";
import test from "node:test";
import { readLimitedJson, readLimitedBytes, readLimitedStream } from "../src/body.ts";

function bodyRequest(body: ReadableStream<Uint8Array>, signal?: AbortSignal, headers: Record<string, string> = {}) {
  return new Request("https://reader.test/api/authoring/articles", { method: "POST", headers: { "content-type": "application/json", ...headers },
    body, signal, duplex: "half" } as RequestInit);
}

test("a stalled inbound JSON body ends with a private 408 and cancels its source", async () => {
  let cancelled = false;
  const result = await readLimitedJson(bodyRequest(new ReadableStream({ cancel() { cancelled = true; } })), 4096, { timeoutMs: 10 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.response.status, 408);
  assert.equal((await result.response.json()).error.code, "REQUEST_BODY_TIMEOUT");
  assert.match(result.response.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(cancelled, true);
});

test("browser cancellation stops an inbound upload even if cancel never settles", async () => {
  let cancelled = false;
  const controller = new AbortController();
  const result = readLimitedBytes(bodyRequest(new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } }), controller.signal), 100, "too large", { timeoutMs: 1000 });
  setTimeout(() => controller.abort("private-browser-diagnostic"), 5);
  const resolved = await result;
  assert.equal(resolved.ok, false);
  if (resolved.ok) return;
  assert.equal(resolved.response.status, 499);
  assert.doesNotMatch(await resolved.response.text(), /private-browser-diagnostic/);
  assert.equal(cancelled, true);
});

test("oversized inbound streams cannot pin a request with a hanging cancel promise", async () => {
  const request = bodyRequest(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(100)); }, cancel() { return new Promise(() => {}); },
  }));
  const result = await readLimitedJson(request, 10, { timeoutMs: 20 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.response.status, 413);
});

test("JSON and binary bodies share strict Content-Length validation and fail before reading", async () => {
  for (const length of ["-1", "1e3", "1,1", "invalid"]) {
    let reads = 0;
    const request = () => bodyRequest(new ReadableStream({ pull() { reads++; } }, { highWaterMark: 0 }), undefined, { "content-length": length });
    const json = await readLimitedJson(request(), 100);
    const bytes = await readLimitedBytes(request(), 100);
    assert.equal(json.ok, false); assert.equal(bytes.ok, false);
    if (!json.ok) assert.equal(json.response.status, 400);
    if (!bytes.ok) assert.equal(bytes.response.status, 400);
    assert.equal(reads, 0);
  }
});

test("a body at its byte limit succeeds while malformed UTF-8 is not silently repaired", async () => {
  const encoded = new TextEncoder().encode('{"text":"浪"}');
  const valid = await readLimitedJson(bodyRequest(new ReadableStream({ start(controller) { controller.enqueue(encoded); controller.close(); } })), encoded.length);
  assert.equal(valid.ok, true);
  const bad = await readLimitedJson(bodyRequest(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array([123, 34, 97, 34, 58, 34, 255, 34, 125])); controller.close();
  } })), 100);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.response.status, 400);
});


test("framework-neutral readers refuse declared/actual framing mismatches for JSON and binary bodies", async () => {
  for (const length of ["0", "1", "3"]) {
    for (const read of [readLimitedJson, readLimitedBytes]) {
      const result = await read(bodyRequest(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{}')); controller.close();
      } }), undefined, { "content-length": length }), 100);
      assert.equal(result.ok, false);
      if (!result.ok) { assert.equal(result.response.status, 400); assert.match(result.response.headers.get("cache-control") ?? "", /no-store/); }
    }
  }
});

test("incoming byte readers snapshot borrowed chunks instead of accepting later source mutations", async () => {
  const borrowed = new Uint8Array([65, 66]);
  let reads = 0;
  const result = await readLimitedBytes(bodyRequest(new ReadableStream<Uint8Array>({ pull(controller) {
    if (reads++ === 0) controller.enqueue(borrowed);
    else if (reads === 2) { borrowed.set([67, 68]); controller.enqueue(borrowed); }
    else controller.close();
  } }, { highWaterMark: 0 })), 4);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual([...result.bytes], [65, 66, 67, 68]);
});

test("invalid binary chunks produce a private unreadable answer, not a post-read allocation failure", async () => {
  const result = await readLimitedStream(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue("private-chunk-canary" as unknown as Uint8Array); controller.close();
  } }), 100);
  assert.equal(result.ok, false);
  if (!result.ok) { assert.equal(result.reason, "unreadable"); assert.doesNotMatch(await result.response.text(), /private-chunk-canary/); }
});

test("invalid byte ceilings are rejected before a source can bypass the bound", async () => {
  for (const limit of [0, -1, 1.5, NaN, Infinity]) {
    let pulled = false;
    await assert.rejects(readLimitedStream(new ReadableStream({ pull(controller) { pulled = true; controller.close(); } }, { highWaterMark: 0 }), limit), RangeError);
    assert.equal(pulled, false);
  }
});

test("already-resolved empty body chunks cannot starve the inbound deadline until EOF", async () => {
  let reads = 0;
  const end = 100_000;
  const result = await readLimitedJson(bodyRequest(new ReadableStream<Uint8Array>({ pull(controller) {
    if (reads++ < end) controller.enqueue(new Uint8Array(0)); else controller.close();
  } }, { highWaterMark: 0 })), 100, { timeoutMs: 5 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.response.status, 408);
  assert.ok(reads < end, "the clock must stop work before an empty source agrees to end");
});
