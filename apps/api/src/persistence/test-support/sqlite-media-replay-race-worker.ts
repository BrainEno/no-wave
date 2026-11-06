import { parentPort, workerData } from "node:worker_threads";
import type { MigrationChange } from "../provider-migration-journal.ts";
import { createSqliteProviderMigrationReplayer } from "../sqlite-provider-migration-replayer.ts";
import { createSqliteArticleStore } from "../sqlite-article-store.ts";
import { createSqliteMediaStore } from "../sqlite-media-store.ts";
import { createSqliteClient } from "../sqlite.ts";

type Input = {
  filename: string;
  operation: "replay" | "delete" | "update";
  assetId: string;
  ownerId: string;
  changes: MigrationChange[];
  update?: { articleId: string; actorId: string; slug: string; title: string; locale: string; contentBlocks: { id: string; type: string; src: string; alt: string }[] };
  gate?: SharedArrayBuffer;
};
const input = workerData as Input;
// The parent initialized the file and enabled WAL before the workers connect.
const db = createSqliteClient({ filename: input.filename, timeoutMs: 5000, enableWal: false });
const originalExec = db.exec.bind(db);
Object.defineProperty(db, "exec", { value: (query: string) => {
  if (query === "BEGIN IMMEDIATE") parentPort?.postMessage({ type: "before-begin" });
  if (query === "COMMIT" && input.gate) {
    parentPort?.postMessage({ type: "before-commit" });
    if (Atomics.wait(new Int32Array(input.gate), 0, 0, 10_000) === "timed-out") throw new Error("SQLite media replay commit gate timed out.");
  }
  return originalExec(query);
} });
try {
  let result: unknown;
  if (input.operation === "replay") result = createSqliteProviderMigrationReplayer(db).applyTransaction(input.changes);
  else if (input.operation === "delete") result = await createSqliteMediaStore(db).deleteUnusedMediaAsset({ id: input.assetId, ownerId: input.ownerId });
  else {
    if (!input.update) throw new TypeError("The update operation requires an article input.");
    result = createSqliteArticleStore(db).updateArticle(input.update);
  }
  parentPort?.postMessage({ type: "done", result });
} catch (error) {
  parentPort?.postMessage({ type: "error", name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) });
} finally { db.close(); }
