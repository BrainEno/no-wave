import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { probeDevService } from "./dev-service-probe.ts";

async function fixture() {
  let mode = "ready";
  const server = createServer((request, response) => {
    if (mode === "hang") { response.writeHead(200); response.write("{"); return; }
    if (mode === "redirect") { response.writeHead(302, { location: "/ready" }); response.end(); return; }
    if (mode === "http") { response.writeHead(503); response.end("private-body-canary"); return; }
    if (mode === "large") { response.end("private-body-canary".repeat(1000)); return; }
    if (mode === "invalid") { response.end("private-body-canary"); return; }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ status: "ready", service: mode === "ready" ? "api" : "notification-worker" }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return { server, url: `http://127.0.0.1:${address.port}/ready`, set(value: string) { mode = value; },
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }) };
}

test("dev gates verify role identity and bounded JSON rather than accepting any process that happens to answer 200", async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  try {
    assert.deepEqual(await probeDevService("api", f.url, signal, 200), { ready: true, status: 200, reason: "ready" });
    for (const [mode, reason] of [["worker", "role_mismatch"], ["invalid", "invalid_response"], ["large", "response_too_large"], ["redirect", "http_status"], ["http", "http_status"]]) {
      f.set(mode);
      const result = await probeDevService("api", f.url, signal, 200);
      assert.equal(result.ready, false, mode);
      assert.equal(result.reason, reason, mode);
      assert.doesNotMatch(JSON.stringify(result), /private-body-canary/);
    }
    f.set("worker");
    assert.equal((await probeDevService("worker", f.url, signal, 200)).ready, true);
    f.set("invalid");
    assert.equal((await probeDevService("web", f.url, signal, 200)).ready, true, "Web startup checks the document status, not a JSON API contract");
  } finally { await f.close(); }
});

test("dev probes bound stalled response bodies and respect supervisor cancellation", async () => {
  const f = await fixture(); f.set("hang");
  try {
    const began = performance.now();
    const result = await probeDevService("api", f.url, new AbortController().signal, 50);
    assert.equal(result.ready, false); assert.equal(result.reason, "timeout");
    assert.ok(performance.now() - began < 700);
    const controller = new AbortController();
    const pending = probeDevService("api", f.url, controller.signal, 10_000);
    controller.abort();
    assert.equal((await pending).reason, "cancelled");
  } finally { await f.close(); }
});
