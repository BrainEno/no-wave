import { parentPort, workerData } from "node:worker_threads";
import { createSqliteArticleStore } from "../sqlite-article-store.ts";
import { createSqliteClient } from "../sqlite.ts";

type Input = {
  filename: string;
  articleId: string;
  author: string;
  operation: "restore" | "purge";
  now: string;
  gate?: SharedArrayBuffer;
};
const input = workerData as Input;
// The parent enables WAL before the workers open their independent connections.
const db = createSqliteClient({ filename: input.filename, timeoutMs: 5000, enableWal: false });
const originalExec = db.exec.bind(db);
Object.defineProperty(db, "exec", { value: (query: string) => {
  if (query === "BEGIN IMMEDIATE") parentPort?.postMessage({ type: "before-begin" });
  if (query === "COMMIT" && input.gate) {
    const gate = new Int32Array(input.gate);
    parentPort?.postMessage({ type: "before-commit" });
    if (Atomics.wait(gate, 0, 0, 10_000) === "timed-out") throw new Error("Tombstone race commit gate timed out.");
  }
  return originalExec(query);
} });
const store = createSqliteArticleStore(db);
try {
  parentPort?.postMessage({ type: "started" });
  const result = input.operation === "restore"
    ? store.restoreArticle({ articleId: input.articleId, actorId: input.author })
    : store.purgeExpiredArticles({ retentionDays: 30, now: input.now, limit: 10 });
  parentPort?.postMessage({ type: "done", result });
} catch (error) {
  parentPort?.postMessage({ type: "error", name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) });
} finally {
  db.close();
}
