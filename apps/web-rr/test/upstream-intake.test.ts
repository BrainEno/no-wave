import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import test from "node:test";
import { createWebIntake } from "../upstream/intake.ts";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("native intake holds capacity through the response and refuses excess without running the app", async t => {
  const intake = createWebIntake({ WEB_REQUEST_CONCURRENCY: "1" });
  let handled = 0;
  let finish: (() => void) | undefined;
  const server = createServer(intake.httpOptions, (request, response) => {
    if (request.url === "/metrics") { response.end(intake.metrics()); return; }
    if (intake.handle(request, response)) return;
    handled++;
    if (request.url === "/held") finish = () => response.end("done");
    else response.end("ok");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const pending = fetch(`${base}/held`);
  while (!finish) await tick();
  const busy = await fetch(`${base}/ordinary`);
  assert.equal(busy.status, 503); assert.equal(busy.headers.get("retry-after"), "1");
  assert.match(busy.headers.get("cache-control") ?? "", /no-store/);
  assert.equal((await busy.json()).error.code, "WEB_BUSY");
  const session = await fetch(`${base}/api/authoring/session`); assert.equal(session.status, 200); await session.text();
  assert.equal(handled, 2);
  finish(); assert.equal(await (await pending).text(), "done"); await tick();
  assert.equal(intake.snapshot().ordinary.active, 0);
  assert.match(await (await fetch(`${base}/metrics`)).text(), /web_intake_refused_total\{reason="request-capacity"\} 1/);
});

test("a disconnected partial upload releases capacity without an uncaught stream failure", async t => {
  const intake = createWebIntake({});
  const server = createServer((request, response) => { if (!intake.handle(request, response)) request.on("data", () => {}); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const upload = httpRequest({ host: "127.0.0.1", port: address.port, path: "/api/authoring/media", method: "POST", headers: { "content-length": "1000" } });
  upload.on("error", () => {}); upload.write("partial");
  for (let attempts = 0; attempts < 100 && intake.snapshot().ordinary.active === 0; attempts++) await tick();
  assert.equal(intake.snapshot().ordinary.active, 1);
  upload.destroy();
  for (let attempts = 0; attempts < 100 && intake.snapshot().ordinary.active; attempts++) await tick();
  assert.equal(intake.snapshot().ordinary.active, 0);
  assert.equal(intake.snapshot().aborted, 1);
});

test("server timeouts and memory admission fail closed before listening when invalid", () => {
  for (const environment of [
    { WEB_REQUEST_TIMEOUT_MS: "1000", WEB_HEADERS_TIMEOUT_MS: "2000" },
    { WEB_REQUEST_CONCURRENCY: "0" }, { WEB_REQUEST_BODY_BUDGET_BYTES: "1" },
    { WEB_HEADERS_TIMEOUT_MS: "private-setting-canary" }, { WEB_KEEP_ALIVE_TIMEOUT_MS: "1.5" },
  ]) assert.throws(() => createWebIntake(environment), error => error instanceof Error && !error.message.includes("private-setting-canary"));
});


test("native header and partial-message deadlines actually close slow sockets and release their intake", { timeout: 12_000 }, async t => {
  const intake = createWebIntake({ WEB_HEADERS_TIMEOUT_MS: "1000", WEB_REQUEST_TIMEOUT_MS: "1000" });
  const server = createServer(intake.httpOptions, (request, response) => {
    if (!intake.handle(request, response)) request.on("data", () => {});
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  for (const message of ["POST /slow HTTP/1.1\r\nHost: local", "POST /slow HTTP/1.1\r\nHost: local\r\nContent-Length: 1000\r\n\r\npartial"]) {
    const socket = connect(address.port, "127.0.0.1");
    t.after(() => socket.destroy());
    const reply = new Promise<string>((resolve, reject) => {
      let text = "";
      socket.setTimeout(4000, () => { socket.destroy(); reject(new Error("The native receive deadline did not close a slow socket.")); });
      socket.on("data", chunk => { text += chunk.toString(); });
      socket.once("error", reject);
      socket.once("close", () => resolve(text));
    });
    socket.write(message);
    assert.match(await reply, /^HTTP\/1\.1 408 /);
  }
  await tick();
  assert.equal(intake.snapshot().ordinary.active, 0);
  assert.equal(intake.snapshot().ordinary.reservedBytes, 0);
  assert.equal(intake.snapshot().aborted, 1, "only the fully received headers acquired application intake");
});

test("an early response closes an unread partial upload instead of leaving a hidden keep-alive lease", { timeout: 5000 }, async t => {
  const intake = createWebIntake({ WEB_REQUEST_CONCURRENCY: "1" });
  const server = createServer(intake.httpOptions, (request, response) => {
    if (!intake.handle(request, response)) response.end("early");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const socket = connect(address.port, "127.0.0.1");
  t.after(() => socket.destroy());
  const closed = new Promise<string>((resolve, reject) => {
    let text = "";
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error("An unread upload outlived its response.")); });
    socket.on("data", chunk => { text += chunk.toString(); }); socket.once("error", reject); socket.once("close", () => resolve(text));
  });
  socket.write("POST /early HTTP/1.1\r\nHost: local\r\nContent-Length: 1000\r\n\r\npartial");
  assert.match(await closed, /early/); await tick();
  assert.equal(intake.snapshot().ordinary.active, 0);
  assert.equal(intake.snapshot().ordinary.reservedBytes, 0);
});
