import { parentPort, workerData } from "node:worker_threads";
import { createSqliteClient } from "../sqlite.ts";
import { createSqliteConversationStore } from "../sqlite-conversation-store.ts";

// Run a real store operation on a second SQLite connection. The optional gate
// holds its transaction immediately before COMMIT while another writer starts.
// The parent already enables WAL; do not attempt a journal-mode change while it holds a write lock.
const db = createSqliteClient({ filename: workerData.filename, timeoutMs: 5000, enableWal: false });
const originalExec = db.exec.bind(db);
if (workerData.gate) {
  const gate = new Int32Array(workerData.gate);
  Object.defineProperty(db, "exec", { value: (query: string) => {
    if (query === "COMMIT") {
      parentPort?.postMessage({ type: "before-commit" });
      if (Atomics.wait(gate, 0, 0, 10000) === "timed-out") throw new Error("Race test commit gate timed out.");
    }
    return originalExec(query);
  } });
}
const store = createSqliteConversationStore(db);
try {
  parentPort?.postMessage({ type: "started" });
  if (workerData.operation === "send") {
    await store.persistMessage({ conversationId: workerData.conversationId, senderId: "alice", body: "race", idempotencyKey: workerData.key });
  } else {
    await store.markConversationAsRead({ conversationId: workerData.conversationId, actorId: "bob" });
  }
  parentPort?.postMessage({ type: "done" });
} catch (error) {
  parentPort?.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
} finally {
  db.close();
}
