import assert from "node:assert/strict";
import type { Server } from "node:http";
import { once } from "node:events";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createApiServer } from "../server.ts";
import { createSqliteClient, runSqliteMigrations } from "../persistence/sqlite.ts";
import { createSqliteStore } from "../persistence/sqlite-store.ts";

const env = {
  AUTH_JWT_SECRET: "fixture-only-operations-secret-with-at-least-32-bytes",
  AUTH_JWT_ISSUER: "https://operations.example.test", AUTH_JWT_AUDIENCE: "operations-fixture",
  API_METRICS_ENABLED: "true", API_READINESS_TIMEOUT_MS: "100", API_READINESS_CACHE_MS: "50",
  API_OUTBOX_MAX_PENDING_AGE_MS: "2000",
};
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "0.0.0.0", resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
async function withApi(run: (origin: string, server: Server) => Promise<void>, backlog = { pendingEvents: 0, deadLetterEvents: 0, oldestPendingAgeMs: 0 }, overrides: NodeJS.ProcessEnv = {}) {
  const db = createSqliteClient({ filename: ":memory:" });
  await runSqliteMigrations(db);
  const store = { ...createSqliteStore(db), outboxBacklog: async () => backlog };
  const server = createApiServer({ store, env: { ...env, ...overrides }, logger: () => {} });
  try { await run(await listen(server), server); }
  finally { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); db.close(); }
}

test("operational probes use pathname for GET and HEAD, not query-sensitive raw targets", async () => {
  await withApi(async origin => {
    for (const path of ["/health?probe=one", "/ready?probe=two"]) {
      const response = await fetch(origin + path);
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get("cache-control")!, /no-store/);
      const head = await fetch(origin + path, { method: "HEAD" });
      assert.equal(head.status, 200, path);
      assert.equal(await head.text(), "");
    }
    assert.equal((await fetch(origin + "/healthy?probe=one")).status, 404);
    assert.equal((await fetch(origin + "/ready", { method: "POST" })).status, 404);
  });
});

test("a missing consumer cannot hide an old committed message backlog behind successful database health", async () => {
  await withApi(async origin => {
    const response = await fetch(origin + "/ready");
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.persistence, "ok");
    assert.equal(body.auth, "ok");
    assert.equal(body.notifications.status, "backlogged");
    assert.equal(body.notifications.pendingEvents, 3);
    assert.equal(body.notifications.deadLetterEvents, 1);
    assert.ok(body.notifications.oldestPendingAgeMs >= 5000);
    const metrics = await (await fetch(origin + "/metrics")).text();
    assert.match(metrics, /api_notification_pending_events 3/);
    assert.match(metrics, /api_notification_dead_letter_events 1/);
    assert.match(metrics, /api_notification_oldest_pending_age_seconds [5-9]/);
    assert.equal((await fetch(origin + "/health")).status, 200, "liveness must not cause the consumer's recovery to be restarted");
  }, { pendingEvents: 3, deadLetterEvents: 1, oldestPendingAgeMs: 5000 });
});

test("API HTTP connection budgets are explicit rather than relying on Node's five-minute request default", async () => {
  await withApi(async (_origin, server) => {
    assert.equal(server.headersTimeout, 15_000);
    assert.equal(server.requestTimeout, 60_000);
    assert.equal(server.keepAliveTimeout, 5_000);
  });
});

test("a wedged readiness dependency is bounded and cannot prevent a separate liveness response", async () => {
  const server = createApiServer({ env, logger: () => {}, applicationServices: {
    health: () => new Promise(() => {}),
    outboxBacklog: async () => ({ pendingEvents: 0, deadLetterEvents: 0, oldestPendingAgeMs: 0 }),
  } as unknown as NonNullable<Parameters<typeof createApiServer>[0]>["applicationServices"] });
  const origin = await listen(server);
  try {
    const started = performance.now();
    const response = await fetch(origin + "/ready", { signal: AbortSignal.timeout(1000) });
    assert.equal(response.status, 503);
    assert.ok(performance.now() - started < 800);
    assert.equal((await response.json()).persistence, "unavailable");
    assert.equal((await fetch(origin + "/health")).status, 200);
    await delay(10);
  } finally { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
});

test("configured header/body receive deadlines close real slow clients rather than waiting for Node's thirty-second sweep", async () => {
  await withApi(async origin => {
    for (const request of [
      "GET /health HTTP/1.1\r\nHost: local\r\nX-Unfinished: ",
      "POST /api/v1/auth/login HTTP/1.1\r\nHost: local\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{",
    ]) {
      const socket = connect(Number(new URL(origin).port), "127.0.0.1");
      let output = "";
      socket.setEncoding("utf8"); socket.on("data", data => { output += String(data); }); socket.on("error", () => {});
      const closed = once(socket, "close");
      const began = performance.now();
      socket.write(request);
      try {
        await Promise.race([closed, delay(900, undefined, { ref: false }).then(() => { throw new Error("The receive deadline was not enforced."); })]);
        assert.ok(performance.now() - began < 850);
        assert.match(output, /408 Request Timeout/);
        assert.equal((await fetch(origin + "/health")).status, 200);
      } finally { socket.destroy(); }
    }
  }, undefined, { API_HEADERS_TIMEOUT_MS: "100", API_REQUEST_TIMEOUT_MS: "200", API_KEEP_ALIVE_TIMEOUT_MS: "100" });
});
