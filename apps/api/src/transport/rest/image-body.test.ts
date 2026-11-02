import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { readRawImageBody } from "./http.ts";

/**
 * The image upload reader's size and keep-alive decisions.
 *
 * Both `content-length` tests in this file were once written as `/^\\d+$/`,
 * which matches a literal backslash followed by letters rather than a run of
 * digits. The consequence was not a crash but two quiet ones: an oversized
 * upload was buffered to the ceiling instead of refused at the door, and a `415`
 * was answered without closing a connection whose request body had never been
 * read — leaving those bytes in front of whatever the client sent next.
 *
 * These tests exist so that the next person to touch this reader cannot
 * reintroduce the second one by accident.
 */

type FakeRequestOptions = {
  headers?: Record<string, string | undefined>;
  chunks?: Array<string | Buffer>;
  failStream?: boolean;
};

/** A minimal `IncomingMessage` stand-in: `readRawImageBody` only needs events. */
function fakeRequest({ headers = {}, chunks = [], failStream = false }: FakeRequestOptions = {}) {
  const request = new EventEmitter() as EventEmitter & {
    headers: Record<string, string | undefined>;
    pause: () => void;
  };
  request.headers = headers;
  request.pause = () => {};
  // Emitted after the caller has attached its listeners but before it awaits.
  process.nextTick(() => {
    for (const chunk of chunks) request.emit("data", Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (failStream) request.emit("error", new Error("connection reset"));
    else request.emit("end");
  });
  return request as never;
}

const JPEG = { "content-type": "image/jpeg" };

test("a declared oversized upload is refused before any of its bytes are read", async () => {
  const result = await readRawImageBody(
    fakeRequest({ headers: { ...JPEG, "content-length": String(8 * 1024 * 1024 + 1) }, chunks: ["x".repeat(64)] }),
  );
  assert.deepEqual(result, {
    ok: false,
    status: 413,
    code: "PAYLOAD_TOO_LARGE",
    message: "The image request body exceeds 8 MiB.",
    closeConnection: true,
  });
});

test("a declared length within the ceiling is accepted, digits and all", async () => {
  const body = Buffer.from("an image");
  const result = await readRawImageBody(
    fakeRequest({ headers: { ...JPEG, "content-length": String(body.byteLength) }, chunks: [body] }),
  );
  assert.equal(result.ok, true, "a numeric content-length must parse as a number");
  assert.equal(result.ok && Buffer.compare(result.bytes, body), 0);
});

test("a streamed upload that crosses the ceiling is refused and closes the connection", async () => {
  const chunk = Buffer.alloc(1024 * 1024);
  const result = await readRawImageBody(
    fakeRequest({ headers: JPEG, chunks: Array.from({ length: 9 }, () => chunk) }),
    8 * 1024 * 1024,
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.status, 413);
  assert.equal(result.ok === false && result.closeConnection, true);
});

test("an unsupported type with an unread body closes the connection", async () => {
  const result = await readRawImageBody(
    fakeRequest({ headers: { "content-type": "text/html", "content-length": "4096" }, chunks: ["<html>"] }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.status, 415);
  // The body was never consumed, so the bytes are still in the socket buffer:
  // reusing the connection would feed them to the next request.
  assert.equal(result.ok === false && result.closeConnection, true);
});

test("a chunked unsupported type also closes the connection", async () => {
  const result = await readRawImageBody(
    fakeRequest({ headers: { "content-type": "text/html", "transfer-encoding": "chunked" }, chunks: ["<html>"] }),
  );
  assert.equal(result.ok === false && result.closeConnection, true);
});

test("an unsupported type with no body leaves the connection reusable", async () => {
  const result = await readRawImageBody(fakeRequest({ headers: { "content-type": "text/html" } }));
  assert.equal(result.ok === false && result.status, 415);
  assert.equal(
    result.ok === false && result.closeConnection,
    undefined,
    "nothing was left unread, so there is no reason to close",
  );
});

test("an unreadable stream is a client error, not a crash", async () => {
  const result = await readRawImageBody(fakeRequest({ headers: JPEG, chunks: ["partial"], failStream: true }));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.status, 400);
});
