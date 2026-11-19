import assert from "node:assert/strict";
import { once, EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { HttpCollectionAdmission, httpCollectionAdmissionSettings } from "./http-collection-admission.ts";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createApiServer } from "../server.ts";
import { createSqliteClient, runSqliteMigrations } from "../persistence/sqlite.ts";
import { createSqliteStore } from "../persistence/sqlite-store.ts";

async function fixture(t: test.TestContext, env: NodeJS.ProcessEnv = {}) {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  await runSqliteMigrations(db);
  const store = createSqliteStore(db);
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const reads: string[] = [];
  const server = createApiServer({ env: { API_METRICS_ENABLED: "true", API_COLLECTION_CONCURRENCY: "1", API_COLLECTION_QUEUE: "0", ...env }, logger: () => {}, store: {
    ...store, async listPublishedArticles(input = {}) {
      reads.push(input.query ?? "");
      if (input.query === "hold") { entered(); await blocked; }
      return store.listPublishedArticles(input);
    },
  } });
  server.listen(0, "0.0.0.0"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    release(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
  });
  return { server, origin, started, release, reads };
}
async function metric(origin: string) { return (await (await fetch(origin + "/metrics")).text()); }
async function waitForMetric(origin: string, pattern: RegExp) {
  const until = Date.now() + 1000;
  let latest = "";
  do { latest = await metric(origin); if (pattern.test(latest)) return; await delay(5); } while (Date.now() < until);
  assert.match(latest, pattern);
}

test("native collection admission bounds physical handlers, not just open downstream sockets, without blocking identity or health", { timeout: 5000 }, async t => {
  const web = await fixture(t), controller = new AbortController();
  const first = fetch(`${web.origin}/api/v1/articles?query=hold`, { signal: controller.signal });
  const cancelled = assert.rejects(first, error => error instanceof Error && error.name === "AbortError");
  try {
    await web.started;
    const full = await fetch(`${web.origin}/api/v1/articles`);
    assert.equal(full.status, 503);
    assert.equal(full.headers.get("retry-after"), "1");
    assert.equal(full.headers.get("cache-control"), "no-store");
    assert.equal((await full.json()).error.code, "COLLECTION_BUSY");
    assert.equal((await fetch(`${web.origin}/health`)).status, 200);
    assert.equal((await fetch(`${web.origin}/api/v1/me`)).status, 401);
    controller.abort(); await cancelled;
    await waitForMetric(web.origin, /api_http_collection_detached 1/);
    assert.equal((await fetch(`${web.origin}/api/v1/articles`)).status, 503, "an uncooperative persistence read still owns physical capacity after browser cancellation");
    assert.deepEqual(web.reads, ["hold"]);
    web.release();
    await waitForMetric(web.origin, /api_http_collection_active 0/);
    assert.equal((await fetch(`${web.origin}/api/v1/articles?query=after`)).status, 200);
    assert.deepEqual(web.reads, ["hold", "after"]);
  } finally { controller.abort(); await cancelled; }
});

test("queued collection work expires or cancels without querying the store, then a live FIFO waiter receives released capacity", { timeout: 5000 }, async t => {
  const web = await fixture(t, { API_COLLECTION_QUEUE: "1", API_COLLECTION_QUEUE_TIMEOUT_MS: "40" });
  const first = fetch(`${web.origin}/api/v1/articles?query=hold`);
  void first.catch(() => {});
  await web.started;
  const expired = await fetch(`${web.origin}/api/v1/articles?query=expired`);
  assert.equal(expired.status, 503); await expired.arrayBuffer();
  const controller = new AbortController();
  const second = fetch(`${web.origin}/api/v1/articles?query=cancelled`, { signal: controller.signal });
  const rejected = assert.rejects(second, error => error instanceof Error && error.name === "AbortError");
  await waitForMetric(web.origin, /api_http_collection_queued 1/);
  controller.abort(); await rejected;
  await waitForMetric(web.origin, /api_http_collection_queued 0/);
  const live = fetch(`${web.origin}/api/v1/articles?query=live`);
  await waitForMetric(web.origin, /api_http_collection_queued 1/);
  web.release();
  assert.equal((await first).status, 200); assert.equal((await live).status, 200);
  assert.deepEqual(web.reads, ["hold", "live"]);
  const metrics = await metric(web.origin);
  assert.match(metrics, /api_http_collection_admission_rejections_total\{reason="timeout"\} 1/);
  assert.match(metrics, /api_http_collection_admission_rejections_total\{reason="cancelled"\} 1/);
  assert.doesNotMatch(metrics, /query=hold|query=cancelled/);
});


test("socket and handler completion each retain the lease alone; stop removes queued waiters without reclaiming unfinished physical work", async () => {
  const pool = new HttpCollectionAdmission({ active: 1, queued: 2, waitMs: 1000 });
  const socket = () => Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, writableFinished: false });
  const first = socket(), second = socket(), third = socket();
  const lease = await pool.acquire(first as unknown as ServerResponse); assert.ok(lease);
  const queued = pool.acquire(second as unknown as ServerResponse);
  const queuedAgain = pool.acquire(third as unknown as ServerResponse);
  lease.finish();
  assert.match(pool.renderMetrics(), /api_http_collection_active 1/);
  assert.match(pool.renderMetrics(), /api_http_collection_queued 2/);
  pool.stop(); pool.stop();
  assert.equal(await queued, null); assert.equal(await queuedAgain, null);
  assert.equal(await pool.acquire(socket() as unknown as ServerResponse), null);
  assert.match(pool.renderMetrics(), /api_http_collection_active 1/);
  first.emit("finish"); lease.finish(); first.emit("close");
  assert.match(pool.renderMetrics(), /api_http_collection_active 0/);
  assert.match(pool.renderMetrics(), /api_http_collection_admission_rejections_total\{reason="closing"\} 3/);
  for (const response of [first, second, third]) for (const event of ["close", "finish"]) assert.equal(response.listenerCount(event), 0);
});

test("collection admission rejects malformed operator settings before serving requests", () => {
  assert.deepEqual(httpCollectionAdmissionSettings({}), { active: 4, queued: 16, waitMs: 250 });
  for (const [name, values] of Object.entries({ API_COLLECTION_CONCURRENCY: ["0", "33", "private-setting-canary"],
    API_COLLECTION_QUEUE: ["-1", "129", "1.5"], API_COLLECTION_QUEUE_TIMEOUT_MS: ["0", "5001", "1e2"] })) {
    for (const value of values) assert.throws(() => createApiServer({ env: { [name]: value }, logger: () => {} }), error => {
      assert.ok(error instanceof RangeError); assert.doesNotMatch(error.message, /private-setting-canary/); return true;
    });
  }
});

test("one shared drain waits for physical handler and socket completion in either order", async () => {
  for (const socketFirst of [false, true]) {
    const response = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, writableFinished: false });
    const pool = new HttpCollectionAdmission({ active: 1, queued: 0, waitMs: 1 });
    const lease = await pool.acquire(response as unknown as ServerResponse); assert.ok(lease);
    let done = false;
    const draining = pool.drain();
    assert.equal(pool.drain(), draining);
    void draining.then(() => { done = true; });
    if (socketFirst) response.emit("close"); else lease.finish();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(done, false);
    if (socketFirst) lease.finish(); else response.emit("finish");
    await draining;
    assert.equal(done, true);
    await pool.drain();
  }
});
