import assert from "node:assert/strict";
import { once } from "node:events";
import { Agent, createServer, get } from "node:http";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createHttpLifecycle } from "./http-lifecycle.ts";

const env = { SHUTDOWN_GRACE_MS: "350", SHUTDOWN_CLEANUP_MS: "100" };
async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

test("idle keep-alive peers cannot delay shutdown and every durable resource closes once across repeated stop requests", async () => {
  const entries: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => { if (lifecycle.admit(request, response)) response.end("ok"); });
  const lifecycle = createHttpLifecycle(server, { env, log: entry => entries.push(entry) });
  const origin = await listen(server);
  const agent = new Agent({ keepAlive: true });
  await new Promise<void>((resolve, reject) => { get(origin, { agent }, response => { response.resume(); response.once("end", resolve); }).once("error", reject); });
  let closed = 0;
  const first = lifecycle.stop([{ name: "persistence", close: () => { closed += 1; } }], "SIGTERM");
  const second = lifecycle.stop([{ name: "persistence", close: () => { closed += 100; } }], "SIGINT");
  assert.equal(first, second);
  const result = await first;
  agent.destroy();
  assert.equal(closed, 1);
  assert.equal(result.forced, false);
  assert.equal(result.cleanupSucceeded, true);
  assert.equal(result.exitCode, 0);
  assert.ok(result.durationMs < 250);
  assert.equal(entries.filter(entry => entry.event === "api_persistence_closed").length, 1);
});

test("an admitted response finishes before persistence cleanup and requests arriving during drain are rejected", async () => {
  const order: string[] = [];
  let release!: () => void;
  let accepted!: () => void;
  const active = new Promise<void>(resolve => { accepted = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const server = createServer((request, response) => {
    if (!lifecycle.admit(request, response)) return;
    order.push("admitted"); accepted();
    void pending.then(() => { order.push("response"); response.end("completed"); });
  });
  const lifecycle = createHttpLifecycle(server, { env });
  const origin = await listen(server);
  const port = Number(new URL(origin).port);
  const socket = connect(port, "127.0.0.1");
  socket.setEncoding("utf8");
  let output = "";
  socket.on("data", data => { output += String(data); });
  socket.on("error", () => {});
  const closed = once(socket, "close");
  socket.write("GET /first HTTP/1.1\r\nHost: local\r\nConnection: keep-alive\r\n\r\n");
  await active;
  const stop = lifecycle.stop([{ name: "persistence", close: () => { order.push("cleanup"); } }]);
  assert.equal(lifecycle.isDraining(), true);
  socket.write("GET /late HTTP/1.1\r\nHost: local\r\nConnection: close\r\n\r\n");
  await delay(20);
  release();
  const result = await stop;
  await closed;
  assert.deepEqual(order, ["admitted", "response", "cleanup"]);
  assert.equal(result.activeAtStop, 1);
  assert.equal(result.forced, false);
  assert.match(output, /200 OK/);
  assert.match(output, /503 Service Unavailable/);
  assert.match(output, /Retry-After: 1/i);
});

test("cleanup exceptions do not prevent other resources and failed/never-settling cleanup is bounded and reported nonzero", async () => {
  for (const hangs of [false, true]) {
    const entries: Array<Record<string, unknown>> = [];
    const server = createServer();
    const lifecycle = createHttpLifecycle(server, { env, log: entry => { entries.push(entry); } });
    await listen(server);
    let mediaClosed = 0;
    const result = await lifecycle.stop([
      { name: "persistence", close: () => { if (hangs) return new Promise(() => {}); throw new Error("private-connection-string-canary"); } },
      { name: "media", close: () => { mediaClosed += 1; } },
    ]);
    assert.equal(result.exitCode, 1);
    assert.equal(result.cleanupSucceeded, false);
    assert.equal(result.cleanupTimedOut, hangs);
    assert.equal(mediaClosed, 1);
    assert.ok(result.durationMs < 700);
    assert.doesNotMatch(JSON.stringify(entries), /private-connection-string-canary/);
  }
});

test("a stuck background batch spends only the drain share of the absolute deadline and cannot starve resource cleanup", async () => {
  const server = createServer();
  const lifecycle = createHttpLifecycle(server, { env });
  await listen(server);
  let closed = false;
  const result = await lifecycle.stop([{ name: "persistence", close: () => { closed = true; } }], "SIGTERM", () => new Promise(() => {}));
  assert.equal(result.forced, true);
  assert.equal(result.exitCode, 1, "a timed-out background drain must not log a successful exit");
  assert.equal(result.cleanupSucceeded, true);
  assert.equal(closed, true);
  assert.ok(result.durationMs >= 200 && result.durationMs < 700);
});

test("shutdown observer failures cannot interrupt cleanup and a background drain failure is never a successful exit", async () => {
  const server = createServer();
  const lifecycle = createHttpLifecycle(server, { env, log: () => { throw new Error("observer failed"); } });
  await listen(server);
  let cleaned = false;
  const result = await lifecycle.stop([{ name: "persistence", close: () => { cleaned = true; } }], "SIGTERM", () => { throw new Error("private-canary"); });
  assert.equal(cleaned, true);
  assert.equal(result.exitCode, 1);
  assert.equal(result.cleanupSucceeded, true);
});

test("listener close failures cannot report a successful stop and do not prevent resource cleanup or a forced retry", async () => {
  for (const mode of ["callback", "throw"] as const) {
    const entries: Array<Record<string, unknown>> = [];
    const server = createServer();
    const close = server.close.bind(server);
    const lifecycle = createHttpLifecycle(server, { env, log: entry => entries.push(entry) });
    await listen(server);
    let calls = 0, cleaned = 0;
    const failure = Object.assign(new Error("private-listener-close-canary"), { code: "FIXTURE_CLOSE_FAILURE" });
    server.close = ((callback?: (error?: Error) => void) => {
      calls += 1;
      if (calls > 1) return close(callback);
      if (mode === "throw") throw failure;
      callback?.(failure);
      return server;
    }) as typeof server.close;
    try {
      const result = await lifecycle.stop([{ name: "persistence", close: () => { cleaned += 1; } }]);
      assert.equal(cleaned, 1);
      assert.equal(result.cleanupSucceeded, true);
      assert.equal(result.forced, true);
      assert.equal(result.exitCode, 1, "listener failure is terminal even when persistence closes");
      assert.equal(server.listening, false, "retry the failed listener close before returning control");
      assert.equal(calls, 2);
      assert.doesNotMatch(JSON.stringify(entries), /private-listener-close-canary/);
    } finally {
      server.close = close;
      await new Promise<void>(resolve => close(() => resolve()));
      server.closeAllConnections();
    }
  }
});
