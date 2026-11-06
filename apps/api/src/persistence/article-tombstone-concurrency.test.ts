import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, type TestContext } from "node:test";
import { Worker } from "node:worker_threads";
import { ArticleNotFoundError, IdempotencyConflictError } from "../domain/errors.ts";
import type { TypedPersistenceAdapterContract } from "../application/persistence-ports.ts";
import { runMigrations } from "./migrate.ts";
import { createPostgresClient, createPostgresStore } from "./postgres.ts";
import type { PgDatabase, PgRow, PgTransaction } from "./postgres-driver.ts";
import { createPostgresProviderMigrationJournal } from "./postgres-provider-migration-journal.ts";
import { createPostgresProviderMigrationReplayer } from "./postgres-provider-migration-replayer.ts";
import { prepareMigrationReplayTarget, replayNextMigrationBatch } from "./provider-migration-replay.ts";
import { prepareMigrationRowPayload } from "./provider-migration-row-applier.ts";
import { createSqliteClient, runSqliteMigrations } from "./sqlite.ts";
import { createSqliteStore } from "./sqlite-store.ts";
import { createSqliteProviderMigrationJournal } from "./sqlite-provider-migration-journal.ts";
import { createSqliteProviderMigrationReplayer } from "./sqlite-provider-migration-replayer.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const pgOptions = {
  skip: !connectionString && "Set TEST_DATABASE_URL to run PostgreSQL tombstone concurrency tests.",
  timeout: 30_000,
};
const expiredAt = "2000-01-01T00:00:00.000Z";
const sweepAt = "2000-02-01T00:00:00.000Z";
const commentText = "A reader's words must survive a winning restore.";
let sql: PgDatabase;
let store: TypedPersistenceAdapterContract;

before(async () => {
  if (!connectionString) return;
  sql = await createPostgresClient({ connectionString, max: 8 });
  await runMigrations(sql);
  store = createPostgresStore(sql);
});
after(async () => { if (sql) await sql.end({ timeout: 5 }); });

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
type Deferred<T = void> = ReturnType<typeof deferred<T>>;

// The timeout is only a failure guard. Test ordering comes from transaction
// barriers and, where relevant, PostgreSQL's observed blocking relationship.
async function bounded<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), 10_000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

// Run a real store transaction, but hold its commit after all its mutations and
// journal entries are written. Other connections therefore see the old version.
function holdBeforeCommit(db: PgDatabase, ready: Deferred<number>, release: Deferred): PgDatabase {
  return {
    unsafe: (...args) => db.unsafe(...args),
    end: (...args) => db.end(...args),
    begin: (work) => db.begin(async (tx) => {
      const [backend] = await tx.unsafe<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const result = await work(tx);
      ready.resolve(backend.pid);
      await release.promise;
      return result;
    }),
  };
}

// Pause after the sweep's candidate query actually ran, not after an arbitrary
// wall-clock delay. This wrapper does not fake results or database locking.
function holdAfterSweepSelection(db: PgDatabase, selected: Deferred<number>, release: Deferred): PgDatabase {
  return {
    unsafe: (...args) => db.unsafe(...args),
    end: (...args) => db.end(...args),
    begin: (work) => db.begin(async (tx) => {
      const [backend] = await tx.unsafe<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      return work({
        async unsafe<TRow = PgRow>(query: string, parameters?: readonly unknown[]): Promise<TRow[]> {
          const rows = await tx.unsafe<TRow>(query, parameters);
          if (query.startsWith("SELECT id FROM articles WHERE deleted_at IS NOT NULL")) {
            selected.resolve(backend.pid);
            await release.promise;
          }
          return rows;
        },
      });
    }),
  };
}

// Signal immediately before the real restore lock query; the observer then
// checks pg_blocking_pids, so the test does not guess whether it is blocked.
function observeRestoreLock(db: PgDatabase, attempting: Deferred<number>): PgDatabase {
  return {
    unsafe: (...args) => db.unsafe(...args),
    end: (...args) => db.end(...args),
    begin: (work) => db.begin(async (tx: PgTransaction) => {
      const [backend] = await tx.unsafe<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      return work({
        unsafe<TRow = PgRow>(query: string, parameters?: readonly unknown[]): Promise<TRow[]> {
          if (query.startsWith("SELECT author_id, slug, deleted_at FROM articles")) attempting.resolve(backend.pid);
          return tx.unsafe<TRow>(query, parameters);
        },
      });
    }),
  };
}

async function waitUntilBlockedBy(waiter: number, blocker: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [row] = await sql.unsafe<{ blocked: boolean }>(
      "SELECT $2::integer = ANY(pg_blocking_pids($1::integer)) AS blocked", [waiter, blocker],
    );
    if (row.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("The restore did not wait on the held purge transaction");
}

async function fixture(t: TestContext) {
  const suffix = randomUUID();
  const author = `tombstone-race-author-${suffix}`;
  const slug = `tombstone-race-${suffix}`;
  const sessionId = `tombstone-race-${suffix}`;
  const journal = createPostgresProviderMigrationJournal(sql);
  t.after(async () => {
    await sql.unsafe("DELETE FROM provider_migration_sessions WHERE session_id = $1", [sessionId]);
    await sql.unsafe("DELETE FROM notifications WHERE user_id = $1", [author]);
    await sql.unsafe("DELETE FROM articles WHERE author_id = $1", [author]);
  });
  await journal.createSession({ sessionId, sourceProvider: "postgres", targetProvider: "sqlite", schemaVersion: "integration-v1" });
  assert.equal(await journal.transitionSession({ sessionId, expectedStatus: "prepared", nextStatus: "recording" }), true);
  const article = await store.createArticle({
    authorId: author, slug, title: "A work to keep", locale: "zh-CN", publish: true,
    idempotencyKey: `article-create-${suffix}`,
    contentBlocks: [{ id: "p1", type: "paragraph", text: "A work to keep." }],
  });
  const comment = await store.createArticleComment({ slug, actorId: `reader-${suffix}`, content: commentText });
  await store.deleteArticle({ articleId: article.id, actorId: author });
  // Simulate an old tombstone without waiting 30 days. Its final state is
  // captured normally by restore or purge before replay is asserted below.
  await sql.unsafe("UPDATE articles SET deleted_at = $1 WHERE id = $2", [expiredAt, article.id]);
  return { author, article, comment, journal, sessionId };
}

type ArticleState = { exists: boolean; status: string | null; deleted: boolean; title: string | null; comment: string | null };
function articleState(row: Record<string, unknown> | undefined): ArticleState {
  return {
    exists: Boolean(row),
    status: row ? String(row.status) : null,
    deleted: row ? row.deleted_at !== null : false,
    title: typeof row?.title === "string" ? row.title : null,
    comment: typeof row?.content === "string" ? row.content : null,
  };
}
const sourceStateQuery = `SELECT a.status, a.deleted_at, t.title, c.content
  FROM articles a LEFT JOIN article_translations t ON t.article_id = a.id AND t.locale = 'zh-CN'
  LEFT JOIN article_comments c ON c.article_id = a.id AND c.id = $2 WHERE a.id = $1`;
async function sourceState(articleId: string, commentId: string): Promise<ArticleState> {
  const [row] = await sql.unsafe(sourceStateQuery, [articleId, commentId]);
  return articleState(row);
}

async function drainReplay(input: Parameters<typeof replayNextMigrationBatch>[0]): Promise<void> {
  let remaining: number;
  do {
    // A small limit exercises complete transaction envelopes and checkpointing.
    const result = await replayNextMigrationBatch({ ...input, limit: 1 });
    remaining = result.remainingAtRead;
  } while (remaining > 0);
}

async function replayToSqlite(f: Awaited<ReturnType<typeof fixture>>): Promise<ArticleState> {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  try {
    await runSqliteMigrations(db);
    const target = createSqliteProviderMigrationReplayer(db);
    await prepareMigrationReplayTarget({ sourceJournal: f.journal, targetJournal: target, sessionId: f.sessionId, targetProvider: "sqlite" });
    await drainReplay({ sourceJournal: f.journal, target, sessionId: f.sessionId });
    const changes = await f.journal.readChangeBatch({ sessionId: f.sessionId, afterSequence: 0, limit: 100 });
    assert.equal(await target.getCheckpoint(f.sessionId), changes.at(-1)?.sequence ?? 0);
    const row = db.prepare(`SELECT a.status, a.deleted_at, t.title, c.content
      FROM articles a LEFT JOIN article_translations t ON t.article_id = a.id AND t.locale = 'zh-CN'
      LEFT JOIN article_comments c ON c.article_id = a.id AND c.id = ? WHERE a.id = ?`).get(f.comment.id, f.article.id);
    return articleState(row);
  } finally { db.close(); }
}

for (const deleteAgain of [false, true]) {
  test(`PostgreSQL: a committed restore${deleteAgain ? " followed by a fresh deletion" : ""} wins over an overlapping sweep`, pgOptions, async (t) => {
    const f = await fixture(t);
    const restoreReady = deferred<number>(), releaseRestore = deferred();
    const sweepSelected = deferred<number>(), releaseSweep = deferred();
    const restorer = createPostgresStore(holdBeforeCommit(sql, restoreReady, releaseRestore));
    const sweeper = createPostgresStore(holdAfterSweepSelection(sql, sweepSelected, releaseSweep));
    let restoring: Promise<unknown> | undefined, sweeping: Promise<{ purged: number }> | undefined;
    try {
      restoring = Promise.resolve(restorer.restoreArticle({ articleId: f.article.id, actorId: f.author }));
      void restoring.catch(() => {});
      await bounded(restoreReady.promise, "restore to hold its transaction");
      sweeping = Promise.resolve(sweeper.purgeExpiredArticles({ retentionDays: 30, now: sweepAt, limit: 10 }));
      void sweeping.catch(() => {});
      await bounded(sweepSelected.promise, "sweep to select candidates while restore is uncommitted");
      releaseRestore.resolve();
      const restored = await bounded(restoring, "restore to commit");
      assert.equal((restored as { id: string }).id, f.article.id);
      if (deleteAgain) await store.deleteArticle({ articleId: f.article.id, actorId: f.author });
      releaseSweep.resolve();
      const result = await bounded(sweeping, "sweep to commit");
      const source = await sourceState(f.article.id, f.comment.id);
      const changes = await f.journal.readChangeBatch({ sessionId: f.sessionId, afterSequence: 0, limit: 100 });
      const deletes = changes.filter((change) => change.entityType === "articles" && change.entityId === f.article.id && change.operation === "delete");
      const expected: ArticleState = { exists: true, status: "draft", deleted: deleteAgain, title: "A work to keep", comment: commentText };
      assert.deepEqual({ purged: result.purged, source, articleDeleteEvents: deletes.length },
        { purged: 0, source: expected, articleDeleteEvents: 0 });
      assert.deepEqual(await replayToSqlite(f), expected);
    } finally {
      releaseRestore.resolve(); releaseSweep.resolve();
      await Promise.allSettled([...(restoring ? [restoring] : []), ...(sweeping ? [sweeping] : [])]);
    }
  });
}

test("PostgreSQL: a purge that claimed an article wins; restore waits and reports not found", pgOptions, async (t) => {
  const f = await fixture(t);
  const purgeSelected = deferred<number>(), releasePurge = deferred(), restoreAttempting = deferred<number>();
  const sweeper = createPostgresStore(holdAfterSweepSelection(sql, purgeSelected, releasePurge));
  const restorer = createPostgresStore(observeRestoreLock(sql, restoreAttempting));
  let sweeping: Promise<{ purged: number }> | undefined;
  let restoring: Promise<{ error: unknown } | { value: unknown }> | undefined;
  try {
    sweeping = Promise.resolve(sweeper.purgeExpiredArticles({ retentionDays: 30, now: sweepAt, limit: 10 }));
    void sweeping.catch(() => {});
    const purgePid = await bounded(purgeSelected.promise, "purge to claim its candidate before deleting");
    restoring = Promise.resolve(restorer.restoreArticle({ articleId: f.article.id, actorId: f.author }))
      .then((value) => ({ value }), (error: unknown) => ({ error }));
    const restorePid = await bounded(restoreAttempting.promise, "restore to attempt its row lock");
    await waitUntilBlockedBy(restorePid, purgePid);
    releasePurge.resolve();
    assert.equal((await bounded(sweeping, "purge to commit")).purged, 1);
    const outcome = await bounded(restoring, "restore to finish");
    assert.ok("error" in outcome && outcome.error instanceof ArticleNotFoundError, "a deleted row must not be reported as restored");
    const source = await sourceState(f.article.id, f.comment.id);
    const replayed = await replayToSqlite(f);
    assert.equal(source.exists, false);
    assert.deepEqual(replayed, source);
    const changes = await f.journal.readChangeBatch({ sessionId: f.sessionId, afterSequence: 0, limit: 100 });
    assert.equal(changes.filter((change) => change.entityType === "articles" && change.entityId === f.article.id && change.operation === "delete").length, 1);
    assert.equal(changes.filter((change) => change.entityType === "article_comments" && change.entityId === f.comment.id && change.operation === "delete").length, 1);
  } finally {
    releasePurge.resolve();
    await Promise.allSettled([...(sweeping ? [sweeping] : []), ...(restoring ? [restoring] : [])]);
  }
});

test("PostgreSQL: simultaneous sweeps remove and journal each tombstone exactly once", pgOptions, async (t) => {
  const f = await fixture(t);
  const selected = deferred<number>(), release = deferred();
  const firstStore = createPostgresStore(holdAfterSweepSelection(sql, selected, release));
  let first: Promise<{ purged: number }> | undefined, second: Promise<{ purged: number }> | undefined;
  try {
    first = Promise.resolve(firstStore.purgeExpiredArticles({ retentionDays: 30, now: sweepAt, limit: 10 }));
    void first.catch(() => {});
    await bounded(selected.promise, "first sweep to select its candidates");
    second = Promise.resolve(store.purgeExpiredArticles({ retentionDays: 30, now: sweepAt, limit: 10 }));
    void second.catch(() => {});
    const secondResult = await bounded(second, "second sweep to skip a claimed candidate");
    release.resolve();
    const firstResult = await bounded(first, "first sweep to commit");
    const changes = await f.journal.readChangeBatch({ sessionId: f.sessionId, afterSequence: 0, limit: 100 });
    const articleDeletes = changes.filter((change) => change.entityType === "articles" && change.entityId === f.article.id && change.operation === "delete");
    const commentDeletes = changes.filter((change) => change.entityType === "article_comments" && change.entityId === f.comment.id && change.operation === "delete");
    const source = await sourceState(f.article.id, f.comment.id);
    assert.deepEqual({ first: firstResult.purged, second: secondResult.purged, articleDeletes: articleDeletes.length, commentDeletes: commentDeletes.length, exists: source.exists },
      { first: 1, second: 0, articleDeletes: 1, commentDeletes: 1, exists: false });
    assert.equal(articleDeletes[0].transactionId, commentDeletes[0].transactionId, "cascade tombstones share the purge transaction");
    assert.deepEqual(await replayToSqlite(f), source);
  } finally {
    release.resolve();
    await Promise.allSettled([...(first ? [first] : []), ...(second ? [second] : [])]);
  }
});

for (const sourceProvider of ["sqlite", "postgres"] as const) {
  const targetProvider = sourceProvider === "sqlite" ? "postgres" : "sqlite";
  test(`${sourceProvider} to ${targetProvider}: article replay preserves creation idempotency and rejects conflicting retries`, pgOptions, async (t) => {
    const db = createSqliteClient({ filename: ":memory:", enableWal: false });
    await runSqliteMigrations(db);
    const suffix = randomUUID(), author = `article-replay-${suffix}`, sessionId = `article-replay-${suffix}`;
    t.after(async () => {
      db.close();
      await sql.unsafe("DELETE FROM provider_migration_sessions WHERE session_id = $1", [sessionId]);
      await sql.unsafe("DELETE FROM articles WHERE author_id = $1", [author]);
    });
    const sqliteStore = createSqliteStore(db);
    const sourceStore = sourceProvider === "sqlite" ? sqliteStore : store;
    const targetStore = sourceProvider === "sqlite" ? store : sqliteStore;
    const sourceJournal = sourceProvider === "sqlite" ? createSqliteProviderMigrationJournal(db) : createPostgresProviderMigrationJournal(sql);
    const target = sourceProvider === "sqlite" ? createPostgresProviderMigrationReplayer(sql) : createSqliteProviderMigrationReplayer(db);
    await sourceJournal.createSession({ sessionId, sourceProvider, targetProvider, schemaVersion: "integration-v1" });
    await sourceJournal.transitionSession({ sessionId, expectedStatus: "prepared", nextStatus: "recording" });
    const input = {
      authorId: author, slug: `replay-${suffix}`, title: "Idempotent work", locale: "zh-CN",
      contentBlocks: [{ id: "p1", type: "paragraph", text: "Replay preserves retries." }],
      idempotencyKey: `retry-${suffix}`,
    };
    const original = await sourceStore.createArticle(input);
    const withoutKey = await sourceStore.createArticle({ ...input, slug: `replay-no-key-${suffix}`, idempotencyKey: null });
    await prepareMigrationReplayTarget({ sourceJournal, targetJournal: target, sessionId, targetProvider });
    await drainReplay({ sourceJournal, target, sessionId });
    const retried = await targetStore.createArticle(input);
    assert.equal(retried.id, original.id, "a retry after provider cutover must not create another article");
    await assert.rejects(Promise.resolve().then(() => targetStore.createArticle({ ...input, title: "A conflicting retry" })), IdempotencyConflictError);
    const targetWorks = await targetStore.listMyArticles({ actorId: author });
    assert.deepEqual(new Set(targetWorks.map((work) => work.id)), new Set([original.id, withoutKey.id]));
    await sourceStore.deleteArticle({ articleId: original.id, actorId: author });
    await drainReplay({ sourceJournal, target, sessionId });
    assert.equal((await targetStore.createArticle(input)).id, original.id, "a retry still refers to the tombstoned work");
    assert.ok((await targetStore.listMyDeletedArticles({ actorId: author })).some((work) => work.id === original.id), "retry must not restore or duplicate the tombstone");
    assert.ok(!(await targetStore.listMyArticles({ actorId: author })).some((work) => work.id === original.id));
    await sourceStore.restoreArticle({ articleId: original.id, actorId: author });
    await drainReplay({ sourceJournal, target, sessionId });
    assert.equal((await targetStore.createArticle(input)).id, original.id, "the original retry remains stable after restore replay");
  });
}

test("PostgreSQL: a locked oldest tombstone does not prevent a bounded sweep from processing the next", pgOptions, async (t) => {
  const f = await fixture(t);
  const second = await store.createArticle({
    authorId: f.author, slug: `next-${randomUUID()}`, title: "Next expired work", locale: "zh-CN",
    contentBlocks: [{ id: "p1", type: "paragraph", text: "Also expired." }],
  });
  await store.deleteArticle({ articleId: second.id, actorId: f.author });
  await sql.unsafe("UPDATE articles SET deleted_at = $1 WHERE id = $2", ["2000-01-01T12:00:00.000Z", second.id]);
  const restoreReady = deferred<number>(), releaseRestore = deferred(), selected = deferred<number>(), releaseSweep = deferred();
  const restorer = createPostgresStore(holdBeforeCommit(sql, restoreReady, releaseRestore));
  const sweeper = createPostgresStore(holdAfterSweepSelection(sql, selected, releaseSweep));
  let restoring: Promise<unknown> | undefined, sweeping: Promise<{ purged: number }> | undefined;
  try {
    restoring = Promise.resolve(restorer.restoreArticle({ articleId: f.article.id, actorId: f.author }));
    void restoring.catch(() => {});
    await bounded(restoreReady.promise, "oldest restore to hold its transaction");
    sweeping = Promise.resolve(sweeper.purgeExpiredArticles({ retentionDays: 30, now: sweepAt, limit: 1 }));
    void sweeping.catch(() => {});
    await bounded(selected.promise, "bounded sweep to select an unlocked candidate");
    releaseRestore.resolve();
    await bounded(restoring, "restore to commit");
    releaseSweep.resolve();
    assert.equal((await bounded(sweeping, "bounded sweep to commit")).purged, 1);
    assert.equal((await sourceState(f.article.id, f.comment.id)).exists, true);
    assert.equal((await sql.unsafe("SELECT id FROM articles WHERE id = $1", [second.id])).length, 0);
    const changes = await f.journal.readChangeBatch({ sessionId: f.sessionId, afterSequence: 0, limit: 100 });
    assert.equal(changes.filter((change) => change.entityType === "articles" && change.entityId === f.article.id && change.operation === "delete").length, 0);
    assert.equal(changes.filter((change) => change.entityType === "articles" && change.entityId === second.id && change.operation === "delete").length, 1);
    assert.deepEqual(await replayToSqlite(f), await sourceState(f.article.id, f.comment.id));
  } finally {
    releaseRestore.resolve(); releaseSweep.resolve();
    await Promise.allSettled([...(restoring ? [restoring] : []), ...(sweeping ? [sweeping] : [])]);
  }
});

test("PostgreSQL: an aborted restore leaves a skipped tombstone eligible for a later sweep", pgOptions, async (t) => {
  const f = await fixture(t);
  const restoreReady = deferred(), abortRestore = deferred(), selected = deferred<number>(), releaseSweep = deferred();
  const rollback = new Error("rollback the restore");
  const aborting: PgDatabase = {
    unsafe: (...args) => sql.unsafe(...args),
    end: (...args) => sql.end(...args),
    begin: (work) => sql.begin(async (tx) => {
      await work(tx);
      restoreReady.resolve();
      await abortRestore.promise;
      throw rollback;
    }),
  };
  const restorer = createPostgresStore(aborting);
  const sweeper = createPostgresStore(holdAfterSweepSelection(sql, selected, releaseSweep));
  let restoring: Promise<unknown> | undefined, sweeping: Promise<{ purged: number }> | undefined;
  try {
    restoring = Promise.resolve(restorer.restoreArticle({ articleId: f.article.id, actorId: f.author }));
    void restoring.catch(() => {});
    await bounded(restoreReady.promise, "restore to reach its rollback barrier");
    sweeping = Promise.resolve(sweeper.purgeExpiredArticles({ retentionDays: 30, now: sweepAt, limit: 10 }));
    void sweeping.catch(() => {});
    await bounded(selected.promise, "sweep to skip the locked candidate");
    abortRestore.resolve();
    await assert.rejects(bounded(restoring, "restore to roll back"), (error) => error === rollback);
    releaseSweep.resolve();
    assert.equal((await bounded(sweeping, "first sweep to finish")).purged, 0);
    assert.equal((await sourceState(f.article.id, f.comment.id)).deleted, true);
    assert.equal((await store.purgeExpiredArticles({ retentionDays: 30, now: sweepAt, limit: 10 })).purged, 1);
    const changes = await f.journal.readChangeBatch({ sessionId: f.sessionId, afterSequence: 0, limit: 100 });
    assert.equal(changes.filter((change) => change.entityType === "articles" && change.entityId === f.article.id && change.operation === "upsert").length, 2, "the rolled-back restore is not journaled");
    assert.equal(changes.filter((change) => change.entityType === "articles" && change.entityId === f.article.id && change.operation === "delete").length, 1);
    assert.deepEqual(await replayToSqlite(f), await sourceState(f.article.id, f.comment.id));
  } finally {
    abortRestore.resolve(); releaseSweep.resolve();
    await Promise.allSettled([...(restoring ? [restoring] : []), ...(sweeping ? [sweeping] : [])]);
  }
});

type SqliteWorkerOutcome =
  | { ok: true; result: { id?: string; purged?: number } }
  | { ok: false; name: string; message: string };
function sqliteWorker(input: {
  filename: string; articleId: string; author: string; operation: "restore" | "purge"; now: string; gate?: SharedArrayBuffer;
}) {
  const beginning = deferred(), holding = deferred(), done = deferred<SqliteWorkerOutcome>();
  let outcome: SqliteWorkerOutcome | undefined;
  const worker = new Worker(new URL("./test-support/sqlite-tombstone-race-worker.ts", import.meta.url), { workerData: input });
  const finish = (value: SqliteWorkerOutcome) => {
    if (outcome) return;
    outcome = value;
    beginning.resolve(); holding.resolve(); done.resolve(value);
  };
  worker.on("message", (message: { type: string; result?: { id?: string; purged?: number }; name?: string; message?: string }) => {
    if (message.type === "before-begin") beginning.resolve();
    if (message.type === "before-commit") holding.resolve();
    if (message.type === "done") finish({ ok: true, result: message.result ?? {} });
    if (message.type === "error") finish({ ok: false, name: message.name ?? "Error", message: message.message ?? "Worker failed" });
  });
  worker.on("error", (error) => finish({ ok: false, name: error.name, message: error.message }));
  worker.on("exit", (code) => finish({ ok: false, name: "WorkerExit", message: `Worker exited before reporting a result (${code})` }));
  return {
    worker,
    async beginning() { await bounded(beginning.promise, "SQLite worker to begin its transaction"); },
    async holding() {
      await bounded(holding.promise, "SQLite worker to hold its transaction");
      if (outcome?.ok === false) throw new Error(`${outcome.name}: ${outcome.message}`);
    },
    done: () => bounded(done.promise, "SQLite worker result"),
  };
}

for (const [firstOperation, secondOperation] of [["restore", "purge"], ["purge", "restore"], ["purge", "purge"]] as const) {
  test(`SQLite: ${firstOperation} followed concurrently by ${secondOperation} serializes on the write transaction`, { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "nw-tombstone-race-"));
    const filename = join(directory, "race.sqlite");
    const db = createSqliteClient({ filename });
    const workers: Worker[] = [];
    const gate = new SharedArrayBuffer(4);
    const suffix = randomUUID(), author = `sqlite-tombstone-${suffix}`, sessionId = `sqlite-tombstone-${suffix}`;
    try {
      await runSqliteMigrations(db);
      const sqliteStore = createSqliteStore(db), journal = createSqliteProviderMigrationJournal(db);
      journal.createSession({ sessionId, sourceProvider: "sqlite", targetProvider: "postgres", schemaVersion: "integration-v1" });
      journal.transitionSession({ sessionId, expectedStatus: "prepared", nextStatus: "recording" });
      const slug = `sqlite-race-${suffix}`;
      const article = await sqliteStore.createArticle({
        authorId: author, slug, title: "A work to keep", locale: "zh-CN", publish: true,
        contentBlocks: [{ id: "p1", type: "paragraph", text: "A work to keep." }],
      });
      const comment = await sqliteStore.createArticleComment({ slug, actorId: `reader-${suffix}`, content: commentText });
      await sqliteStore.deleteArticle({ articleId: article.id, actorId: author });
      db.prepare("UPDATE articles SET deleted_at = ? WHERE id = ?").run(expiredAt, article.id);
      const input = { filename, articleId: article.id, author, now: sweepAt };
      const first = sqliteWorker({ ...input, operation: firstOperation, gate }); workers.push(first.worker);
      await first.holding();
      // An independent connection confirms the first writer really holds the
      // SQLite write lock; no sleep is used to infer transaction ordering.
      const observer = createSqliteClient({ filename, timeoutMs: 0, enableWal: false });
      try { assert.throws(() => observer.exec("BEGIN IMMEDIATE"), /locked|busy/i); }
      finally { if (observer.isTransaction) observer.exec("ROLLBACK"); observer.close(); }
      const second = sqliteWorker({ ...input, operation: secondOperation }); workers.push(second.worker);
      await second.beginning();
      Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0);
      const firstResult = await first.done(), secondResult = await second.done();
      if (firstResult.ok === false) throw new Error(`${firstResult.name}: ${firstResult.message}`);
      const source = articleState(db.prepare(`SELECT a.status, a.deleted_at, t.title, c.content
        FROM articles a LEFT JOIN article_translations t ON t.article_id = a.id AND t.locale = 'zh-CN'
        LEFT JOIN article_comments c ON c.article_id = a.id AND c.id = ? WHERE a.id = ?`).get(comment.id, article.id));
      const changes = journal.readChangeBatch({ sessionId, afterSequence: 0, limit: 100 });
      const articleDeletes = changes.filter((change) => change.entityType === "articles" && change.entityId === article.id && change.operation === "delete");
      const commentDeletes = changes.filter((change) => change.entityType === "article_comments" && change.entityId === comment.id && change.operation === "delete");
      if (firstOperation === "restore") {
        assert.equal(firstResult.result.id, article.id);
        assert.ok(secondResult.ok);
        assert.equal(secondResult.result.purged, 0);
        assert.deepEqual(source, { exists: true, status: "draft", deleted: false, title: "A work to keep", comment: commentText });
        assert.equal(articleDeletes.length, 0);
        assert.equal(commentDeletes.length, 0);
      } else {
        assert.equal(firstResult.result.purged, 1);
        if (secondOperation === "restore") {
          assert.ok(secondResult.ok === false && secondResult.name === "ArticleNotFoundError");
        } else {
          assert.ok(secondResult.ok);
          assert.equal(secondResult.result.purged, 0);
        }
        assert.equal(source.exists, false);
        assert.equal(articleDeletes.length, 1);
        assert.equal(commentDeletes.length, 1);
        assert.equal(articleDeletes[0].transactionId, commentDeletes[0].transactionId);
      }
      if (connectionString) {
        const target = createPostgresProviderMigrationReplayer(sql);
        await prepareMigrationReplayTarget({ sourceJournal: journal, targetJournal: target, sessionId, targetProvider: "postgres" });
        await drainReplay({ sourceJournal: journal, target, sessionId });
        assert.deepEqual(await sourceState(article.id, comment.id), source);
      }
    } finally {
      Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0);
      await Promise.all(workers.map((worker) => worker.terminate()));
      db.close();
      await rm(directory, { recursive: true, force: true });
      if (connectionString) {
        await sql.unsafe("DELETE FROM provider_migration_sessions WHERE session_id = $1", [sessionId]);
        await sql.unsafe("DELETE FROM notifications WHERE user_id = $1", [author]);
        await sql.unsafe("DELETE FROM articles WHERE author_id = $1", [author]);
      }
    }
  });
}

test("article replay allowlist carries idempotency digests without accepting unrecognized columns", () => {
  for (const provider of ["sqlite", "postgres"] as const) {
    const payload = { id: "article", idempotency_key_hash: "a".repeat(64), request_hash: "b".repeat(64) };
    const prepared = prepareMigrationRowPayload(provider, "articles", "article", payload);
    assert.equal(prepared.payload.idempotency_key_hash, payload.idempotency_key_hash);
    assert.equal(prepared.payload.request_hash, payload.request_hash);
    assert.throws(() => prepareMigrationRowPayload(provider, "articles", "article", { ...payload, unexpected_column: "no" }), /unsupported columns/i);
    assert.throws(() => prepareMigrationRowPayload(provider, "articles", "different-id", payload), /does not match/i);
  }
});

test("PostgreSQL: a failed purge rolls back article, comments, and journal together", pgOptions, async (t) => {
  const f = await fixture(t), failure = new Error("injected purge failure");
  const failing: PgDatabase = {
    unsafe: (...args) => sql.unsafe(...args),
    end: (...args) => sql.end(...args),
    begin: (work) => sql.begin(async (tx) => {
      // Fail after the real deletion and journal capture, immediately before commit.
      await work(tx);
      throw failure;
    }),
  };
  const sweeper = createPostgresStore(failing);
  await assert.rejects(Promise.resolve(sweeper.purgeExpiredArticles({ retentionDays: 30, now: sweepAt })), (error) => error === failure);
  assert.deepEqual(await sourceState(f.article.id, f.comment.id), { exists: true, status: "draft", deleted: true, title: "A work to keep", comment: commentText });
  const beforeRetry = await f.journal.readChangeBatch({ sessionId: f.sessionId, afterSequence: 0, limit: 100 });
  assert.equal(beforeRetry.filter((change) => change.operation === "delete").length, 0);
  assert.equal((await store.purgeExpiredArticles({ retentionDays: 30, now: sweepAt })).purged, 1);
  const afterRetry = await f.journal.readChangeBatch({ sessionId: f.sessionId, afterSequence: 0, limit: 100 });
  assert.equal(afterRetry.filter((change) => change.entityType === "articles" && change.entityId === f.article.id && change.operation === "delete").length, 1);
  assert.deepEqual(await replayToSqlite(f), await sourceState(f.article.id, f.comment.id));
});

test("SQLite: a failed purge commit rolls back article, comments, and journal together", async () => {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  try {
    await runSqliteMigrations(db);
    const sqliteStore = createSqliteStore(db), journal = createSqliteProviderMigrationJournal(db);
    const suffix = randomUUID(), author = `rollback-${suffix}`, sessionId = `rollback-${suffix}`, slug = `rollback-${suffix}`;
    journal.createSession({ sessionId, sourceProvider: "sqlite", targetProvider: "postgres", schemaVersion: "integration-v1" });
    journal.transitionSession({ sessionId, expectedStatus: "prepared", nextStatus: "recording" });
    const article = await sqliteStore.createArticle({
      authorId: author, slug, title: "A work to keep", locale: "zh-CN", publish: true,
      contentBlocks: [{ id: "p1", type: "paragraph", text: "A work to keep." }],
    });
    const comment = await sqliteStore.createArticleComment({ slug, actorId: `reader-${suffix}`, content: commentText });
    await sqliteStore.deleteArticle({ articleId: article.id, actorId: author });
    db.prepare("UPDATE articles SET deleted_at = ? WHERE id = ?").run(expiredAt, article.id);
    const originalExec = db.exec.bind(db), failure = new Error("injected commit failure");
    Object.defineProperty(db, "exec", { configurable: true, value: (query: string) => {
      if (query === "COMMIT") throw failure;
      return originalExec(query);
    } });
    try {
      assert.throws(() => sqliteStore.purgeExpiredArticles({ retentionDays: 30, now: sweepAt }), (error) => error === failure);
    } finally { Object.defineProperty(db, "exec", { configurable: true, value: originalExec }); }
    const row = db.prepare(`SELECT a.status, a.deleted_at, t.title, c.content
      FROM articles a LEFT JOIN article_translations t ON t.article_id = a.id AND t.locale = 'zh-CN'
      LEFT JOIN article_comments c ON c.article_id = a.id AND c.id = ? WHERE a.id = ?`).get(comment.id, article.id);
    assert.deepEqual(articleState(row), { exists: true, status: "draft", deleted: true, title: "A work to keep", comment: commentText });
    assert.equal(journal.readChangeBatch({ sessionId, afterSequence: 0, limit: 100 }).filter((change) => change.operation === "delete").length, 0);
    assert.equal((await sqliteStore.purgeExpiredArticles({ retentionDays: 30, now: sweepAt })).purged, 1);
    assert.equal(journal.readChangeBatch({ sessionId, afterSequence: 0, limit: 100 }).filter((change) => change.entityType === "articles" && change.entityId === article.id && change.operation === "delete").length, 1);
  } finally { db.close(); }
});
