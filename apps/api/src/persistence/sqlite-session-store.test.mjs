import assert from "node:assert/strict";
import test from "node:test";
import { createSqliteClient, runSqliteMigrations } from "./sqlite.mjs";
import { createSqliteSessionStore } from "./sqlite-session-store.mjs";

async function fixture() {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  await runSqliteMigrations(db);
  return { db, store: createSqliteSessionStore(db) };
}

test("SQLite session revocation is time-bounded and preserves the furthest expiry", async () => {
  const { db, store } = await fixture();
  try {
    assert.equal(await store.isSessionRevoked("session-a"), false);
    await store.revokeSession({ sessionId: "session-a", expiresAt: "2099-01-01T00:00:00.000Z" });
    assert.equal(await store.isSessionRevoked("session-a"), true);
    await store.revokeSession({ sessionId: "session-a", expiresAt: "2098-01-01T00:00:00.000Z" });
    assert.equal(db.prepare("SELECT expires_at FROM revoked_sessions WHERE session_id = ?").get("session-a").expires_at, "2099-01-01T00:00:00.000Z");
    await store.revokeSession({ sessionId: "expired", expiresAt: "2000-01-01T00:00:00.000Z" });
    assert.equal(await store.isSessionRevoked("expired"), false);
  } finally { db.close(); }
});

test("SQLite session revocation validates identifiers and expiry dates", async () => {
  const { db, store } = await fixture();
  try {
    await assert.rejects(store.revokeSession({ sessionId: "  ", expiresAt: "2099-01-01" }), TypeError);
    await assert.rejects(store.revokeSession({ sessionId: "session-a", expiresAt: "not-a-date" }), TypeError);
    await assert.rejects(store.isSessionRevoked(" session-a"), TypeError);
  } finally { db.close(); }
});
