import { parentPort, workerData } from "node:worker_threads";
import { createSqliteIdentityStore } from "../sqlite-identity-store.ts";
import { createSqliteClient } from "../sqlite.ts";

type Input = {
  filename: string;
  operation: "issue" | "consume";
  userId: string;
  email: string;
  tokenHash: string;
  expiresAt: string;
  gate?: SharedArrayBuffer;
};
const input = workerData as Input;
const db = createSqliteClient({ filename: input.filename, timeoutMs: 5_000, enableWal: false });
const originalExec = db.exec.bind(db);
Object.defineProperty(db, "exec", { value: (query: string) => {
  if (query === "BEGIN IMMEDIATE") parentPort?.postMessage({ type: "before-begin" });
  if (query === "COMMIT" && input.gate) {
    parentPort?.postMessage({ type: "before-commit" });
    if (Atomics.wait(new Int32Array(input.gate), 0, 0, 10_000) === "timed-out") throw new Error("SQLite identity race commit gate timed out.");
  }
  return originalExec(query);
} });
try {
  const store = createSqliteIdentityStore(db);
  const result = input.operation === "issue"
    ? await store.issueIdentityToken({ userId: input.userId, email: input.email, purpose: "password_reset", tokenHash: input.tokenHash, expiresAt: input.expiresAt })
    : await store.consumeIdentityToken({ tokenHash: input.tokenHash, purpose: "password_reset" });
  parentPort?.postMessage({ type: "done", result });
} catch (error) {
  parentPort?.postMessage({ type: "error", name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) });
} finally { db.close(); }
