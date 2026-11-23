import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { readPostgresArticlePage, readSqliteArticlePage } from "./article-page-reader.ts";
import { createSqliteClient } from "./sqlite.ts";
import { createPostgresClient } from "./postgres.ts";
import type { StoredArticle } from "../application/persistence-ports.ts";

function article(index = 0): StoredArticle {
  return { id: String(index), authorId: "reader-fixture", slug: `work-${index}`, workType: "other", status: "published", locale: "en", title: "Real row", summary: "", contentBlocksVersion: 0,
    contentBlocks: [{ id: "text", type: "paragraph", text: "Complete text for a card." }], createdAt: "2026-11-12T00:00:00.000Z", updatedAt: "2026-11-12T00:00:00.000Z", publishedAt: "2026-11-12T00:00:00.000Z", viewCount: 0 };
}

test("SQLite card reads finish/reset their statement after cancellation, mapper failure and a dishonest row bound", async () => {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  try {
    db.exec("CREATE TABLE reader_fixture (id INTEGER PRIMARY KEY); INSERT INTO reader_fixture VALUES (1), (2), (3);");
    for (const failure of ["abort", "mapper", "limit"] as const) {
      const controller = new AbortController(); let mapped = 0;
      const statement = db.prepare("SELECT id FROM reader_fixture ORDER BY id");
      const pending = readSqliteArticlePage(statement, [], row => {
        mapped++;
        if (failure === "mapper" && mapped === 2) throw new Error("fixture mapper rejected");
        if (failure === "abort" && mapped === 1) setImmediate(() => controller.abort());
        return article(Number(row.id));
      }, { limit: failure === "limit" ? 1 : 3, projection: "card", signal: controller.signal });
      await assert.rejects(Promise.resolve(pending));
      assert.equal(mapped, failure === "abort" ? 1 : 2);
      assert.equal(statement.all().length, 3, "the exact native statement must be reusable, not left busy by an abandoned iterator");
      db.exec("BEGIN IMMEDIATE; UPDATE reader_fixture SET id = id + 10; ROLLBACK;");
    }
    const full = readSqliteArticlePage(db.prepare("SELECT id FROM reader_fixture ORDER BY id"), [], row => article(Number(row.id)), { limit: 3 });
    assert.ok(Array.isArray(full), "legacy full reads remain synchronous");
    assert.equal(full[0]!.contentBlocks.length, 1);
  } finally { db.close(); }
});

test("concurrent SQLite card reads of one cached statement each finish their page, even when the same SQL runs in between", async () => {
  // Regression: card reads yield between rows, and the connection caches one
  // statement per SQL text. Two readers of the featured shelf at once used to
  // fail the first with "iterator was invalidated" (a 500 on the home page).
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  try {
    db.exec("CREATE TABLE reader_fixture (id INTEGER PRIMARY KEY); INSERT INTO reader_fixture VALUES (1), (2), (3);");
    const sql = "SELECT id FROM reader_fixture ORDER BY id";
    const shared = db.prepare(sql);
    assert.equal(db.prepare(sql), shared, "the fixture exercises the connection's shared cached statement");
    const read = () => readSqliteArticlePage(shared, [], row => article(Number(row.id)), { limit: 3, projection: "card" });
    const first = read(), second = read();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(shared.all().length, 3, "a synchronous read of the same SQL while both pages are open");
    const pages = await Promise.all([first, second]);
    assert.deepEqual(pages.map(page => page.map(card => card.id)), [["1", "2", "3"], ["1", "2", "3"]]);
  } finally { db.close(); }
});

test("SQLite projection validation fails before reading and never substitutes all() for a missing iterator", async () => {
  let all = 0;
  const statement = { get() { return undefined; }, run() { return { changes: 0 }; }, all() { all++; return []; } };
  assert.throws(() => readSqliteArticlePage(statement, [], () => article(), { projection: "card", limit: 1 }), /iterate/);
  for (const limit of [0, -1, 101, 1.5, Infinity]) assert.throws(() => readSqliteArticlePage(statement, [], () => article(), { projection: "card", limit }));
  assert.throws(() => readSqliteArticlePage(statement, [], () => article(), { projection: "card", limit: 1, signal: AbortSignal.abort() }));
  assert.equal(all, 0);
});

const database = process.env.TEST_DATABASE_URL;
test("PostgreSQL card cursors detach cancellation and settle the physical portal on success, mapper failure, row overflow and abort", { skip: !database, timeout: 15_000 }, async () => {
  const sql = await createPostgresClient({ connectionString: database, max: 1 });
  try {
    await sql.unsafe("SELECT 1");
    for (const failure of ["none", "mapper", "limit", "abort"] as const) {
      const controller = new AbortController(); let mapped = 0;
      const pending = readPostgresArticlePage(sql, "SELECT i FROM generate_series(1, 3) AS i", [], row => {
        mapped++;
        if (failure === "mapper" && mapped === 2) throw new Error("fixture mapper rejected");
        if (failure === "abort" && mapped === 1) controller.abort();
        return article(Number(row.i));
      }, { projection: "card", limit: failure === "limit" ? 1 : 3, signal: controller.signal });
      if (failure === "none") assert.equal((await pending).length, 3);
      else await assert.rejects(pending);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0, `${failure} retained the request through the driver's abort listener`);
      const reuse = await Promise.race([sql.unsafe("SELECT 1 AS healthy"), delay(1500).then(() => { throw new Error("A card portal retained the only physical connection."); })]);
      assert.equal(reuse[0]!.healthy, 1);
      assert.equal(mapped, failure === "none" ? 3 : failure === "abort" ? 1 : 2);
    }
  } finally { await sql.end({ timeout: 1 }); }
});

test("PostgreSQL cancellation while queued or executing is not a successful empty page and does not cancel a sibling", { skip: !database, timeout: 15_000 }, async () => {
  const sql = await createPostgresClient({ connectionString: database, max: 1 });
  try {
    for (const phase of ["queued", "executing"] as const) {
      const controller = new AbortController(); let mapped = 0;
      const blocker = phase === "queued" ? sql.unsafe("SELECT pg_sleep(0.15)") : undefined;
      const blockerDone = blocker ? Promise.resolve(blocker) : Promise.resolve();
      await delay(10);
      const pending = readPostgresArticlePage(sql, phase === "queued" ? "SELECT 1 AS i" : "SELECT pg_sleep(3), 1 AS i", [], () => { mapped++; return article(); }, { projection: "card", limit: 1, signal: controller.signal });
      const rejected = assert.rejects(pending);
      await delay(30); controller.abort();
      await rejected; await blockerDone;
      assert.equal(mapped, 0);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      assert.equal((await sql.unsafe("SELECT 7 AS sibling"))[0]!.sibling, 7);
    }
  } finally { await sql.end({ timeout: 1 }); }
});
