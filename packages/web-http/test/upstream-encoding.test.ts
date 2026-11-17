import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { UpstreamTransport } from "../src/upstream.ts";
import { UpstreamResponseError } from "../src/upstream-errors.ts";

test("native fetch's compressed Content-Length is not mistaken for decoded bytes in either response path", async t => {
  const decoded = Buffer.from('{}');
  const encoded = gzipSync(decoded);
  assert.ok(encoded.length > decoded.length);
  const api = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", "content-length": encoded.length });
    response.end(encoded);
  });
  api.listen(0, "127.0.0.1"); await once(api, "listening");
  t.after(() => new Promise<void>(resolve => { api.closeAllConnections(); api.close(() => resolve()); }));
  const address = api.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/compressed`;
  const transport = new UpstreamTransport();
  t.after(async () => { await transport.close(); });
  const buffered = await transport.request(url, {}, { maxBytes: decoded.length, responseType: "json" });
  assert.deepEqual(Buffer.from(buffered.bytes), decoded);
  const download = await transport.openStream(url, {}, { maxBytes: decoded.length });
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), decoded);
  assert.equal(download.headers.get("content-encoding"), null, "decoded bytes cannot be decompressed twice by the browser");
  assert.equal(download.headers.get("content-length"), null);
  // Skipping an encoded advertisement must not skip the real decoded fence.
  await assert.rejects(transport.request(url, {}, { maxBytes: decoded.length - 1 }), error => error instanceof UpstreamResponseError && error.reason === "too-large");
  const oversized = await transport.openStream(url, {}, { maxBytes: decoded.length - 1 });
  await assert.rejects(oversized.arrayBuffer(), error => error instanceof UpstreamResponseError && error.reason === "too-large");
});
