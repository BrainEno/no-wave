import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApiServer } from "../server.ts";
import { createSqliteClient, runSqliteMigrations, type SqliteRunner } from "./sqlite.ts";
import { createSqliteStore } from "./sqlite-store.ts";

/**
 * Count executions rather than prepares: prepared statements are created at
 * store construction, and a per-row `get` on one prepared statement is still
 * an N+1. Only count SQL issued between request and completed response. Seed
 * work and migrations happen before measurement.
 */
function instrument(database: SqliteRunner & { readonly isTransaction: boolean }) {
  let count = 0;
  const statements: string[] = [];
  const track = (sql: string) => { count++; statements.push(sql); };
  const db: SqliteRunner & { readonly isTransaction: boolean } = {
    get isTransaction() { return database.isTransaction; },
    close: () => database.close(),
    exec(sql) { track(sql); database.exec(sql); },
    prepare(sql) {
      const prepared = database.prepare(sql);
      return {
        get(...values) { track(sql); return prepared.get(...values); },
        all(...values) { track(sql); return prepared.all(...values); },
        run(...values) { track(sql); return prepared.run(...values); },
      };
    },
  };
  return { db, reset() { count = 0; statements.length = 0; }, count: () => count, statements: () => [...statements] };
}

type Snapshot = { status: number; data: unknown; count: number; statements: string[] };
const authEnv = {
  AUTH_JWT_SECRET: "query-budget-test-secret-at-least-32-bytes",
  AUTH_JWT_ISSUER: "http://localhost",
  AUTH_JWT_AUDIENCE: "query-budget-test",
};

async function fixture() {
  const raw = createSqliteClient({ filename: ":memory:", enableWal: false });
  await runSqliteMigrations(raw);
  const counter = instrument(raw);
  const store = createSqliteStore(counter.db);
  for (let index = 0; index < 25; index++) {
    const author = `query-author-${index}`;
    store.upsertAuthorProfile({ userId: author, displayName: `Author ${index}`, locale: "en" });
    store.createArticle({
      authorId: author, slug: `query-work-${index}`, title: `Budget work ${index}`,
      locale: "en", contentBlocks: [{ id: "p1", type: "paragraph", text: "A seeded public work." }], publish: true,
    });
  }
  for (let index = 0; index < 20; index++) {
    const actor = `query-author-${index}`;
    const root = store.createArticleComment({ slug: "query-work-0", locale: "en", actorId: actor, content: `Root ${index}` });
    store.createArticleComment({ slug: "query-work-0", locale: "en", actorId: `query-author-${(index + 1) % 25}`, content: `Reply ${index}`, parentCommentId: root.id });
  }
  const server = createApiServer({ store, env: authEnv, logger: () => {} });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  return {
    counter,
    store,
    async get(path: string): Promise<Snapshot> {
      counter.reset();
      const response = await fetch(base + path);
      const body = await response.json() as { data: unknown };
      return { status: response.status, data: body.data, count: counter.count(), statements: counter.statements() };
    },
    async close() {
      server.close();
      server.closeAllConnections();
      await once(server, "close");
      raw.close();
    },
  };
}

function withinBudget(snapshot: Snapshot, limit: number, label: string) {
  assert.equal(snapshot.status, 200, `${label}: request must succeed`);
  assert.ok(snapshot.count > 0, `${label}: instrumentation must observe SQL`);
  assert.ok(snapshot.count <= limit, `${label}: ${snapshot.count} statements exceeds ${limit}\n${snapshot.statements.join("\n---\n")}`);
}

test("public list uses a bounded number of SQL executions regardless of page size", async () => {
  const f = await fixture();
  try {
    const small = await f.get("/api/v1/articles?locale=en&limit=1");
    const large = await f.get("/api/v1/articles?locale=en&limit=20");
    assert.equal((small.data as unknown[]).length, 1);
    assert.equal((large.data as unknown[]).length, 20);
    assert.ok((large.data as Array<{ author: unknown }>).every((article) => article.author), "authors were actually projected");
    withinBudget(small, 5, "one article");
    withinBudget(large, 5, "twenty articles");
    assert.equal(large.count, small.count, "more rows must not cause more SQL executions");
  } finally { await f.close(); }
});

test("article detail projection stays within a deterministic statement budget", async () => {
  const f = await fixture();
  try {
    const detail = await f.get("/api/v1/articles/query-work-0?locale=en");
    assert.equal((detail.data as { slug: string }).slug, "query-work-0");
    assert.ok((detail.data as { author: unknown }).author);
    withinBudget(detail, 5, "article detail");
  } finally { await f.close(); }
});

test("comment roots and replies use a bounded count at different page sizes", async () => {
  const f = await fixture();
  try {
    const small = await f.get("/api/v1/articles/query-work-0/comments?locale=en&limit=1");
    const large = await f.get("/api/v1/articles/query-work-0/comments?locale=en&limit=20");
    const comments = large.data as Array<{ author: unknown; replies: Array<{ author: unknown }> }>;
    assert.equal((small.data as unknown[]).length, 1);
    assert.equal(comments.length, 20);
    assert.ok(comments.every((comment) => comment.author && comment.replies.length === 1 && comment.replies[0]?.author));
    withinBudget(small, 3, "one comment tree");
    withinBudget(large, 3, "twenty comment trees");
    assert.equal(large.count, small.count, "more comments and replies must not cause more SQL executions");
  } finally { await f.close(); }
});

test("the execution counter detects repeated use of a single prepared statement", async () => {
  const f = await fixture();
  try {
    f.counter.reset();
    const stmt = f.counter.db.prepare("SELECT 1 AS value");
    for (let i = 0; i < 12; i++) stmt.get();
    assert.equal(f.counter.count(), 12, "one preparation does not hide twelve executions");
    assert.throws(() => withinBudget({ status: 200, data: null, count: f.counter.count(), statements: f.counter.statements() }, 5, "simulated N+1"), /exceeds 5/);
  } finally { await f.close(); }
});

test("popular, filtered, missing and empty reads remain bounded", async () => {
  const f = await fixture();
  try {
    const popular = await f.get("/api/v1/articles?locale=en&sort=popular&limit=20");
    assert.equal((popular.data as unknown[]).length, 20);
    withinBudget(popular, 5, "popular listing");
    const filtered = await f.get("/api/v1/articles?locale=en&query=Budget&limit=20");
    assert.equal((filtered.data as unknown[]).length, 20);
    withinBudget(filtered, 5, "filtered listing");
    const empty = await f.get("/api/v1/articles?locale=en&query=not-a-seeded-title&limit=20");
    assert.deepEqual(empty.data, []);
    withinBudget(empty, 2, "empty listing");
    const emptyComments = await f.get("/api/v1/articles/query-work-1/comments?locale=en&limit=20");
    assert.deepEqual(emptyComments.data, []);
    withinBudget(emptyComments, 2, "empty comments");
  } finally { await f.close(); }
});
