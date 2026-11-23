import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createApiServer } from "../server.ts";
import { createSqliteClient, runSqliteMigrations } from "../persistence/sqlite.ts";
import { createSqliteStore } from "../persistence/sqlite-store.ts";
import type { StoredArticle } from "../application/persistence-ports.ts";

async function blockedRead(t: test.TestContext, phase: "body" | "metadata" = "body") {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  await runSqliteMigrations(db);
  const store = createSqliteStore(db);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const article: StoredArticle = { id: "00000000-0000-4000-8000-000000000366", authorId: "00000000-0000-4000-8000-000000000001", slug: "held-read", title: "Held read", locale: "en", workType: "other", status: "published", summary: "", contentBlocks: [{ id: "p", type: "paragraph", text: "complete" }], contentBlocksVersion: 0, viewCount: 0, createdAt: null, updatedAt: null, publishedAt: "2026-11-12T00:00:00.000Z" };
  let metadata = 0, reads = 0, readSignal: AbortSignal | undefined;
  const server = createApiServer({ env: { API_METRICS_ENABLED: "true", API_COLLECTION_CONCURRENCY: "1", API_COLLECTION_QUEUE: "0", API_COLLECTION_READ_TIMEOUT_MS: "100" }, logger: () => {}, store: {
    ...store,
    async listPublishedArticles(input = {}) {
      reads++; readSignal = input.signal;
      if (input.query === "hold") {
        if (phase === "body") { entered(); await held; }
        return [article];
      }
      return [];
    },
    async getAuthorProfilesByIds() { metadata++; if (phase === "metadata") throw new Error("private-metadata-failure-canary"); return {}; },
    async listArticlesTaxonomies(input) {
      metadata++;
      if (phase === "metadata" && input.kind === "tag") { entered(); await held; }
      return {};
    },
  } });
  server.listen(0, "0.0.0.0"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => { release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); });
  return { origin, started, release, counts: () => ({ metadata, reads }), readSignal: () => readSignal };
}
async function active(origin: string, pattern: RegExp) {
  let last = "";
  for (let attempt = 0; attempt < 100; attempt++) {
    last = await (await fetch(origin + "/metrics")).text();
    if (pattern.test(last)) return;
    await delay(5);
  }
  assert.match(last, pattern);
}

test("a native collection read deadline answers a blocked database caller without reclaiming its physical slot or starting late metadata queries", { timeout: 5000 }, async t => {
  const fixture = await blockedRead(t);
  const pending = fetch(`${fixture.origin}/api/v1/articles?query=hold`, { signal: AbortSignal.timeout(1500) });
  void pending.catch(() => {});
  await fixture.started;
  const response = await pending;
  assert.equal(response.status, 504);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error: { code: "COLLECTION_READ_TIMEOUT", message: "The article collection could not be read in time." } });
  await active(fixture.origin, /api_http_collection_detached 1/);
  assert.equal((await fetch(fixture.origin + "/api/v1/articles")).status, 503);
  assert.equal((await fetch(fixture.origin + "/health")).status, 200);
  assert.equal((await fetch(fixture.origin + "/api/v1/me")).status, 401);
  assert.deepEqual(fixture.counts(), { metadata: 0, reads: 1 });
  fixture.release();
  await active(fixture.origin, /api_http_collection_active 0/);
  assert.deepEqual(fixture.counts(), { metadata: 0, reads: 1 }, "a late successful database read must not begin the three metadata queries");
  assert.equal((await fetch(fixture.origin + "/api/v1/articles")).status, 200);
  assert.equal(fixture.counts().reads, 2);
});

test("read deadline settings reject explicit malformed values without reflecting operator input", () => {
  for (const value of ["", "0", "99", "600001", "1.5", "1e3", "deadline-private-canary"]) {
    assert.throws(() => createApiServer({ env: { API_COLLECTION_READ_TIMEOUT_MS: value }, logger: () => {} }), error => {
      assert.ok(error instanceof RangeError); assert.doesNotMatch(error.message, /deadline-private-canary/); return true;
    });
  }
});

test("a failed metadata sibling cannot release the collection slot while another metadata read remains physically pending", { timeout: 5000 }, async t => {
  const fixture = await blockedRead(t, "metadata");
  const pending = fetch(`${fixture.origin}/api/v1/articles?query=hold`, { signal: AbortSignal.timeout(1500) });
  void pending.catch(() => {});
  await fixture.started;
  const response = await pending;
  const metrics = await (await fetch(fixture.origin + "/metrics")).text();
  assert.deepEqual({ status: response.status, active: /api_http_collection_active (\d+)/.exec(metrics)?.[1] }, { status: 504, active: "1" });
  assert.doesNotMatch(await response.text(), /private-metadata-failure-canary/);
  await active(fixture.origin, /api_http_collection_detached 1/);
  assert.equal((await fetch(fixture.origin + "/api/v1/articles")).status, 503);
  assert.deepEqual(fixture.counts(), { metadata: 3, reads: 1 });
  fixture.release();
  await active(fixture.origin, /api_http_collection_active 0/);
  assert.equal((await fetch(fixture.origin + "/api/v1/articles")).status, 200);
});

test("a read deadline aborts a card query but still waits for an adapter that ignores that signal", { timeout: 5000 }, async t => {
  const fixture = await blockedRead(t);
  const pending = fetch(`${fixture.origin}/api/v1/articles?query=hold&view=card`, { signal: AbortSignal.timeout(1500) });
  void pending.catch(() => {});
  await fixture.started;
  assert.equal(fixture.readSignal()?.aborted, false);
  const response = await pending;
  assert.equal(response.status, 504); await response.arrayBuffer();
  assert.equal(fixture.readSignal()?.aborted, true);
  await active(fixture.origin, /api_http_collection_detached 1/);
  assert.equal((await fetch(fixture.origin + "/api/v1/articles")).status, 503);
  fixture.release();
  await active(fixture.origin, /api_http_collection_active 0/);
  assert.deepEqual(fixture.counts(), { metadata: 0, reads: 1 });
});
