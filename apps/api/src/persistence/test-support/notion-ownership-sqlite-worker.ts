import { parentPort, workerData } from "node:worker_threads";
import type { NotionBundle } from "../../application/notion-bundle.ts";
import type { CommitNotionImportWorkInput } from "../../application/notion-import-plan.ts";
import { importNotionBundle, type NotionImportReport } from "../../application/notion-import.ts";
import { createApplicationServices } from "../../application/services.ts";
import { createSqliteClient, type SqliteRunner } from "../sqlite.ts";
import { createSqliteStore } from "../sqlite-store.ts";
import { ownershipEnv } from "./notion-ownership-fixture.ts";

export type OwnershipWorkerInput = { filename: string; gate?: SharedArrayBuffer; probeLocked?: boolean } & (
  | { operation: "import"; actorId: string; source: NotionBundle; planToken: string }
  | { operation: "sql"; query: string; values: unknown[] }
);
export type OwnershipWorkerMessage = {
  type: "holding" | "attempting" | "blocked" | "done";
  ok?: boolean; report?: NotionImportReport; message?: string; errcode?: unknown;
};
const data = workerData as OwnershipWorkerInput;
const db = createSqliteClient({ filename: data.filename, timeoutMs: 15_000 });
let finalWork = data.operation === "sql";
const runner: SqliteRunner = {
  get isTransaction() { return db.isTransaction; },
  prepare: (query) => db.prepare(query), close: () => db.close(),
  exec(query) {
    if (query === "BEGIN IMMEDIATE") parentPort!.postMessage({ type: "attempting" });
    // Hold only the final OUTER commit, after all real business/journal writes.
    // Child savepoints and the no-write precheck must not be mistaken for it.
    if (query === "COMMIT" && finalWork && data.gate) {
      parentPort!.postMessage({ type: "holding" });
      if (Atomics.wait(new Int32Array(data.gate), 0, 0, 15_000) === "timed-out") throw new Error("Ownership concurrency gate timed out.");
    }
    db.exec(query);
  },
};
try {
  if (data.probeLocked) {
    // A zero-timeout native probe proves the other independent connection owns
    // SQLite's write lock, rather than relying only on worker message ordering.
    db.exec("PRAGMA busy_timeout = 0");
    let busy = false;
    try { db.exec("BEGIN IMMEDIATE"); db.exec("ROLLBACK"); }
    catch (error) { busy = error instanceof Error && "errcode" in error && error.errcode === 5; if (!busy) throw error; }
    if (!busy) throw new Error("Expected the competing SQLite writer to hold the lock.");
    parentPort!.postMessage({ type: "blocked" });
    db.exec("PRAGMA busy_timeout = 15000");
  }
  if (data.operation === "import") {
    const store = createSqliteStore(runner);
    const services = createApplicationServices({ persistence: store, env: ownershipEnv });
    const deps = { ...services, commitNotionImportWork(input: CommitNotionImportWorkInput) {
      finalWork = input.editions.length > 0;
      try { return store.commitNotionImportWork(input); } finally { finalWork = false; }
    } };
    const report = await importNotionBundle({ actorId: data.actorId, bundle: data.source, planToken: data.planToken, apply: true, deps });
    parentPort!.postMessage({ type: "done", ok: true, report });
  } else {
    runner.exec("BEGIN IMMEDIATE");
    runner.prepare(data.query).run(...data.values);
    runner.exec("COMMIT");
    parentPort!.postMessage({ type: "done", ok: true });
  }
} catch (error) {
  if (db.isTransaction) db.exec("ROLLBACK");
  parentPort!.postMessage({ type: "done", ok: false, message: error instanceof Error ? error.message : String(error),
    errcode: error instanceof Error && "errcode" in error ? error.errcode : undefined });
} finally { db.close(); parentPort!.close(); }
