import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter, once } from "node:events";
import { after, before, test } from "node:test";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { compressResponse } from "../compression.ts";

/** Exercise the real middleware over a raw socket: fetch auto-decompresses. */
const document = Buffer.from("<html><body>" + "public content ".repeat(400) + "</body></html>");
const script = Buffer.from("export const sample = '" + "javascript ".repeat(400) + "';");
const stylesheet = Buffer.from(".example { color: red; }\n".repeat(400));
const tiny = Buffer.from("tiny");
let port: number;
const streamEvents = new EventEmitter();
let activeAbortStreams = 0;
const server = createServer((req, res) => {
  compressResponse(req, res, () => respond(req, res));
});

function respond(req: IncomingMessage, res: ServerResponse): void {
  const path = (req.url ?? "/").split("?")[0];
  let body = document;
  let type = "text/html; charset=utf-8";
  let cache = "public, max-age=60";
  let status = 200;
  switch (path) {
    case "/assets/main.js":
      body = script;
      type = "text/javascript; charset=utf-8";
      break;
    case "/assets/main.css":
      body = stylesheet;
      type = "text/css; charset=utf-8";
      break;
    case "/assets/tiny.js":
      body = tiny;
      type = "text/javascript; charset=utf-8";
      break;
    case "/assets/picture.png":
      type = "image/png";
      break;
    case "/assets/missing.js":
      status = 404;
      break;
    case "/api/private":
      body = Buffer.from(JSON.stringify({ secret: "not-compressed" }).repeat(100));
      type = "application/json";
      cache = "no-store";
      break;
    case "/private":
      cache = "private, max-age=0";
      break;
    case "/no-store":
      cache = "no-store";
      break;
    case "/no-transform":
      cache = "public, no-transform";
      break;
    case "/unset-cache":
      cache = "";
      break;
    case "/set-cookie":
      res.setHeader("Set-Cookie", "session=secret; HttpOnly");
      break;
    case "/existing-encoding":
      res.setHeader("Content-Encoding", "identity");
      break;
    case "/already-encoded":
      body = Buffer.from("already-encoded");
      res.setHeader("Content-Encoding", "custom");
      break;
    case "/vary":
      res.setHeader("Vary", "Origin, accept-encoding");
      break;
    case "/vary-star":
      res.setHeader("Vary", "*");
      break;
    case "/abort-stream": {
      activeAbortStreams++;
      res.writeHead(status, { "Content-Type": type, "Cache-Control": cache });
      const timer = setInterval(() => {
        res.write(document);
        (res as ServerResponse & { flush?: () => void }).flush?.();
      }, 5);
      res.once("close", () => {
        clearInterval(timer);
        activeAbortStreams--;
        streamEvents.emit("closed");
      });
      res.write(document);
      (res as ServerResponse & { flush?: () => void }).flush?.();
      return;
    }
    case "/stream":
      res.writeHead(status, { "Content-Type": type, "Cache-Control": cache });
      for (let i = 0; i < document.length; i += 97) res.write(document.subarray(i, i + 97));
      res.end();
      return;
    case "/status":
      status = 503;
      break;
  }
  res.writeHead(status, { "Content-Type": type, "Cache-Control": cache, "Content-Length": body.length });
  res.end(req.method === "HEAD" ? undefined : body);
}

type RawResponse = { status: number; headers: IncomingHttpHeaders; body: Buffer };
function raw(path: string, options: { headers?: Record<string, string>; method?: string } = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: options.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

function vary(response: RawResponse): string[] {
  return String(response.headers.vary ?? "").toLowerCase().split(",").map((item) => item.trim()).filter(Boolean);
}

before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  port = address.port;
});

after(async () => {
  server.close();
  server.closeAllConnections();
  await once(server, "close");
});

test("gzip, Brotli and deflate negotiate and round-trip public HTML and assets", async () => {
  const formats = [
    { name: "gzip", decode: gunzipSync },
    { name: "br", decode: brotliDecompressSync },
    { name: "deflate", decode: inflateSync },
  ];
  for (const { name, decode } of formats) {
    for (const [path, expected] of [["/", document], ["/assets/main.js", script], ["/assets/main.css", stylesheet]] as const) {
      const response = await raw(path, { headers: { "accept-encoding": name } });
      assert.equal(response.status, 200, path);
      assert.equal(response.headers["content-encoding"], name, path);
      assert.deepEqual(decode(response.body), expected, path);
      assert.ok(response.body.length < expected.length, `${path} is smaller on the wire`);
      assert.equal(response.headers["content-length"], undefined, "the uncompressed length is not reused");
      assert.ok(vary(response).includes("accept-encoding"));
    }
  }
});

test("quality weights, explicit rejections and no header select the appropriate encoding", async () => {
  const cases = [
    ["gzip;q=1, br;q=0.2", "gzip"],
    ["gzip;q=0, br;q=1", "br"],
    ["br;q=0, gzip;q=0", undefined],
    ["identity", undefined],
    ["compress", undefined],
    ["", undefined],
  ] as const;
  for (const [header, encoding] of cases) {
    const response = await raw("/assets/main.js", { headers: { "accept-encoding": header } });
    assert.equal(response.headers["content-encoding"], encoding, header);
    assert.ok(vary(response).includes("accept-encoding"));
    if (!encoding) assert.deepEqual(response.body, script);
  }
  const withoutHeader = await raw("/assets/main.js");
  assert.equal(withoutHeader.headers["content-encoding"], undefined);
  assert.deepEqual(withoutHeader.body, script);
});

test("small files, images and errors are not transformed", async () => {
  for (const path of ["/assets/tiny.js", "/assets/picture.png", "/assets/missing.js", "/status"]) {
    const response = await raw(path, { headers: { "accept-encoding": "br, gzip" } });
    assert.equal(response.headers["content-encoding"], undefined, path);
  }
});

test("private, no-store, no-transform, unclassified, cookie-setting and API responses remain uncompressed", async () => {
  for (const path of ["/private", "/no-store", "/no-transform", "/unset-cache", "/set-cookie", "/api/private"]) {
    const response = await raw(path, { headers: { "accept-encoding": "gzip" } });
    assert.equal(response.headers["content-encoding"], undefined, path);
  }
});

test("HTML with cookies, authorization or a query string is not compressed", async () => {
  for (const [path, headers] of [
    ["/", { cookie: "nw_session=123" }],
    ["/", { authorization: "Bearer sensitive" }],
    ["/?search=reflected", {}],
  ] as const) {
    const response = await raw(path, { headers: { "accept-encoding": "gzip", ...headers } });
    assert.equal(response.headers["content-encoding"], undefined, path);
    assert.deepEqual(response.body, document);
    assert.ok(vary(response).includes("accept-encoding"));
    assert.ok(vary(response).includes("cookie"));
    assert.ok(vary(response).includes("authorization"));
  }
  // Static build files do not contain per-user data, even with a cookie.
  const asset = await raw("/assets/main.js", { headers: { "accept-encoding": "gzip", cookie: "nw_session=123" } });
  assert.equal(asset.headers["content-encoding"], "gzip");
  assert.deepEqual(gunzipSync(asset.body), script);
});

test("Vary preserves upstream fields and does not duplicate fields or alter a wildcard", async () => {
  const response = await raw("/vary", { headers: { "accept-encoding": "gzip" } });
  assert.deepEqual(vary(response), ["origin", "accept-encoding", "cookie", "authorization"]);
  const wildcard = await raw("/vary-star", { headers: { "accept-encoding": "gzip" } });
  assert.deepEqual(vary(wildcard), ["*"]);
});

test("HEAD stays bodyless with the original size and the cache key", async () => {
  const response = await raw("/assets/main.js", { method: "HEAD", headers: { "accept-encoding": "gzip" } });
  assert.equal(response.status, 200);
  assert.equal(response.body.length, 0);
  assert.equal(Number(response.headers["content-length"]), script.length);
  assert.equal(response.headers["content-encoding"], undefined);
  assert.ok(vary(response).includes("accept-encoding"));
});

test("already encoded responses are not encoded twice", async () => {
  const encoded = await raw("/already-encoded", { headers: { "accept-encoding": "gzip" } });
  assert.equal(encoded.headers["content-encoding"], "custom");
  assert.equal(encoded.body.toString(), "already-encoded");
  const identity = await raw("/existing-encoding", { headers: { "accept-encoding": "gzip" } });
  assert.equal(identity.headers["content-encoding"], "gzip");
  assert.deepEqual(gunzipSync(identity.body), document);
});

test("streamed responses survive compression without buffering or losing chunks", async () => {
  const response = await raw("/stream", { headers: { "accept-encoding": "gzip" } });
  assert.equal(response.headers["content-encoding"], "gzip");
  assert.deepEqual(gunzipSync(response.body), document);
});


test("prematurely closed compressed streams release their response and leave the server usable", { timeout: 15_000 }, async () => {
  // Exercise real TCP disconnects rather than just a mock response. Each stream
  // continues producing data until the client closes; the server must observe
  // close and release its producer. The upstream advisory involved premature
  // closes, but this is a lifecycle regression test, not a heap-leak proof.
  for (const encoding of ["gzip", "br", "deflate"]) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const closed = once(streamEvents, "closed");
      await new Promise<void>((resolve, reject) => {
        const request = httpRequest({ host: "127.0.0.1", port, path: "/abort-stream", headers: { "accept-encoding": encoding } });
        request.once("response", (response) => {
          assert.equal(response.headers["content-encoding"], encoding);
          response.once("data", () => {
            response.destroy();
            resolve();
          });
          response.once("error", reject);
        });
        request.once("error", reject);
        request.end();
      });
      await closed;
      assert.equal(activeAbortStreams, 0, `${encoding}: no response remains open`);
    }
    const healthy = await raw("/assets/main.js", { headers: { "accept-encoding": encoding } });
    assert.equal(healthy.status, 200);
    assert.equal(healthy.headers["content-encoding"], encoding);
  }
});
