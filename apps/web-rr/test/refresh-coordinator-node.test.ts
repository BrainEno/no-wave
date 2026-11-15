import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { PostgresRefreshCoordinator } from "../refresh/coordinator.ts";
import { RefreshResultCodec } from "../refresh/result-codec.ts";
import { resolveRefreshSettings } from "../refresh/settings.ts";
import type { RefreshStore, SharedRefreshRow } from "../refresh/postgres-store.ts";

const settings = resolveRefreshSettings({ WEB_REFRESH_COORDINATOR: "postgres", WEB_REFRESH_DATABASE_URL: "postgres://fixture@127.0.0.1/fixture", WEB_REFRESH_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64url"), WEB_REFRESH_ROTATION_TIMEOUT_MS: "100", WEB_REFRESH_WAIT_TIMEOUT_MS: "500" });
const generation = "a".repeat(64);
const context = { endpoint: "https://api.example.test/api/v1/auth/refresh" };
function fixture() {
  const rows = new Map<string, SharedRefreshRow>(); let rotations = 0;
  const store: RefreshStore = {
    async verify() {},
    async claim(key, owner) { const now = Date.now(); const row = rows.get(key); if (row) return { owner: false, row, now };
      const next: SharedRefreshRow = { key, owner, state: "pending", workDeadline: now + 100, expiresAt: now + 60_000, resultUntil: null, sealed: null }; rows.set(key, next); return { owner: true, row: next, now }; },
    async read(key) { return { row: rows.get(key) ?? null, now: Date.now() }; },
    async complete(input) { const row = rows.get(input.key); if (!row || row.owner !== input.owner || row.state !== "pending" || row.workDeadline <= Date.now()) return false;
      rows.set(input.key, { ...row, state: input.uncertain ? "uncertain" : "resolved", sealed: input.sealed, resultUntil: input.resultUntil }); return true; },
    async markUncertain(key, owner) { const row = rows.get(key); if (row?.owner === owner && row.state === "pending") rows.set(key, { ...row, state: "uncertain" }); },
    async sweep() { return 0; }, async close() { return true; },
  };
  const coordinator = () => new PostgresRefreshCoordinator({ store, codec: new RefreshResultCodec(settings.encryptionKey), settings });
  const tokens = { accessToken: "fixture-valid-access-token-".repeat(3), tokenType: "Bearer" as const, accessExpiresAt: new Date(Date.now() + 60000).toISOString(), refreshToken: "b".repeat(43), refreshExpiresAt: new Date(Date.now() + 3600000).toISOString() };
  return { rows, coordinator, tokens, rotate: async () => { rotations++; await delay(10); return tokens; }, rotations: () => rotations };
}

test("two isolated coordinator instances share one durable claim and one encrypted outcome", async () => {
  const f = fixture(), first = f.coordinator(), second = f.coordinator();
  const results = await Promise.all([first.resolve(generation, f.rotate, context), second.resolve(generation, f.rotate, context), first.resolve(generation, f.rotate, context)]);
  assert.deepEqual(results, [f.tokens, f.tokens, f.tokens]); assert.equal(f.rotations(), 1);
  assert.ok(!JSON.stringify([...f.rows.values()]).includes(f.tokens.refreshToken));
  await Promise.all([first.close(), second.close()]);
});

test("an abandoned owner is never stolen to replay a possibly consumed credential", async () => {
  const f = fixture(), coordinator = f.coordinator();
  f.rows.set(generation, { key: generation, owner: randomUUID(), state: "pending", workDeadline: Date.now() - 1, expiresAt: Date.now() + 60000, resultUntil: null, sealed: null });
  const result = await coordinator.resolve(generation, f.rotate, context);
  assert.ok(result && "kind" in result && result.code === "REFRESH_UNCERTAIN"); assert.equal(f.rotations(), 0);
  assert.equal(f.rows.get(generation)?.state, "uncertain"); await coordinator.close();
});

test("a hung callback expires once, retains its durable fence and cannot publish a late answer", async () => {
  const f = fixture(), coordinator = f.coordinator(); let release!: () => void;
  const pending = coordinator.resolve(generation, async () => { await new Promise<void>(done => { release = done; }); return f.tokens; }, context);
  const result = await pending; assert.ok(result && "kind" in result && result.status === 503);
  release(); await delay(0);
  const again = await coordinator.resolve(generation, f.rotate, context);
  assert.ok(again && "kind" in again && again.code === "REFRESH_UNCERTAIN"); assert.equal(f.rotations(), 0);
  assert.equal(f.rows.get(generation)?.sealed, null); await coordinator.close();
});
