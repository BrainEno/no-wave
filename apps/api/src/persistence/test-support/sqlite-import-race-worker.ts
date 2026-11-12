import { parentPort, workerData } from "node:worker_threads";
import type { CommitNotionImportWorkInput } from "../../application/notion-import-plan.ts";
import type { UpdateArticleInput } from "../../application/persistence-ports.ts";
import { createSqliteClient, type SqliteRunner } from "../sqlite.ts";
import { createSqliteStore } from "../sqlite-store.ts";

type Input = { filename: string; gate?: SharedArrayBuffer } & (
  | { operation: "import"; input: CommitNotionImportWorkInput }
  | { operation: "update"; input: UpdateArticleInput }
);
const data = workerData as Input;
const db = createSqliteClient({ filename: data.filename, timeoutMs: 15_000 });
const runner: SqliteRunner = {
  get isTransaction() { return db.isTransaction; },
  prepare: (query) => db.prepare(query),
  close: () => db.close(),
  exec(query) {
    if (query === "BEGIN IMMEDIATE") parentPort!.postMessage({ type: "starting" });
    db.exec(query);
    if (query === "BEGIN IMMEDIATE" && data.gate) {
      parentPort!.postMessage({ type: "holding" });
      if (Atomics.wait(new Int32Array(data.gate), 0, 0, 10_000) === "timed-out") throw new Error("Import concurrency gate timed out.");
    }
  },
};
try {
  const store = createSqliteStore(runner);
  if (data.operation === "import") await store.commitNotionImportWork(data.input);
  else await store.updateArticle(data.input);
  parentPort!.postMessage({ type: "done", ok: true });
} catch (error) {
  parentPort!.postMessage({ type: "done", ok: false, name: error instanceof Error ? error.name : "UnknownError" });
} finally {
  db.close();
  parentPort!.close();
}
