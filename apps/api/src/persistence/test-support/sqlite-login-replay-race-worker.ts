import { parentPort, workerData } from "node:worker_threads";
import { createSqliteIdentityStore } from "../sqlite-identity-store.ts";
import { createSqliteClient } from "../sqlite.ts";

type Input = {
  filename: string;
  /** A reset proves itself with the consumed token; a signed-in change with the account it verified. */
  operation: "login" | "password-change" | "email-change" | "proof-password-change" | "proof-email-change";
  session: { userId: string; sessionId: string; accessTokenId: string; refreshHash: string; expiresAt: string; accessExpiresAt: string };
  proof: { email: string; passwordHash: string };
  gate?: SharedArrayBuffer;
};
const input = workerData as Input;
const db = createSqliteClient({ filename: input.filename, timeoutMs: 5_000, enableWal: false });
const originalExec = db.exec.bind(db);
Object.defineProperty(db, "exec", { value: (query: string) => {
  if (query === "BEGIN IMMEDIATE") parentPort?.postMessage({ type: "before-begin" });
  if (query === "COMMIT" && input.gate) {
    parentPort?.postMessage({ type: "before-commit" });
    if (Atomics.wait(new Int32Array(input.gate), 0, 0, 10_000) === "timed-out") throw new Error("SQLite login race commit gate timed out.");
  }
  return originalExec(query);
} });
try {
  const store = createSqliteIdentityStore(db);
  let result: unknown;
  if (input.operation === "login") result = await store.createIdentitySession(input.session, input.proof);
  else if (input.operation === "password-change") result = await store.replaceIdentityPassword({ userId: input.session.userId, passwordHash: "fixture-password-after" });
  else if (input.operation === "email-change") result = await store.setIdentityEmail({ userId: input.session.userId, email: `moved-${input.proof.email}` });
  else if (input.operation === "proof-password-change") result = await store.replaceIdentityPassword({ userId: input.session.userId, passwordHash: "fixture-password-signed-in", proof: input.proof });
  else result = await store.setIdentityEmail({ userId: input.session.userId, email: `signed-in-${input.proof.email}`, proof: input.proof });
  parentPort?.postMessage({ type: "done", result });
} catch (error) {
  parentPort?.postMessage({ type: "error", name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : "Worker failed" });
} finally { db.close(); }
