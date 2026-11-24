/**
 * Shared harness for the provider-migration-identity-featured suites. Not a test file: node:test
 * discovers only `*.test.ts`; each suite imports what it needs from here.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import { Worker } from "node:worker_threads";

import { createPostgresStore } from "../postgres.ts";
import type { PgDatabase } from "../postgres-driver.ts";
import { createPostgresProviderMigrationJournal } from "../postgres-provider-migration-journal.ts";
import { createPostgresProviderMigrationReplayer } from "../postgres-provider-migration-replayer.ts";
import { MIGRATION_REPLAY_SCHEMA_VERSION } from "../provider-migration-journal.ts";
import { prepareMigrationReplayTarget, replayNextMigrationBatch, type MigrationReplayTarget } from "../provider-migration-replay.ts";

import { createSqliteClient, runSqliteMigrations } from "../sqlite.ts";
import { createSqliteStore } from "../sqlite-store.ts";
import { createSqliteProviderMigrationJournal } from "../sqlite-provider-migration-journal.ts";
import { createSqliteProviderMigrationReplayer } from "../sqlite-provider-migration-replayer.ts";
import { createIsolatedPostgresTestSchema } from "./isolated-postgres-schema.ts";
import { after, type TestContext } from "node:test";

export const connectionString = process.env.TEST_DATABASE_URL;

export const options = { skip: !connectionString && "Set TEST_DATABASE_URL for real cross-provider identity replay tests.", timeout: 30_000 };

type SourceJournal = Parameters<typeof prepareMigrationReplayTarget>[0]["sourceJournal"];

export type Provider = "sqlite" | "postgres";

export const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export const future = () => new Date(Date.now() + 3_600_000).toISOString();

export async function fixture(t: TestContext, sourceProvider: Provider, settings: { prepare?: boolean; schemaVersion?: string; sqliteFile?: string } = {}) {
  const pg = await createIsolatedPostgresTestSchema(connectionString!);
  const db = createSqliteClient({ filename: settings.sqliteFile ?? ":memory:", enableWal: Boolean(settings.sqliteFile) });
  t.after(async () => { db.close(); await pg.cleanup(); });
  await runSqliteMigrations(db);
  const sqlite = createSqliteStore(db), postgres = createPostgresStore(pg.sql);
  const source = sourceProvider === "sqlite" ? sqlite : postgres;
  const targetStore = sourceProvider === "sqlite" ? postgres : sqlite;
  // The SQLite journal types a session's provider as `string`; the replay port wants the
  // literal union. Both journals are driven through that port, so the cast only names it.
  const sourceJournal = (sourceProvider === "sqlite" ? createSqliteProviderMigrationJournal(db) : createPostgresProviderMigrationJournal(pg.sql)) as SourceJournal;
  const target = (sourceProvider === "sqlite" ? createPostgresProviderMigrationReplayer(pg.sql) : createSqliteProviderMigrationReplayer(db)) as MigrationReplayTarget;
  const targetProvider = sourceProvider === "sqlite" ? "postgres" : "sqlite";
  const sessionId = randomUUID();
  await sourceJournal.createSession({ sessionId, sourceProvider, targetProvider, schemaVersion: settings.schemaVersion ?? MIGRATION_REPLAY_SCHEMA_VERSION });
  await sourceJournal.transitionSession({ sessionId, expectedStatus: "prepared", nextStatus: "recording" });
  if (settings.prepare !== false) await prepareMigrationReplayTarget({ sourceJournal, targetJournal: target, sessionId, targetProvider });
  async function drain() {
    let remaining: number;
    do {
      const result = await replayNextMigrationBatch({ sourceJournal, target, sessionId, limit: 1 });
      remaining = result.remainingAtRead;
    } while (remaining > 0);
  }
  async function seedAccount(userId: string, email: string) {
    const account = { ...registration(userId), email };
    assert.equal(await source.createIdentityAccount(account), true);
    await drain();
  }
  return { db, pg: pg.sql, sourceProvider, source, targetStore, sourceJournal, target, sessionId, targetProvider, drain, seedAccount };
}

export function registration(userId: string) {
  const expiresAt = future();
  return {
    userId, email: `${userId}@example.test`, passwordHash: "fixture-password-hash",
    session: { userId, sessionId: randomUUID(), accessTokenId: randomUUID(), refreshHash: digest(randomUUID()),
      expiresAt, accessExpiresAt: expiresAt },
  };
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

export async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 10_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

export function heldTransaction(db: PgDatabase, ready: ReturnType<typeof deferred<number>>, release: ReturnType<typeof deferred>): PgDatabase {
  return {
    unsafe: (...args) => db.unsafe(...args), end: (...args) => db.end(...args),
    begin: (work) => db.begin(async (tx) => {
      const [backend] = await tx.unsafe<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const value = await work(tx);
      ready.resolve(backend.pid);
      await release.promise;
      return value;
    }),
  };
}

export function observedTransaction(db: PgDatabase, started: ReturnType<typeof deferred<number>>): PgDatabase {
  return {
    unsafe: (...args) => db.unsafe(...args), end: (...args) => db.end(...args),
    begin: (work) => db.begin(async (tx) => {
      const [backend] = await tx.unsafe<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      started.resolve(backend.pid);
      return work(tx);
    }),
  };
}

export async function waitUntilBlocked(db: PgDatabase, waiter: number, blocker: number): Promise<void> {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    const [row] = await db.unsafe<{ blocked: boolean }>("SELECT $2::integer = ANY(pg_blocking_pids($1::integer)) AS blocked", [waiter, blocker]);
    if (row.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Competing PostgreSQL transaction did not block on the first writer.");
}

export type MigrationFixture = Awaited<ReturnType<typeof fixture>>;

export async function hasToken(f: MigrationFixture, side: "source" | "target", tokenHash: string): Promise<boolean> {
  const provider = side === "source" ? f.sourceProvider : f.targetProvider;
  if (provider === "sqlite") return Boolean(f.db.prepare("SELECT 1 FROM auth_identity_tokens WHERE token_hash = ?").get(tokenHash));
  return Boolean((await f.pg.unsafe("SELECT 1 FROM auth_identity_tokens WHERE token_hash = $1", [tokenHash]))[0]);
}

export async function injectInsertFailure(f: MigrationFixture, side: "source" | "target", table: "provider_migration_changes" | "auth_identity_tokens"): Promise<() => Promise<void>> {
  const provider = side === "source" ? f.sourceProvider : f.targetProvider;
  if (provider === "sqlite") {
    f.db.exec(`CREATE TRIGGER nw_test_fail_insert BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected test failure'); END`);
    return async () => { f.db.exec("DROP TRIGGER nw_test_fail_insert"); };
  }
  await f.pg.unsafe("CREATE FUNCTION nw_test_fail_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected test failure'; END $$");
  await f.pg.unsafe(`CREATE TRIGGER nw_test_fail_insert BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION nw_test_fail_insert()`);
  return async () => {
    await f.pg.unsafe(`DROP TRIGGER nw_test_fail_insert ON ${table}`);
    await f.pg.unsafe("DROP FUNCTION nw_test_fail_insert()");
  };
}

export async function appendTestChanges(f: MigrationFixture, entries: Array<{ entityType: string; entityId: string; payload: Record<string, unknown> }>) {
  const transactionId = randomUUID();
  const input = (entry: typeof entries[number]) => ({ ...entry, sessionId: f.sessionId, transactionId, changeId: randomUUID(), operation: "upsert" as const });
  if (f.sourceProvider === "sqlite") {
    const journal = createSqliteProviderMigrationJournal(f.db);
    f.db.exec("BEGIN IMMEDIATE");
    try {
      const result = entries.map((entry) => journal.appendChangeInTransaction(f.db, input(entry)));
      f.db.exec("COMMIT"); return result;
    } catch (error) { f.db.exec("ROLLBACK"); throw error; }
  }
  const journal = createPostgresProviderMigrationJournal(f.pg);
  return f.pg.begin(async (tx) => {
    const result = [];
    for (const entry of entries) result.push(await journal.appendChangeInTransaction(tx, input(entry)));
    return result;
  });
}

export type SqliteIdentityOutcome = { ok: true; result: unknown } | { ok: false; name: string; message: string };

export function sqliteRaceWorker(script: URL, input: object) {
  const beginning = deferred(), holding = deferred(), done = deferred<SqliteIdentityOutcome>();
  let outcome: SqliteIdentityOutcome | undefined;
  const worker = new Worker(script, { workerData: input });
  const finish = (value: SqliteIdentityOutcome) => {
    if (outcome) return;
    outcome = value; beginning.resolve(); holding.resolve(); done.resolve(value);
  };
  worker.on("message", (message: { type: string; result?: unknown; name?: string; message?: string }) => {
    if (message.type === "before-begin") beginning.resolve();
    if (message.type === "before-commit") holding.resolve();
    if (message.type === "done") finish({ ok: true, result: message.result });
    if (message.type === "error") finish({ ok: false, name: message.name ?? "Error", message: message.message ?? "Worker failed" });
  });
  worker.on("error", (error: Error) => finish({ ok: false, name: error.name, message: error.message }));
  worker.on("exit", (code) => finish({ ok: false, name: "WorkerExit", message: `Worker exited before reporting its result (${code})` }));
  return {
    worker,
    async beginning() { await bounded(beginning.promise, "the SQLite identity transaction to begin"); },
    async holding() {
      await bounded(holding.promise, "the SQLite identity transaction to hold its write lock");
      if (outcome?.ok === false) throw new Error(`${outcome.name}: ${outcome.message}`);
    },
    done: () => bounded(done.promise, "the SQLite identity worker result"),
  };
}

export function sqliteIdentityWorker(input: { filename: string; operation: "issue" | "consume"; userId: string; email: string; tokenHash: string; expiresAt: string; gate?: SharedArrayBuffer }) {
  return sqliteRaceWorker(new URL("./sqlite-identity-replay-race-worker.ts", import.meta.url), input);
}
