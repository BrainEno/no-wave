import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { createIdentityService } from "../application/identity.ts";
import { IdentityAuthenticationError } from "../domain/errors.ts";
import { hashPassword } from "../security/passwords.ts";
import { createApiServer } from "../server.ts";
import test, { type TestContext } from "node:test";
import { createPostgresStore } from "./postgres.ts";
import type { PgDatabase } from "./postgres-driver.ts";
import { createPostgresProviderMigrationJournal } from "./postgres-provider-migration-journal.ts";
import { createPostgresProviderMigrationReplayer } from "./postgres-provider-migration-replayer.ts";
import { MIGRATION_REPLAY_SCHEMA_VERSION } from "./provider-migration-journal.ts";
import { prepareMigrationReplayTarget, replayNextMigrationBatch } from "./provider-migration-replay.ts";
import { getMigrationEntitySpec, getSupportedMigrationEntityTypes } from "./provider-migration-row-applier.ts";
import { createSqliteClient, runSqliteMigrations } from "./sqlite.ts";
import { createSqliteStore } from "./sqlite-store.ts";
import { createSqliteProviderMigrationJournal } from "./sqlite-provider-migration-journal.ts";
import { createSqliteProviderMigrationReplayer } from "./sqlite-provider-migration-replayer.ts";
import { createIsolatedPostgresTestSchema } from "./test-support/isolated-postgres-schema.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const options = { skip: !connectionString && "Set TEST_DATABASE_URL for real cross-provider identity replay tests.", timeout: 30_000 };
type Provider = "sqlite" | "postgres";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const future = () => new Date(Date.now() + 3_600_000).toISOString();

async function fixture(t: TestContext, sourceProvider: Provider, settings: { prepare?: boolean; schemaVersion?: string; sqliteFile?: string } = {}) {
  const pg = await createIsolatedPostgresTestSchema(connectionString!);
  const db = createSqliteClient({ filename: settings.sqliteFile ?? ":memory:", enableWal: Boolean(settings.sqliteFile) });
  t.after(async () => { db.close(); await pg.cleanup(); });
  await runSqliteMigrations(db);
  const sqlite = createSqliteStore(db), postgres = createPostgresStore(pg.sql);
  const source = sourceProvider === "sqlite" ? sqlite : postgres;
  const targetStore = sourceProvider === "sqlite" ? postgres : sqlite;
  const sourceJournal = sourceProvider === "sqlite" ? createSqliteProviderMigrationJournal(db) : createPostgresProviderMigrationJournal(pg.sql);
  const target = sourceProvider === "sqlite" ? createPostgresProviderMigrationReplayer(pg.sql) : createSqliteProviderMigrationReplayer(db);
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

function registration(userId: string) {
  const expiresAt = future();
  return {
    userId, email: `${userId}@example.test`, passwordHash: "fixture-password-hash",
    session: { userId, sessionId: randomUUID(), accessTokenId: randomUUID(), refreshHash: digest(randomUUID()),
      expiresAt, accessExpiresAt: expiresAt },
  };
}

for (const sourceProvider of ["sqlite", "postgres"] as const) {
  const targetProvider = sourceProvider === "sqlite" ? "postgres" : "sqlite";

  test(`${sourceProvider} → ${targetProvider}: session creation rejects missing or stale account proof without capture`, options, async (t) => {
    const f = await fixture(t, sourceProvider), account = registration(randomUUID()), late = registration(account.userId).session;
    assert.equal(await f.source.createIdentityAccount(account), true);
    await f.drain();
    const before = (await f.sourceJournal.getSession(f.sessionId)).nextSequence;
    const proof = { email: account.email, passwordHash: account.passwordHash };
    for (const invalid of [undefined, { ...proof, email: `moved-${proof.email}` }, { ...proof, passwordHash: "wrong-fixture-hash" }]) {
      assert.equal(await f.source.createIdentitySession(late, invalid), false);
      assert.equal((await f.sourceJournal.getSession(f.sessionId)).nextSequence, before, "a refused login must not leave a partial journal");
    }
    assert.deepEqual((await f.source.listIdentitySessions({ userId: account.userId, limit: 50 })).map((s) => s.sessionId), [account.session.sessionId]);
    assert.equal(await f.source.createIdentitySession(late, proof), true, "current proof still creates a session");
    await f.drain();
    assert.deepEqual((await f.targetStore.listIdentitySessions({ userId: account.userId, limit: 50 })).map((s) => s.sessionId).sort(),
      [account.session.sessionId, late.sessionId].sort());
  });

  test(`${sourceProvider} → ${targetProvider}: a failed session insert rolls back its rows and capture`, options, async (t) => {
    const f = await fixture(t, sourceProvider), account = registration(randomUUID()), candidate = registration(account.userId).session;
    await f.source.createIdentityAccount(account);
    await f.drain();
    const proof = { email: account.email, passwordHash: account.passwordHash };
    const before = (await f.sourceJournal.getSession(f.sessionId)).nextSequence;
    await assert.rejects(f.source.createIdentitySession({ ...candidate, refreshHash: account.session.refreshHash }, proof));
    assert.equal((await f.sourceJournal.getSession(f.sessionId)).nextSequence, before);
    assert.deepEqual((await f.source.listIdentitySessions({ userId: account.userId, limit: 50 })).map((s) => s.sessionId), [account.session.sessionId]);
    assert.equal(await f.source.createIdentitySession(candidate, proof), true, "the rolled-back session id can be retried");
    const captured = JSON.stringify(await f.sourceJournal.readChangeBatch({ sessionId: f.sessionId, afterSequence: before - 1, limit: 100 }));
    assert.ok(!captured.includes(account.email) && !captured.includes(account.passwordHash), "session capture does not include the proof");
    await f.drain();
    assert.deepEqual((await f.targetStore.listIdentitySessions({ userId: account.userId, limit: 50 })).map((s) => s.sessionId).sort(),
      [account.session.sessionId, candidate.sessionId].sort());
  });

  test(`${sourceProvider} → ${targetProvider}: a committed password replacement rejects an earlier login proof`, options, async (t) => {
    const f = await fixture(t, sourceProvider), account = registration(randomUUID()), late = registration(account.userId).session;
    await f.source.createIdentityAccount(account);
    await f.drain();
    assert.deepEqual(await f.source.replaceIdentityPassword({ userId: account.userId, passwordHash: "fixture-password-after" }),
      { updated: true, revokedSessions: 1 });
    await f.drain();
    const before = (await f.sourceJournal.getSession(f.sessionId)).nextSequence;
    assert.equal(await f.source.createIdentitySession(late, { email: account.email, passwordHash: account.passwordHash }), false);
    assert.equal((await f.sourceJournal.getSession(f.sessionId)).nextSequence, before);
    await f.drain();
    assert.deepEqual(await f.source.listIdentitySessions({ userId: account.userId, limit: 50 }), []);
    assert.deepEqual(await f.targetStore.listIdentitySessions({ userId: account.userId, limit: 50 }), []);
    assert.equal(await f.targetStore.isSessionRevoked(account.session.accessTokenId), true);
    assert.deepEqual(await f.targetStore.findIdentityCredentials({ userId: account.userId }), await f.source.findIdentityCredentials({ userId: account.userId }));
  });

  test(`${sourceProvider} → ${targetProvider}: a committed email change rejects an earlier login proof`, options, async (t) => {
    const f = await fixture(t, sourceProvider), account = registration(randomUUID()), late = registration(account.userId).session;
    await f.source.createIdentityAccount(account);
    await f.drain();
    const moved = `moved-${account.email}`;
    assert.equal(await f.source.setIdentityEmail({ userId: account.userId, email: moved }), true);
    await f.drain();
    const before = (await f.sourceJournal.getSession(f.sessionId)).nextSequence;
    assert.equal(await f.source.createIdentitySession(late, { email: account.email, passwordHash: account.passwordHash }), false);
    assert.equal((await f.sourceJournal.getSession(f.sessionId)).nextSequence, before);
    assert.equal(await f.source.createIdentitySession(late, { email: moved, passwordHash: account.passwordHash }), true);
    await f.drain();
    assert.deepEqual(await f.targetStore.findIdentityAccountByUserId({ userId: account.userId }), await f.source.findIdentityAccountByUserId({ userId: account.userId }));
    assert.deepEqual((await f.targetStore.listIdentitySessions({ userId: account.userId, limit: 50 })).map((s) => s.sessionId).sort(),
      [account.session.sessionId, late.sessionId].sort());
  });

  test(`${sourceProvider} → ${targetProvider}: registration and verification replay the complete account`, options, async (t) => {
    const f = await fixture(t, sourceProvider);
    const input = registration(randomUUID());
    assert.equal(await f.source.createIdentityAccount(input), true);
    await f.drain();
    assert.deepEqual(await f.targetStore.findIdentityAccountByUserId({ userId: input.userId }), await f.source.findIdentityAccountByUserId({ userId: input.userId }));
    assert.deepEqual(await f.targetStore.findIdentityCredentials({ userId: input.userId }), await f.source.findIdentityCredentials({ userId: input.userId }));
    assert.equal(await f.targetStore.getUserRole({ userId: input.userId }), "member");
    const verifiedAt = new Date().toISOString();
    await f.source.markIdentityEmailVerified({ userId: input.userId, verifiedAt });
    await f.drain();
    assert.deepEqual(await f.targetStore.findIdentityAccountByUserId({ userId: input.userId }), await f.source.findIdentityAccountByUserId({ userId: input.userId }));
  });

  test(`${sourceProvider} → ${targetProvider}: replacing and consuming an identity token cannot revive the old token`, options, async (t) => {
    const f = await fixture(t, sourceProvider);
    const userId = randomUUID(), email = `${userId}@example.test`;
    await f.seedAccount(userId, email);
    const first = digest(randomUUID()), replacement = digest(randomUUID());
    await f.source.issueIdentityToken({ userId, email, purpose: "password_reset", tokenHash: first, expiresAt: future() });
    await f.drain();
    await f.source.issueIdentityToken({ userId, email, purpose: "password_reset", tokenHash: replacement, expiresAt: future() });
    await f.drain();
    assert.equal(await f.source.consumeIdentityToken({ tokenHash: first, purpose: "password_reset" }), null);
    assert.equal(await f.targetStore.consumeIdentityToken({ tokenHash: first, purpose: "password_reset" }), null);
    assert.deepEqual(await f.source.consumeIdentityToken({ tokenHash: replacement, purpose: "password_reset" }), { userId, email });
    await f.drain();
    assert.equal(await f.targetStore.consumeIdentityToken({ tokenHash: replacement, purpose: "password_reset" }), null);
  });

  test(`${sourceProvider} → ${targetProvider}: featured replacements preserve the ordered shelf`, options, async (t) => {
    const f = await fixture(t, sourceProvider);
    const authorId = randomUUID();
    const articles = [];
    for (let i = 0; i < 3; i++) articles.push(await f.source.createArticle({
      authorId, slug: `featured-replay-${randomUUID()}`, title: `Work ${i}`, locale: "en", publish: true,
      contentBlocks: [{ id: "p", type: "paragraph", text: "A public work" }],
    }));
    await f.drain();
    const ids = articles.map((a) => a.id);
    await f.source.setFeaturedArticles({ actorId: authorId, actorIsEditor: true, articleIds: ids, locale: "en" });
    await f.drain();
    assert.deepEqual((await f.targetStore.listFeaturedArticles({ locale: "en" })).map((a) => a.id), ids);
    const reordered = [ids[2], ids[0]];
    await f.source.setFeaturedArticles({ actorId: authorId, actorIsEditor: true, articleIds: reordered, locale: "en" });
    await f.drain();
    assert.deepEqual((await f.targetStore.listFeaturedArticles({ locale: "en" })).map((a) => a.id), reordered);
  });

  test(`${sourceProvider} → ${targetProvider}: old media-only sessions cannot resume identity replay`, options, async (t) => {
    const f = await fixture(t, sourceProvider, { prepare: false, schemaVersion: "media-reference-snapshots-v1" });
    await assert.rejects(prepareMigrationReplayTarget({ sourceJournal: f.sourceJournal, targetJournal: f.target, sessionId: f.sessionId, targetProvider }), /schema|version/i);
  });

  test(`${sourceProvider} → ${targetProvider}: pre-existing identity tokens are not an attested baseline`, options, async (t) => {
    const f = await fixture(t, sourceProvider, { prepare: false });
    const userId = randomUUID(), email = `${userId}@example.test`;
    // Supply only the FK parent so this test isolates the token baseline check.
    if (targetProvider === "sqlite") f.db.prepare("INSERT INTO auth_accounts (user_id, email, password_hash) VALUES (?, ?, ?)").run(userId, email, "fixture-password-hash");
    else await f.pg.unsafe("INSERT INTO auth_accounts (user_id, email, password_hash) VALUES ($1, $2, $3)", [userId, email, "fixture-password-hash"]);
    await f.targetStore.issueIdentityToken({ userId, email, purpose: "password_reset", tokenHash: digest(randomUUID()), expiresAt: future() });
    await assert.rejects(prepareMigrationReplayTarget({ sourceJournal: f.sourceJournal, targetJournal: f.target, sessionId: f.sessionId, targetProvider }), /identity|baseline/i);
  });
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 10_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
function heldTransaction(db: PgDatabase, ready: ReturnType<typeof deferred<number>>, release: ReturnType<typeof deferred>): PgDatabase {
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
function observedTransaction(db: PgDatabase, started: ReturnType<typeof deferred<number>>): PgDatabase {
  return {
    unsafe: (...args) => db.unsafe(...args), end: (...args) => db.end(...args),
    begin: (work) => db.begin(async (tx) => {
      const [backend] = await tx.unsafe<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      started.resolve(backend.pid);
      return work(tx);
    }),
  };
}
async function waitUntilBlocked(db: PgDatabase, waiter: number, blocker: number): Promise<void> {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    const [row] = await db.unsafe<{ blocked: boolean }>("SELECT $2::integer = ANY(pg_blocking_pids($1::integer)) AS blocked", [waiter, blocker]);
    if (row.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Competing PostgreSQL transaction did not block on the first writer.");
}

test("PostgreSQL overlapping featured replacements serialize from an empty shelf and replay in commit order", options, async (t) => {
  const f = await fixture(t, "postgres");
  const authorId = randomUUID();
  const contentBlocks = [{ id: "p", type: "paragraph", text: "Public work" }];
  const a = await f.source.createArticle({ authorId, slug: `feature-a-${randomUUID()}`, title: "First", locale: "en", publish: true, contentBlocks });
  const b = await f.source.createArticle({ authorId, slug: `feature-b-${randomUUID()}`, title: "Second", locale: "en", publish: true, contentBlocks });
  await f.drain();
  const ready = deferred<number>(), started = deferred<number>(), release = deferred();
  const firstStore = createPostgresStore(heldTransaction(f.pg, ready, release));
  const secondStore = createPostgresStore(observedTransaction(f.pg, started));
  const first = Promise.resolve(firstStore.setFeaturedArticles({ actorId: authorId, actorIsEditor: true, articleIds: [a.id], locale: "en" }));
  void first.catch(() => {});
  let second: Promise<unknown> | undefined;
  try {
    const firstPid = await bounded(ready.promise, "the first shelf transaction");
    second = Promise.resolve(secondStore.setFeaturedArticles({ actorId: authorId, actorIsEditor: true, articleIds: [b.id], locale: "en" }));
    void second.catch(() => {});
    const secondPid = await bounded(started.promise, "the competing shelf transaction");
    await waitUntilBlocked(f.pg, secondPid, firstPid);
    release.resolve();
    await Promise.all([first, second]);
    const sourceIds = (await f.source.listFeaturedArticles({ locale: "en" })).map((a) => a.id);
    assert.deepEqual(sourceIds, [b.id], "the second whole-shelf write must replace, not merge, the first");
    await f.drain();
    assert.deepEqual((await f.targetStore.listFeaturedArticles({ locale: "en" })).map((a) => a.id), sourceIds);
  } finally {
    release.resolve();
    await Promise.allSettled([first, ...(second ? [second] : [])]);
  }
});

test("PostgreSQL overlapping token issuance serializes even when no prior token exists", options, async (t) => {
  const f = await fixture(t, "postgres");
  const userId = randomUUID(), email = `${userId}@example.test`;
  await f.seedAccount(userId, email);
  const firstHash = digest(randomUUID()), secondHash = digest(randomUUID());
  const ready = deferred<number>(), started = deferred<number>(), release = deferred();
  const firstStore = createPostgresStore(heldTransaction(f.pg, ready, release));
  const secondStore = createPostgresStore(observedTransaction(f.pg, started));
  const first = Promise.resolve(firstStore.issueIdentityToken({ userId, email, purpose: "password_reset", tokenHash: firstHash, expiresAt: future() }));
  void first.catch(() => {});
  let second: Promise<unknown> | undefined;
  try {
    const firstPid = await bounded(ready.promise, "the first token issuance");
    second = Promise.resolve(secondStore.issueIdentityToken({ userId, email, purpose: "password_reset", tokenHash: secondHash, expiresAt: future() }));
    void second.catch(() => {});
    const secondPid = await bounded(started.promise, "the competing token issuance");
    await waitUntilBlocked(f.pg, secondPid, firstPid);
    release.resolve();
    await Promise.all([first, second]);
    const rows = await f.pg.unsafe("SELECT token_hash FROM auth_identity_tokens WHERE user_id = $1 AND purpose = $2", [userId, "password_reset"]);
    assert.equal(rows.length, 1, "only the second token can remain usable");
    assert.equal(rows[0].token_hash, secondHash);
    await f.drain();
    assert.equal(await f.source.consumeIdentityToken({ tokenHash: firstHash, purpose: "password_reset" }), null);
    assert.equal(await f.targetStore.consumeIdentityToken({ tokenHash: firstHash, purpose: "password_reset" }), null);
    assert.deepEqual(await f.source.consumeIdentityToken({ tokenHash: secondHash, purpose: "password_reset" }), { userId, email });
    await f.drain();
    assert.equal(await f.targetStore.consumeIdentityToken({ tokenHash: secondHash, purpose: "password_reset" }), null);
  } finally {
    release.resolve();
    await Promise.allSettled([first, ...(second ? [second] : [])]);
  }
});

for (const sourceProvider of ["sqlite", "postgres"] as const) {
  const targetProvider = sourceProvider === "sqlite" ? "postgres" : "sqlite";
  test(`${sourceProvider} → ${targetProvider}: session rotation, reuse and password replacement keep revocations`, options, async (t) => {
    const f = await fixture(t, sourceProvider);
    const account = registration(randomUUID());
    await f.source.createIdentityAccount(account);
    const original = await f.sourceJournal.readChangeBatch({ sessionId: f.sessionId, afterSequence: 0, limit: 1 });
    await f.drain();
    const second = registration(account.userId).session, third = registration(account.userId).session;
    const proof = { email: account.email, passwordHash: account.passwordHash };
    assert.equal(await f.source.createIdentitySession(second, proof), true);
    assert.equal(await f.source.createIdentitySession(third, proof), true);
    await f.drain();
    const newRefresh = digest(randomUUID()), newAccess = randomUUID();
    assert.equal((await f.source.rotateIdentityRefresh({ refreshHash: account.session.refreshHash, nextRefreshHash: newRefresh,
      accessTokenId: newAccess, issuedAt: new Date().toISOString(), accessExpiresAt: future() })).status, "rotated");
    await f.drain();
    assert.equal((await f.source.rotateIdentityRefresh({ refreshHash: account.session.refreshHash, nextRefreshHash: digest(randomUUID()),
      accessTokenId: randomUUID(), issuedAt: new Date().toISOString(), accessExpiresAt: future() })).status, "reused");
    await f.drain();
    assert.equal(await f.targetStore.isSessionRevoked(account.session.accessTokenId), true);
    assert.equal(await f.targetStore.isSessionRevoked(newAccess), true);
    assert.equal(await f.targetStore.isSessionRevoked(second.accessTokenId), false);
    assert.equal((await f.targetStore.rotateIdentityRefresh({ refreshHash: newRefresh, nextRefreshHash: digest(randomUUID()),
      accessTokenId: randomUUID(), issuedAt: new Date().toISOString(), accessExpiresAt: future() })).status, "invalid");
    const updated = await f.source.replaceIdentityPassword({ userId: account.userId, passwordHash: "fixture-password-after",
      exceptSessionId: second.sessionId });
    assert.equal(updated.revokedSessions, 1);
    await f.drain();
    assert.deepEqual(await f.targetStore.findIdentityCredentials({ userId: account.userId }), await f.source.findIdentityCredentials({ userId: account.userId }));
    assert.equal(await f.targetStore.isSessionRevoked(second.accessTokenId), false);
    assert.equal(await f.targetStore.isSessionRevoked(third.accessTokenId), true);
    const checkpoint = await f.target.getCheckpoint(f.sessionId);
    await f.target.applyTransaction(original);
    assert.equal(await f.target.getCheckpoint(f.sessionId), checkpoint, "duplicate registration must not rewind the checkpoint");
    assert.equal(await f.targetStore.isSessionRevoked(third.accessTokenId), true, "stale registration cannot revive a revoked session");
    assert.deepEqual(await f.targetStore.findIdentityCredentials({ userId: account.userId }), await f.source.findIdentityCredentials({ userId: account.userId }));
  });
}

for (const sourceProvider of ["sqlite", "postgres"] as const) {
  test(`${sourceProvider}: missing account identity writes remain harmless during capture`, options, async (t) => {
    const f = await fixture(t, sourceProvider);
    const before = (await f.sourceJournal.getSession(f.sessionId)).nextSequence;
    const userId = randomUUID();
    assert.equal(await f.source.markIdentityEmailVerified({ userId, verifiedAt: new Date().toISOString() }), false);
    assert.deepEqual(await f.source.replaceIdentityPassword({ userId, passwordHash: "fixture-password" }), { updated: false, revokedSessions: 0 });
    assert.equal((await f.sourceJournal.getSession(f.sessionId)).nextSequence, before, "a no-op must not capture undefined credentials");
  });
}

for (const sourceProvider of ["sqlite", "postgres"] as const) {
  const targetProvider = sourceProvider === "sqlite" ? "postgres" : "sqlite";
  test(`${sourceProvider} → ${targetProvider}: changing email invalidates old verification and reset tokens`, options, async (t) => {
    const f = await fixture(t, sourceProvider);
    const account = registration(randomUUID());
    await f.source.createIdentityAccount(account);
    const verification = randomBytes(32).toString("base64url"), reset = randomBytes(32).toString("base64url");
    await f.source.issueIdentityToken({ userId: account.userId, email: account.email, purpose: "email_verification", tokenHash: digest(verification), expiresAt: future() });
    await f.source.issueIdentityToken({ userId: account.userId, email: account.email, purpose: "password_reset", tokenHash: digest(reset), expiresAt: future() });
    await f.drain();
    assert.equal(await f.source.setIdentityEmail({ userId: account.userId, email: `moved-${account.email}` }), true);
    await f.drain();
    const service = createIdentityService({ store: f.source, env: {
      AUTH_JWT_SECRET: "test-fixture-secret-not-a-real-credential", AUTH_JWT_ISSUER: "test", AUTH_JWT_AUDIENCE: "test",
    } });
    await assert.rejects(service.verifyEmail({ token: verification }, "192.0.2.12"), IdentityAuthenticationError);
    await assert.rejects(service.resetPassword({ token: reset, password: "test-password-after-change" }, "192.0.2.12"), IdentityAuthenticationError);
    assert.equal((await f.source.findIdentityAccountByUserId({ userId: account.userId }))?.emailVerifiedAt, null);
    assert.equal((await f.source.findIdentityCredentials({ userId: account.userId }))?.passwordHash, account.passwordHash);
    assert.equal(await f.source.isSessionRevoked(account.session.accessTokenId), false);
    assert.equal(await f.targetStore.consumeIdentityToken({ tokenHash: digest(verification), purpose: "email_verification" }), null);
    assert.equal(await f.targetStore.consumeIdentityToken({ tokenHash: digest(reset), purpose: "password_reset" }), null);
    assert.deepEqual(await f.targetStore.findIdentityAccountByUserId({ userId: account.userId }), await f.source.findIdentityAccountByUserId({ userId: account.userId }));
  });
}

for (const sourceProvider of ["sqlite", "postgres"] as const) {
  const targetProvider = sourceProvider === "sqlite" ? "postgres" : "sqlite";
  test(`${sourceProvider} → ${targetProvider}: an in-flight old-email proof fails after an address change`, options, async (t) => {
    const f = await fixture(t, sourceProvider);
    const account = registration(randomUUID()), verification = digest(randomUUID()), reset = digest(randomUUID());
    await f.source.createIdentityAccount(account);
    await f.source.issueIdentityToken({ userId: account.userId, email: account.email, purpose: "email_verification", tokenHash: verification, expiresAt: future() });
    await f.source.issueIdentityToken({ userId: account.userId, email: account.email, purpose: "password_reset", tokenHash: reset, expiresAt: future() });
    assert.ok(await f.source.consumeIdentityToken({ tokenHash: verification, purpose: "email_verification" }));
    assert.ok(await f.source.consumeIdentityToken({ tokenHash: reset, purpose: "password_reset" }));
    await f.drain();
    await f.source.setIdentityEmail({ userId: account.userId, email: `moved-${account.email}` });
    await f.source.setIdentityEmail({ userId: account.userId, email: account.email });
    assert.equal(await f.source.markIdentityEmailVerified({ userId: account.userId, verifiedAt: new Date().toISOString(), consumedTokenHash: verification }), false);
    assert.deepEqual(await f.source.replaceIdentityPassword({ userId: account.userId, passwordHash: "should-not-be-written", consumedTokenHash: reset }), { updated: false, revokedSessions: 0 });
    await f.drain();
    assert.equal((await f.source.findIdentityAccountByUserId({ userId: account.userId }))?.emailVerifiedAt, null);
    assert.equal((await f.source.findIdentityCredentials({ userId: account.userId }))?.passwordHash, account.passwordHash);
    assert.equal(await f.source.isSessionRevoked(account.session.accessTokenId), false);
    assert.deepEqual(await f.targetStore.findIdentityAccountByUserId({ userId: account.userId }), await f.source.findIdentityAccountByUserId({ userId: account.userId }));
    assert.deepEqual(await f.targetStore.findIdentityCredentials({ userId: account.userId }), await f.source.findIdentityCredentials({ userId: account.userId }));
    assert.equal(await f.targetStore.isSessionRevoked(account.session.accessTokenId), false);
  });
}

for (const sourceProvider of ["sqlite", "postgres"] as const) {
  test(`${sourceProvider}: a token cannot be issued from a stale account address`, options, async (t) => {
    const f = await fixture(t, sourceProvider);
    const account = registration(randomUUID());
    await f.source.createIdentityAccount(account);
    await f.source.setIdentityEmail({ userId: account.userId, email: `moved-${account.email}` });
    const before = (await f.sourceJournal.getSession(f.sessionId)).nextSequence;
    assert.equal(await f.source.issueIdentityToken({ userId: account.userId, email: account.email,
      purpose: "email_verification", tokenHash: digest(randomUUID()), expiresAt: future() }), false);
    assert.equal((await f.sourceJournal.getSession(f.sessionId)).nextSequence, before);
  });
}

for (const sourceProvider of ["sqlite", "postgres"] as const) {
  const targetProvider = sourceProvider === "sqlite" ? "postgres" : "sqlite";
  test(`${sourceProvider} → ${targetProvider}: fresh address-bound links still verify and reset`, options, async (t) => {
    const f = await fixture(t, sourceProvider);
    const account = registration(randomUUID());
    await f.source.createIdentityAccount(account);
    const newEmail = `moved-${account.email}`;
    await f.source.setIdentityEmail({ userId: account.userId, email: newEmail });
    const verification = randomBytes(32).toString("base64url"), reset = randomBytes(32).toString("base64url");
    await f.source.issueIdentityToken({ userId: account.userId, email: newEmail, purpose: "email_verification", tokenHash: digest(verification), expiresAt: future() });
    await f.source.issueIdentityToken({ userId: account.userId, email: newEmail, purpose: "password_reset", tokenHash: digest(reset), expiresAt: future() });
    const service = createIdentityService({ store: f.source, env: {
      AUTH_JWT_SECRET: "test-fixture-secret-not-a-real-credential", AUTH_JWT_ISSUER: "test", AUTH_JWT_AUDIENCE: "test",
    } });
    assert.deepEqual(await service.verifyEmail({ token: verification }, "192.0.2.12"), { ok: true });
    assert.deepEqual(await service.resetPassword({ token: reset, password: "test-password-after-change" }, "192.0.2.12"), { ok: true });
    await f.drain();
    assert.ok((await f.source.findIdentityAccountByUserId({ userId: account.userId }))?.emailVerifiedAt);
    assert.deepEqual(await f.targetStore.findIdentityAccountByUserId({ userId: account.userId }), await f.source.findIdentityAccountByUserId({ userId: account.userId }));
    assert.deepEqual(await f.targetStore.findIdentityCredentials({ userId: account.userId }), await f.source.findIdentityCredentials({ userId: account.userId }));
    assert.equal(await f.source.isSessionRevoked(account.session.accessTokenId), true);
    assert.equal(await f.targetStore.isSessionRevoked(account.session.accessTokenId), true);
    await assert.rejects(service.verifyEmail({ token: verification }, "192.0.2.12"), IdentityAuthenticationError);
    await assert.rejects(service.resetPassword({ token: reset, password: "test-password-after-change" }, "192.0.2.12"), IdentityAuthenticationError);
  });

  test(`${sourceProvider}: consumed proof is scoped to the owner and purpose`, options, async (t) => {
    const f = await fixture(t, sourceProvider);
    const first = registration(randomUUID()), second = registration(randomUUID());
    await f.source.createIdentityAccount(first);
    await f.source.createIdentityAccount(second);
    const verification = digest(randomUUID()), foreignReset = digest(randomUUID()), unusedReset = digest(randomUUID());
    await f.source.issueIdentityToken({ userId: first.userId, email: first.email, purpose: "email_verification", tokenHash: verification, expiresAt: future() });
    await f.source.issueIdentityToken({ userId: second.userId, email: second.email, purpose: "password_reset", tokenHash: foreignReset, expiresAt: future() });
    await f.source.issueIdentityToken({ userId: first.userId, email: first.email, purpose: "password_reset", tokenHash: unusedReset, expiresAt: future() });
    assert.ok(await f.source.consumeIdentityToken({ tokenHash: verification, purpose: "email_verification" }));
    assert.ok(await f.source.consumeIdentityToken({ tokenHash: foreignReset, purpose: "password_reset" }));
    assert.deepEqual(await f.source.replaceIdentityPassword({ userId: first.userId, passwordHash: "should-not-be-written", consumedTokenHash: verification }), { updated: false, revokedSessions: 0 });
    assert.deepEqual(await f.source.replaceIdentityPassword({ userId: first.userId, passwordHash: "should-not-be-written", consumedTokenHash: foreignReset }), { updated: false, revokedSessions: 0 });
    assert.deepEqual(await f.source.replaceIdentityPassword({ userId: first.userId, passwordHash: "should-not-be-written", consumedTokenHash: unusedReset }), { updated: false, revokedSessions: 0 });
    assert.equal(await f.source.markIdentityEmailVerified({ userId: second.userId, verifiedAt: new Date().toISOString(), consumedTokenHash: verification }), false);
    assert.equal((await f.source.findIdentityCredentials({ userId: first.userId }))?.passwordHash, first.passwordHash);
    assert.equal(await f.source.isSessionRevoked(first.session.accessTokenId), false);
  });
}

type MigrationFixture = Awaited<ReturnType<typeof fixture>>;
async function hasToken(f: MigrationFixture, side: "source" | "target", tokenHash: string): Promise<boolean> {
  const provider = side === "source" ? f.sourceProvider : f.targetProvider;
  if (provider === "sqlite") return Boolean(f.db.prepare("SELECT 1 FROM auth_identity_tokens WHERE token_hash = ?").get(tokenHash));
  return Boolean((await f.pg.unsafe("SELECT 1 FROM auth_identity_tokens WHERE token_hash = $1", [tokenHash]))[0]);
}

async function injectInsertFailure(f: MigrationFixture, side: "source" | "target", table: "provider_migration_changes" | "auth_identity_tokens"): Promise<() => Promise<void>> {
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

for (const sourceProvider of ["sqlite", "postgres"] as const) {
  const targetProvider = sourceProvider === "sqlite" ? "postgres" : "sqlite";
  test(`${sourceProvider} → ${targetProvider}: failed source capture rolls back token replacement and can retry`, options, async (t) => {
    const f = await fixture(t, sourceProvider), userId = randomUUID(), email = `${randomUUID()}@example.test`;
    await f.seedAccount(userId, email);
    const first = digest(randomUUID()), next = digest(randomUUID());
    const token = (tokenHash: string) => ({ userId, email, purpose: "password_reset" as const, tokenHash, expiresAt: future() });
    await f.source.issueIdentityToken(token(first));
    await f.drain();
    const before = (await f.sourceJournal.getSession(f.sessionId)).nextSequence;
    const checkpoint = await f.target.getCheckpoint(f.sessionId);
    const removeFailure = await injectInsertFailure(f, "source", "provider_migration_changes");
    try { await assert.rejects(f.source.issueIdentityToken(token(next)), /injected test failure/); }
    finally { await removeFailure(); }
    assert.equal(await hasToken(f, "source", first), true);
    assert.equal(await hasToken(f, "source", next), false);
    assert.equal((await f.sourceJournal.getSession(f.sessionId)).nextSequence, before);
    assert.equal(await f.target.getCheckpoint(f.sessionId), checkpoint);
    await f.source.issueIdentityToken(token(next));
    await f.drain();
    assert.equal(await hasToken(f, "target", first), false);
    assert.equal(await hasToken(f, "target", next), true);
  });

  test(`${sourceProvider} → ${targetProvider}: failed target apply rolls back token delete and checkpoint, then retries`, options, async (t) => {
    const f = await fixture(t, sourceProvider), userId = randomUUID(), email = `${randomUUID()}@example.test`;
    await f.seedAccount(userId, email);
    const first = digest(randomUUID()), next = digest(randomUUID());
    const token = (tokenHash: string) => ({ userId, email, purpose: "password_reset" as const, tokenHash, expiresAt: future() });
    await f.source.issueIdentityToken(token(first));
    await f.drain();
    const checkpoint = await f.target.getCheckpoint(f.sessionId);
    await f.source.issueIdentityToken(token(next));
    const replacement = await f.sourceJournal.readChangeBatch({ sessionId: f.sessionId, afterSequence: checkpoint, limit: 1 });
    assert.deepEqual(replacement.map((change) => change.operation), ["delete", "upsert"]);
    const removeFailure = await injectInsertFailure(f, "target", "auth_identity_tokens");
    try { await assert.rejects(async () => f.target.applyTransaction(replacement), /injected test failure/); }
    finally { await removeFailure(); }
    assert.equal(await f.target.getCheckpoint(f.sessionId), checkpoint);
    assert.equal(await hasToken(f, "target", first), true);
    assert.equal(await hasToken(f, "target", next), false);
    await f.target.applyTransaction(replacement);
    const after = await f.target.getCheckpoint(f.sessionId);
    assert.equal(after, replacement.at(-1)?.sequence);
    await f.target.applyTransaction(replacement);
    assert.equal(await f.target.getCheckpoint(f.sessionId), after);
    assert.equal(await hasToken(f, "target", first), false);
    assert.equal(await hasToken(f, "target", next), true);
  });
}

for (const sourceProvider of ["sqlite", "postgres"] as const) {
  const targetProvider = sourceProvider === "sqlite" ? "postgres" : "sqlite";
  test(`${sourceProvider} → ${targetProvider}: email change rollback preserves proofs and retry deletes them atomically`, options, async (t) => {
    const f = await fixture(t, sourceProvider), account = registration(randomUUID());
    await f.source.createIdentityAccount(account);
    const verification = digest(randomUUID()), reset = digest(randomUUID());
    await f.source.issueIdentityToken({ userId: account.userId, email: account.email, purpose: "email_verification", tokenHash: verification, expiresAt: future() });
    await f.source.issueIdentityToken({ userId: account.userId, email: account.email, purpose: "password_reset", tokenHash: reset, expiresAt: future() });
    await f.drain();
    const before = (await f.sourceJournal.getSession(f.sessionId)).nextSequence, checkpoint = await f.target.getCheckpoint(f.sessionId);
    const moved = `moved-${account.email}`;
    const removeFailure = await injectInsertFailure(f, "source", "provider_migration_changes");
    try { await assert.rejects(async () => f.source.setIdentityEmail({ userId: account.userId, email: moved }), /injected test failure/); }
    finally { await removeFailure(); }
    assert.equal((await f.source.findIdentityAccountByUserId({ userId: account.userId }))?.email, account.email);
    for (const hash of [verification, reset]) assert.equal(await hasToken(f, "source", hash), true);
    assert.equal((await f.sourceJournal.getSession(f.sessionId)).nextSequence, before);
    assert.equal(await f.target.getCheckpoint(f.sessionId), checkpoint);
    assert.equal(await f.source.setIdentityEmail({ userId: account.userId, email: moved }), true);
    await f.drain();
    for (const hash of [verification, reset]) assert.equal(await hasToken(f, "target", hash), false);
    assert.equal((await f.targetStore.findIdentityAccountByUserId({ userId: account.userId }))?.email, moved);
  });

  test(`${sourceProvider}: a conflicting email change keeps the old account and proof`, options, async (t) => {
    const f = await fixture(t, sourceProvider), first = registration(randomUUID()), second = registration(randomUUID());
    await f.source.createIdentityAccount(first); await f.source.createIdentityAccount(second);
    const tokenHash = digest(randomUUID());
    await f.source.issueIdentityToken({ userId: first.userId, email: first.email, purpose: "password_reset", tokenHash, expiresAt: future() });
    const before = (await f.sourceJournal.getSession(f.sessionId)).nextSequence;
    assert.equal(await f.source.setIdentityEmail({ userId: first.userId, email: second.email }), false);
    assert.equal((await f.source.findIdentityAccountByUserId({ userId: first.userId }))?.email, first.email);
    assert.equal(await hasToken(f, "source", tokenHash), true);
    assert.equal((await f.sourceJournal.getSession(f.sessionId)).nextSequence, before);
  });
}

for (const mutation of ["password-change", "email-change"] as const) {
  const operation = (mutation === "password-change" ? "proof-password-change" : "proof-email-change") as const;
  test(`SQLite: an earlier ${mutation} is refused once the reset has committed`, options, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "nw-stale-change-race-")), filename = join(directory, "source.sqlite");
    const f = await fixture(t, "sqlite", { sqliteFile: filename });
    t.after(() => rm(directory, { recursive: true, force: true }));
    const account = registration(randomUUID()), verified = { email: account.email, passwordHash: account.passwordHash };
    await f.source.createIdentityAccount(account);
    const gate = new SharedArrayBuffer(4), workers: Worker[] = [];
    const common = { filename, session: account.session, proof: verified };
    try {
      // The owner's reset commits first; the signed-in change was verified
      // against the state the reset has just replaced.
      const reset = mutation === "password-change"
        ? sqliteRaceWorker(new URL("./test-support/sqlite-login-replay-race-worker.ts", import.meta.url), { ...common, operation: "password-change", gate })
        : sqliteRaceWorker(new URL("./test-support/sqlite-login-replay-race-worker.ts", import.meta.url), { ...common, operation: "email-change", gate });
      workers.push(reset.worker); await reset.holding();
      const stale = sqliteRaceWorker(new URL("./test-support/sqlite-login-replay-race-worker.ts", import.meta.url), { ...common, operation });
      workers.push(stale.worker); await stale.beginning();
      Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0);
      const [resetResult, staleResult] = await Promise.all([reset.done(), stale.done()]);
      if (resetResult.ok === false) throw new Error(`${resetResult.name}: ${resetResult.message}`);
      if (staleResult.ok === false) throw new Error(`${staleResult.name}: ${staleResult.message}`);
      if (mutation === "password-change") assert.deepEqual(resetResult.result, { updated: true, revokedSessions: 1 });
      else assert.equal(resetResult.result, true);
      assert.deepEqual(staleResult.result, mutation === "password-change" ? { updated: false, revokedSessions: 0 } : false);
      const credentials = await f.source.findIdentityCredentials({ userId: account.userId });
      const email = (await f.source.findIdentityAccountByUserId({ userId: account.userId }))?.email;
      if (mutation === "password-change") {
        assert.equal(credentials?.passwordHash, "fixture-password-after", "the reset is the credential on file");
        assert.equal(email, account.email);
      } else {
        assert.equal(credentials?.passwordHash, verified.passwordHash, "the refused change does not touch the credential");
        assert.equal(email, `moved-${account.email}`, "nor the address the reset moved it to");
      }
      const live = mutation === "password-change" ? [] : [account.session.sessionId];
      assert.deepEqual((await f.source.listIdentitySessions({ userId: account.userId, limit: 50 })).map((s) => s.sessionId), live);
      await f.drain();
      assert.deepEqual((await f.targetStore.listIdentitySessions({ userId: account.userId, limit: 50 })).map((s) => s.sessionId), live);
      assert.deepEqual(await f.targetStore.findIdentityCredentials({ userId: account.userId }), credentials);
    } finally {
      Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0);
      await Promise.all(workers.map((worker) => worker.terminate()));
    }
  });
}

for (const mutation of ["password-change", "email-change"] as const) {
  test(`PostgreSQL: an earlier ${mutation} waits for the reset's lock and is then refused`, options, async (t) => {
    const f = await fixture(t, "postgres"), account = registration(randomUUID());
    await f.source.createIdentityAccount(account);
    await f.drain();
    const verified = { email: account.email, passwordHash: account.passwordHash };
    const reset = (store: typeof f.source) => mutation === "password-change"
      ? store.replaceIdentityPassword({ userId: account.userId, passwordHash: "fixture-password-after" })
      : store.setIdentityEmail({ userId: account.userId, email: `moved-${account.email}` });
    const stale = (store: typeof f.source) => mutation === "password-change"
      ? store.replaceIdentityPassword({ userId: account.userId, passwordHash: "fixture-password-signed-in", proof: verified })
      : store.setIdentityEmail({ userId: account.userId, email: `signed-in-${account.email}`, proof: verified });
    const ready = deferred<number>(), started = deferred<number>(), release = deferred();
    let first: Promise<unknown> | undefined, second: Promise<unknown> | undefined;
    try {
      first = reset(createPostgresStore(heldTransaction(f.pg, ready, release)));
      void first.catch(() => {});
      const blocker = await bounded(ready.promise, "the reset to hold the account lock");
      second = stale(createPostgresStore(observedTransaction(f.pg, started)));
      void second.catch(() => {});
      const waiter = await bounded(started.promise, "the stale change to start");
      await waitUntilBlocked(f.pg, waiter, blocker);
      release.resolve();
      const [resetResult, staleResult] = await Promise.all([first, second]);
      if (mutation === "password-change") {
        assert.deepEqual(resetResult, { updated: true, revokedSessions: 1 });
        assert.deepEqual(staleResult, { updated: false, revokedSessions: 0 });
      } else {
        assert.equal(resetResult, true);
        assert.equal(staleResult, false);
      }
      await f.drain();
      const credentials = await f.source.findIdentityCredentials({ userId: account.userId });
      assert.deepEqual(await f.targetStore.findIdentityCredentials({ userId: account.userId }), credentials);
      assert.equal((await f.source.findIdentityAccountByUserId({ userId: account.userId }))?.email,
        mutation === "password-change" ? account.email : `moved-${account.email}`);
      const live = mutation === "password-change" ? [] : [account.session.sessionId];
      assert.deepEqual((await f.targetStore.listIdentitySessions({ userId: account.userId, limit: 50 })).map((s) => s.sessionId), live);
    } finally {
      release.resolve();
      await Promise.allSettled([...(first ? [first] : []), ...(second ? [second] : [])]);
    }
  });
}

for (const mutation of ["password-change", "email-change"] as const) {
  for (const winner of ["login", mutation] as const) {
    test(`PostgreSQL: ${winner} commits first when login and ${mutation} overlap`, options, async (t) => {
      const f = await fixture(t, "postgres"), account = registration(randomUUID()), late = registration(account.userId).session;
      await f.source.createIdentityAccount(account);
      await f.drain();
      const login = (store: typeof f.source) => store.createIdentitySession(late, { email: account.email, passwordHash: account.passwordHash });
      const change = (store: typeof f.source) => mutation === "password-change"
        ? store.replaceIdentityPassword({ userId: account.userId, passwordHash: "fixture-password-after" })
        : store.setIdentityEmail({ userId: account.userId, email: `moved-${account.email}` });
      const ready = deferred<number>(), started = deferred<number>(), release = deferred();
      let first: Promise<unknown> | undefined, second: Promise<unknown> | undefined;
      try {
        const firstStore = createPostgresStore(heldTransaction(f.pg, ready, release));
        first = winner === "login" ? login(firstStore) : change(firstStore);
        void first.catch(() => {});
        const blocker = await bounded(ready.promise, "the first login/account operation to hold its locks");
        const secondStore = createPostgresStore(observedTransaction(f.pg, started));
        second = winner === "login" ? change(secondStore) : login(secondStore);
        void second.catch(() => {});
        const waiter = await bounded(started.promise, "the second login/account operation to start");
        await waitUntilBlocked(f.pg, waiter, blocker);
        release.resolve();
        const [firstResult, secondResult] = await Promise.all([first, second]);
        assert.equal(winner === "login" ? firstResult : secondResult, winner === "login");
        const mutationResult = winner === "login" ? secondResult : firstResult;
        if (mutation === "password-change") assert.deepEqual(mutationResult, { updated: true, revokedSessions: winner === "login" ? 2 : 1 });
        else assert.equal(mutationResult, true);
        await f.drain();
        const expectedSessions = mutation === "password-change" ? [] :
          winner === "login" ? [account.session.sessionId, late.sessionId].sort() : [account.session.sessionId];
        assert.deepEqual((await f.source.listIdentitySessions({ userId: account.userId, limit: 50 })).map((s) => s.sessionId).sort(), expectedSessions);
        assert.deepEqual((await f.targetStore.listIdentitySessions({ userId: account.userId, limit: 50 })).map((s) => s.sessionId).sort(), expectedSessions);
        assert.equal(await f.source.isSessionRevoked(late.accessTokenId), mutation === "password-change" && winner === "login");
        assert.equal(await f.targetStore.isSessionRevoked(late.accessTokenId), mutation === "password-change" && winner === "login");
        assert.deepEqual(await f.targetStore.findIdentityAccountByUserId({ userId: account.userId }), await f.source.findIdentityAccountByUserId({ userId: account.userId }));
        assert.deepEqual(await f.targetStore.findIdentityCredentials({ userId: account.userId }), await f.source.findIdentityCredentials({ userId: account.userId }));
      } finally {
        release.resolve();
        await Promise.allSettled([...(first ? [first] : []), ...(second ? [second] : [])]);
      }
    });
  }
}

for (const purpose of ["email_verification", "password_reset"] as const) {
  for (const winner of ["address-change", "proof"] as const) {
    test(`PostgreSQL: ${winner} commits first when ${purpose} proof races an address change`, options, async (t) => {
      const f = await fixture(t, "postgres"), account = registration(randomUUID()), tokenHash = digest(randomUUID());
      await f.source.createIdentityAccount(account);
      await f.source.issueIdentityToken({ userId: account.userId, email: account.email, purpose, tokenHash, expiresAt: future() });
      assert.ok(await f.source.consumeIdentityToken({ tokenHash, purpose }));
      await f.drain();
      const moved = `moved-${account.email}`;
      const proof = (store: typeof f.source) => purpose === "email_verification"
        ? store.markIdentityEmailVerified({ userId: account.userId, verifiedAt: new Date().toISOString(), consumedTokenHash: tokenHash })
        : store.replaceIdentityPassword({ userId: account.userId, passwordHash: "fixture-password-after", consumedTokenHash: tokenHash });
      const change = (store: typeof f.source) => store.setIdentityEmail({ userId: account.userId, email: moved });
      const ready = deferred<number>(), started = deferred<number>(), release = deferred();
      let first: Promise<unknown> | undefined, second: Promise<unknown> | undefined;
      try {
        const firstStore = createPostgresStore(heldTransaction(f.pg, ready, release));
        first = Promise.resolve(winner === "proof" ? proof(firstStore) : change(firstStore));
        void first.catch(() => {});
        const blocker = await bounded(ready.promise, "the first address/proof operation to hold its locks");
        const secondStore = createPostgresStore(observedTransaction(f.pg, started));
        second = Promise.resolve(winner === "proof" ? change(secondStore) : proof(secondStore));
        void second.catch(() => {});
        const waiter = await bounded(started.promise, "the second address/proof operation to start");
        await waitUntilBlocked(f.pg, waiter, blocker);
        release.resolve();
        const [firstResult, secondResult] = await Promise.all([first, second]);
        const proofResult = winner === "proof" ? firstResult : secondResult;
        if (purpose === "email_verification") assert.equal(proofResult, winner === "proof");
        else assert.deepEqual(proofResult, { updated: winner === "proof", revokedSessions: winner === "proof" ? 1 : 0 });
        await f.drain();
        const sourceAccount = await f.source.findIdentityAccountByUserId({ userId: account.userId });
        assert.equal(sourceAccount?.email, moved);
        assert.equal(sourceAccount?.emailVerifiedAt, null);
        assert.deepEqual(await f.targetStore.findIdentityAccountByUserId({ userId: account.userId }), sourceAccount);
        assert.deepEqual(await f.targetStore.findIdentityCredentials({ userId: account.userId }), await f.source.findIdentityCredentials({ userId: account.userId }));
        assert.equal(await f.targetStore.isSessionRevoked(account.session.accessTokenId), purpose === "password_reset" && winner === "proof");
        assert.equal(await hasToken(f, "target", tokenHash), false);
      } finally {
        release.resolve();
        await Promise.allSettled([...(first ? [first] : []), ...(second ? [second] : [])]);
      }
    });
  }
}

for (const winner of ["consume", "replace"] as const) {
  test(`PostgreSQL: ${winner} commits first when identity token consumption and replacement overlap`, options, async (t) => {
    const f = await fixture(t, "postgres"), account = registration(randomUUID());
    await f.source.createIdentityAccount(account);
    const oldHash = digest(randomUUID()), nextHash = digest(randomUUID());
    const issue = (store: typeof f.source, tokenHash: string) => store.issueIdentityToken({ userId: account.userId, email: account.email,
      purpose: "password_reset", tokenHash, expiresAt: future() });
    const consume = (store: typeof f.source) => store.consumeIdentityToken({ tokenHash: oldHash, purpose: "password_reset" });
    await issue(f.source, oldHash); await f.drain();
    const ready = deferred<number>(), started = deferred<number>(), release = deferred();
    let first: Promise<unknown> | undefined, second: Promise<unknown> | undefined;
    try {
      const firstStore = createPostgresStore(heldTransaction(f.pg, ready, release));
      first = Promise.resolve(winner === "consume" ? consume(firstStore) : issue(firstStore, nextHash));
      void first.catch(() => {});
      const blocker = await bounded(ready.promise, "the first token operation to hold its locks");
      const secondStore = createPostgresStore(observedTransaction(f.pg, started));
      second = Promise.resolve(winner === "consume" ? issue(secondStore, nextHash) : consume(secondStore));
      void second.catch(() => {});
      const waiter = await bounded(started.promise, "the second token operation to begin");
      await waitUntilBlocked(f.pg, waiter, blocker);
      release.resolve();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      assert.deepEqual(winner === "consume" ? firstResult : secondResult, winner === "consume" ? { userId: account.userId, email: account.email } : null);
      await f.drain();
      assert.equal(await hasToken(f, "source", oldHash), false);
      assert.equal(await hasToken(f, "target", oldHash), false);
      assert.equal(await hasToken(f, "target", nextHash), true);
      assert.deepEqual(await f.source.consumeIdentityToken({ tokenHash: nextHash, purpose: "password_reset" }), { userId: account.userId, email: account.email });
      await f.drain();
      assert.equal(await f.targetStore.consumeIdentityToken({ tokenHash: nextHash, purpose: "password_reset" }), null);
    } finally {
      release.resolve();
      await Promise.allSettled([...(first ? [first] : []), ...(second ? [second] : [])]);
    }
  });
}

for (const sourceProvider of ["sqlite", "postgres"] as const) {
  const targetProvider = sourceProvider === "sqlite" ? "postgres" : "sqlite";
  for (const kind of ["session", "revocation", "rate-limit"] as const) {
    for (const phase of ["prepare", "first-apply"] as const) {
      test(`${sourceProvider} → ${targetProvider}: ${phase} rejects a pre-existing target ${kind}`, options, async (t) => {
        const f = await fixture(t, sourceProvider, { prepare: phase !== "prepare" });
        if (kind === "session") await f.targetStore.createIdentityAccount(registration(randomUUID()));
        if (kind === "revocation") await f.targetStore.revokeSession({ sessionId: randomUUID(), expiresAt: future() });
        if (kind === "rate-limit") await f.targetStore.consumeRateLimit({ key: digest(randomUUID()), limit: 3, windowSeconds: 60 });
        if (phase === "prepare") {
          await assert.rejects(prepareMigrationReplayTarget({ sourceJournal: f.sourceJournal, targetJournal: f.target, sessionId: f.sessionId, targetProvider }), /identity|baseline/i);
        } else {
          await f.source.revokeSession({ sessionId: randomUUID(), expiresAt: future() });
          await assert.rejects(f.drain(), /identity|baseline/i);
          assert.equal(await f.target.getCheckpoint(f.sessionId), 0);
        }
      });
    }
  }
}

for (const sourceProvider of ["sqlite", "postgres"] as const) {
  const targetProvider = sourceProvider === "sqlite" ? "postgres" : "sqlite";
  test(`${sourceProvider} → ${targetProvider}: expiry pruning deletes only expired identity tokens`, options, async (t) => {
    const f = await fixture(t, sourceProvider), userId = randomUUID(), email = `${randomUUID()}@example.test`;
    await f.seedAccount(userId, email);
    const expired = digest(randomUUID()), live = digest(randomUUID());
    await f.source.issueIdentityToken({ userId, email, purpose: "email_verification", tokenHash: expired, expiresAt: new Date(Date.now() - 60_000).toISOString() });
    await f.source.issueIdentityToken({ userId, email, purpose: "password_reset", tokenHash: live, expiresAt: future() });
    await f.drain();
    const result = await f.source.pruneExpiredIdentityState() as { identityTokens: number };
    assert.equal(result.identityTokens, 1);
    await f.drain();
    assert.equal(await hasToken(f, "source", expired), false);
    assert.equal(await hasToken(f, "target", expired), false);
    assert.equal(await hasToken(f, "target", live), true);
    assert.deepEqual(await f.source.consumeIdentityToken({ tokenHash: live, purpose: "password_reset" }), { userId, email });
    await f.drain();
    assert.equal(await f.targetStore.consumeIdentityToken({ tokenHash: live, purpose: "password_reset" }), null);
  });
}

for (const sourceProvider of ["sqlite", "postgres"] as const) {
  const targetProvider = sourceProvider === "sqlite" ? "postgres" : "sqlite";
  test(`${sourceProvider} → ${targetProvider}: featured authorization, deletion, purge and clearing stay consistent`, options, async (t) => {
    const f = await fixture(t, sourceProvider), authorId = randomUUID();
    const article = async (suffix: string, publish: boolean) => {
      const slug = `${suffix}-${randomUUID()}`;
      const contentBlocks = [{ id: randomUUID(), type: "paragraph", text: "Editorial fixture" }];
      const result = await f.source.createArticle({ authorId, slug, title: suffix, locale: "en", contentBlocks, publish });
      return result;
    };
    const [first, second, draft] = [await article("first", true), await article("second", true), await article("draft", false)];
    await f.drain();
    await f.source.setFeaturedArticles({ actorId: authorId, actorIsEditor: true, articleIds: [first.id, second.id], locale: "en" });
    await f.drain();
    const before = (await f.sourceJournal.getSession(f.sessionId)).nextSequence;
    await assert.rejects(async () => f.source.setFeaturedArticles({ actorId: authorId, actorIsEditor: false, articleIds: [second.id], locale: "en" }), /editor/i);
    await assert.rejects(async () => f.source.setFeaturedArticles({ actorId: authorId, actorIsEditor: true, articleIds: [draft.id], locale: "en" }), /published/i);
    assert.equal((await f.sourceJournal.getSession(f.sessionId)).nextSequence, before);
    await f.source.deleteArticle({ articleId: first.id, actorId: authorId });
    await f.drain();
    assert.deepEqual((await f.source.listFeaturedArticles({ locale: "en" })).map((entry) => entry.id), [second.id]);
    assert.deepEqual((await f.targetStore.listFeaturedArticles({ locale: "en" })).map((entry) => entry.id), [second.id]);
    const purged = await f.source.purgeExpiredArticles({ retentionDays: 1, now: new Date(Date.now() + 2 * 86_400_000) });
    assert.equal(purged.purged, 1);
    await f.drain();
    assert.deepEqual((await f.targetStore.listFeaturedArticles({ locale: "en" })).map((entry) => entry.id), [second.id]);
    await f.source.setFeaturedArticles({ actorId: authorId, actorIsEditor: true, articleIds: [], locale: "en" });
    await f.drain();
    assert.deepEqual(await f.targetStore.listFeaturedArticles({ locale: "en" }), []);
  });

  test(`${sourceProvider} → ${targetProvider}: a demoted role cannot be revived by a duplicate promotion`, options, async (t) => {
    const f = await fixture(t, sourceProvider), account = registration(randomUUID());
    await f.source.createIdentityAccount(account); await f.drain();
    const checkpoint = await f.target.getCheckpoint(f.sessionId);
    await f.source.setUserRole({ actorId: randomUUID(), userId: account.userId, role: "editor" });
    const promotion = await f.sourceJournal.readChangeBatch({ sessionId: f.sessionId, afterSequence: checkpoint, limit: 1 });
    await f.drain();
    assert.equal(await f.targetStore.getUserRole({ userId: account.userId }), "editor");
    await f.source.setUserRole({ actorId: randomUUID(), userId: account.userId, role: "member" });
    await f.drain();
    await f.target.applyTransaction(promotion);
    assert.equal(await f.source.getUserRole({ userId: account.userId }), "member");
    assert.equal(await f.targetStore.getUserRole({ userId: account.userId }), "member");
  });
}

for (const sourceProvider of ["sqlite", "postgres"] as const) {
  const targetProvider = sourceProvider === "sqlite" ? "postgres" : "sqlite";
  test(`${sourceProvider} → ${targetProvider}: an old session remains rejected after an existing checkpoint`, options, async (t) => {
    const f = await fixture(t, sourceProvider, { prepare: false, schemaVersion: "media-reference-snapshots-v1" });
    await f.source.revokeSession({ sessionId: randomUUID(), expiresAt: future() });
    const changes = await f.sourceJournal.readChangeBatch({ sessionId: f.sessionId, afterSequence: 0, limit: 1 });
    await f.target.createSession({ sessionId: f.sessionId, sourceProvider, targetProvider, schemaVersion: "media-reference-snapshots-v1" });
    await f.target.transitionSession({ sessionId: f.sessionId, expectedStatus: "prepared", nextStatus: "recording" });
    await f.target.transitionSession({ sessionId: f.sessionId, expectedStatus: "recording", nextStatus: "catching_up" });
    if (targetProvider === "sqlite") {
      const journal = createSqliteProviderMigrationJournal(f.db);
      f.db.exec("BEGIN IMMEDIATE");
      try { journal.markAppliedInTransaction(f.db, changes[0]); f.db.exec("COMMIT"); }
      catch (error) { f.db.exec("ROLLBACK"); throw error; }
    } else {
      const journal = createPostgresProviderMigrationJournal(f.pg);
      await f.pg.begin(async (tx) => { await journal.markAppliedInTransaction(tx, changes[0]); });
    }
    assert.equal(await f.target.getCheckpoint(f.sessionId), 1);
    await assert.rejects(async () => f.target.applyTransaction(changes), /schema|version/i);
    await assert.rejects(f.drain(), /schema|version/i);
    assert.equal(await f.target.getCheckpoint(f.sessionId), 1);
  });
}

for (const sourceProvider of ["sqlite", "postgres"] as const) {
  test(`${sourceProvider}: issuing a non-hex digest fails before replacing a token`, options, async (t) => {
    const f = await fixture(t, sourceProvider), userId = randomUUID(), email = `${randomUUID()}@example.test`;
    await f.seedAccount(userId, email);
    const good = digest(randomUUID());
    await f.source.issueIdentityToken({ userId, email, purpose: "password_reset", tokenHash: good, expiresAt: future() });
    const before = (await f.sourceJournal.getSession(f.sessionId)).nextSequence;
    await assert.rejects(f.source.issueIdentityToken({ userId, email, purpose: "password_reset", tokenHash: "x".repeat(64), expiresAt: future() }), /digest|hex/i);
    assert.equal(await hasToken(f, "source", good), true);
    assert.equal((await f.sourceJournal.getSession(f.sessionId)).nextSequence, before);
  });
}

async function appendTestChanges(f: MigrationFixture, entries: Array<{ entityType: string; entityId: string; payload: Record<string, unknown> }>) {
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

for (const sourceProvider of ["sqlite", "postgres"] as const) {
  const targetProvider = sourceProvider === "sqlite" ? "postgres" : "sqlite";
  test(`${sourceProvider} → ${targetProvider}: account email uniqueness rolls back a whole replay transaction`, options, async (t) => {
    const f = await fixture(t, sourceProvider), first = randomUUID(), second = randomUUID(), email = `${randomUUID()}@example.test`, created = new Date().toISOString();
    const account = (userId: string) => ({ entityType: "auth_accounts", entityId: userId, payload: {
      user_id: userId, email, password_hash: "fixture-password", created_at: created, email_verified_at: null,
    } });
    const changes = await appendTestChanges(f, [account(first), account(second)]);
    await assert.rejects(async () => f.target.applyTransaction(changes), /unique|duplicate/i);
    assert.equal(await f.target.getCheckpoint(f.sessionId), 0);
    assert.equal(await f.targetStore.findIdentityAccountByUserId({ userId: first }), null);
    assert.equal(await f.targetStore.findIdentityAccountByUserId({ userId: second }), null);
  });

  for (const entity of ["auth_identity_tokens", "auth_sessions", "featured_articles"] as const) {
    test(`${sourceProvider} → ${targetProvider}: ${entity} replay rejects a missing foreign key`, options, async (t) => {
      const f = await fixture(t, sourceProvider), id = entity === "auth_identity_tokens" ? digest(randomUUID()) : randomUUID(), now = new Date().toISOString();
      const payload = entity === "auth_identity_tokens"
        ? { token_hash: id, user_id: randomUUID(), purpose: "password_reset", email: "fixture@example.test", created_at: now, expires_at: future(), consumed_at: null }
        : entity === "auth_sessions"
          ? { id, user_id: randomUUID(), expires_at: future(), revoked_at: null, created_at: now }
          : { article_id: id, position: 0, created_by: "fixture-editor", created_at: now };
      const changes = await appendTestChanges(f, [{ entityType: entity, entityId: id, payload }]);
      await assert.rejects(async () => f.target.applyTransaction(changes), /foreign key/i);
      assert.equal(await f.target.getCheckpoint(f.sessionId), 0);
    });
  }

  test(`${sourceProvider} → ${targetProvider}: incomplete verification state is not defaulted`, options, async (t) => {
    const f = await fixture(t, sourceProvider), userId = randomUUID();
    const changes = await appendTestChanges(f, [{ entityType: "auth_accounts", entityId: userId, payload: {
      user_id: userId, email: `${randomUUID()}@example.test`, password_hash: "fixture-password", created_at: new Date().toISOString(),
    } }]);
    await assert.rejects(async () => f.target.applyTransaction(changes), /required|schema/i);
    assert.equal(await f.target.getCheckpoint(f.sessionId), 0);
    assert.equal(await f.targetStore.findIdentityAccountByUserId({ userId }), null);
  });
}

test("captured entities match both migrated schemas, primary keys, foreign keys and unique indexes", options, async (t) => {
  const f = await fixture(t, "sqlite");
  const entities = getSupportedMigrationEntityTypes();
  const files = await readdir(new URL(".", import.meta.url));
  for (const provider of ["sqlite", "postgres"] as const) {
    const captured = new Set<string>();
    for (const file of files.filter((name) => name.startsWith(`${provider}-`) && name.endsWith("-store.ts"))) {
      const source = await readFile(new URL(file, import.meta.url), "utf8");
      for (const match of source.matchAll(/entityType:\s*["']([a-z_]+)["']/g)) captured.add(match[1]);
    }
    assert.deepEqual([...captured].sort(), entities, `${provider} captured entity literals and replay allowlist must agree`);
  }
  for (const entity of entities) {
    const spec = getMigrationEntitySpec(entity);
    const sqliteColumns = f.db.prepare(`PRAGMA table_info(${spec.table})`).all();
    const pgColumns = await f.pg.unsafe<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1", [spec.table]);
    assert.deepEqual(sqliteColumns.map((row) => row.name).sort(), [...spec.columns].sort(), `${entity}: SQLite columns`);
    assert.deepEqual(pgColumns.map((row) => row.column_name).sort(), [...spec.columns].sort(), `${entity}: PostgreSQL columns`);
    const sqlitePrimary = sqliteColumns.filter((row) => Number(row.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map((row) => row.name);
    const pgPrimary = await f.pg.unsafe<{ column_name: string }>(`SELECT k.column_name FROM information_schema.table_constraints c
      JOIN information_schema.key_column_usage k USING (constraint_catalog, constraint_schema, constraint_name)
      WHERE c.constraint_type = 'PRIMARY KEY' AND c.table_schema = current_schema() AND c.table_name = $1 ORDER BY k.ordinal_position`, [spec.table]);
    assert.deepEqual(sqlitePrimary, [...spec.primaryKey], `${entity}: SQLite primary key`);
    assert.deepEqual(pgPrimary.map((row) => row.column_name), [...spec.primaryKey], `${entity}: PostgreSQL primary key`);

    const sqliteFk = f.db.prepare(`PRAGMA foreign_key_list(${spec.table})`).all()
      .map((row) => `${row.from}->${row.table}.${row.to}:${row.on_delete}`).sort();
    const pgFk = await f.pg.unsafe<{ col: string; tab: string; ref: string; del: string }>(`SELECT a.attname AS col, rt.relname AS tab, ra.attname AS ref,
      CASE c.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS del
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_class rt ON rt.oid = c.confrelid JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(local_no, foreign_no, position) ON true
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.local_no
      JOIN pg_attribute ra ON ra.attrelid = rt.oid AND ra.attnum = k.foreign_no
      WHERE c.contype = 'f' AND n.nspname = current_schema() AND t.relname = $1`, [spec.table]);
    assert.deepEqual(pgFk.map((row) => `${row.col}->${row.tab}.${row.ref}:${row.del}`).sort(), sqliteFk, `${entity}: foreign keys`);

    const sqliteUnique = f.db.prepare(`PRAGMA index_list(${spec.table})`).all().filter((row) => row.unique)
      .map((row) => ({ cols: f.db.prepare(`PRAGMA index_info(${row.name})`).all().map((column) => column.name), partial: Number(row.partial) }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const pgUnique = await f.pg.unsafe<{ cols: string[]; partial: boolean }>(`SELECT i.indpred IS NOT NULL AS partial,
      ARRAY(SELECT a.attname FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum ORDER BY k.ord) AS cols
      FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = current_schema() AND t.relname = $1 AND i.indisunique`, [spec.table]);
    const pgIndexes = pgUnique.map((row) => ({ cols: row.cols, partial: row.partial ? 1 : 0 }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    assert.deepEqual(pgIndexes, sqliteUnique, `${entity}: unique indexes`);
  }
});

type SqliteIdentityOutcome = { ok: true; result: unknown } | { ok: false; name: string; message: string };
function sqliteRaceWorker(script: URL, input: object) {
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
  worker.on("error", (error) => finish({ ok: false, name: error.name, message: error.message }));
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

function sqliteIdentityWorker(input: { filename: string; operation: "issue" | "consume"; userId: string; email: string; tokenHash: string; expiresAt: string; gate?: SharedArrayBuffer }) {
  return sqliteRaceWorker(new URL("./test-support/sqlite-identity-replay-race-worker.ts", import.meta.url), input);
}

for (const mutation of ["password-change", "email-change"] as const) {
  for (const winner of ["login", mutation] as const) {
    test(`SQLite: ${winner} commits first when login and ${mutation} overlap`, options, async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "nw-login-replay-race-")), filename = join(directory, "source.sqlite");
      const f = await fixture(t, "sqlite", { sqliteFile: filename });
      t.after(() => rm(directory, { recursive: true, force: true }));
      const account = registration(randomUUID()), late = registration(account.userId).session;
      await f.source.createIdentityAccount(account);
      await f.drain();
      const gate = new SharedArrayBuffer(4), workers: Worker[] = [];
      const common = { filename, session: late, proof: { email: account.email, passwordHash: account.passwordHash } };
      try {
        const first = sqliteRaceWorker(new URL("./test-support/sqlite-login-replay-race-worker.ts", import.meta.url), { ...common, operation: winner, gate });
        workers.push(first.worker); await first.holding();
        const observer = createSqliteClient({ filename, timeoutMs: 0, enableWal: false });
        try { assert.throws(() => observer.exec("BEGIN IMMEDIATE"), /locked|busy/i); }
        finally { if (observer.isTransaction) observer.exec("ROLLBACK"); observer.close(); }
        const secondOperation = winner === "login" ? mutation : "login";
        const second = sqliteRaceWorker(new URL("./test-support/sqlite-login-replay-race-worker.ts", import.meta.url), { ...common, operation: secondOperation });
        workers.push(second.worker); await second.beginning();
        Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0);
        const firstResult = await first.done(), secondResult = await second.done();
        if (firstResult.ok === false) throw new Error(`${firstResult.name}: ${firstResult.message}`);
        if (secondResult.ok === false) throw new Error(`${secondResult.name}: ${secondResult.message}`);
        assert.equal(winner === "login" ? firstResult.result : secondResult.result, winner === "login");
        const mutationResult = winner === "login" ? secondResult.result : firstResult.result;
        if (mutation === "password-change") assert.deepEqual(mutationResult, { updated: true, revokedSessions: winner === "login" ? 2 : 1 });
        else assert.equal(mutationResult, true);
        await f.drain();
        const expectedSessions = mutation === "password-change" ? [] :
          winner === "login" ? [account.session.sessionId, late.sessionId].sort() : [account.session.sessionId];
        assert.deepEqual((await f.source.listIdentitySessions({ userId: account.userId, limit: 50 })).map((s) => s.sessionId).sort(), expectedSessions);
        assert.deepEqual((await f.targetStore.listIdentitySessions({ userId: account.userId, limit: 50 })).map((s) => s.sessionId).sort(), expectedSessions);
        assert.equal(await f.targetStore.isSessionRevoked(late.accessTokenId), mutation === "password-change" && winner === "login");
        assert.deepEqual(await f.targetStore.findIdentityAccountByUserId({ userId: account.userId }), await f.source.findIdentityAccountByUserId({ userId: account.userId }));
        assert.deepEqual(await f.targetStore.findIdentityCredentials({ userId: account.userId }), await f.source.findIdentityCredentials({ userId: account.userId }));
      } finally {
        Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0);
        await Promise.all(workers.map((worker) => worker.terminate()));
      }
    });
  }
}

for (const winner of ["first-issue", "consume", "replace"] as const) {
  test(`SQLite source: ${winner} commits first during overlapping token writes`, options, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "nw-identity-replay-race-")), filename = join(directory, "source.sqlite");
    const f = await fixture(t, "sqlite", { sqliteFile: filename });
    t.after(() => rm(directory, { recursive: true, force: true }));
    const userId = randomUUID(), email = `${randomUUID()}@example.test`, oldHash = digest(randomUUID()), nextHash = digest(randomUUID());
    await f.seedAccount(userId, email);
    if (winner !== "first-issue") {
      await f.source.issueIdentityToken({ userId, email, purpose: "password_reset", tokenHash: oldHash, expiresAt: future() });
      await f.drain();
    }
    const gate = new SharedArrayBuffer(4), workers: Worker[] = [];
    const common = { filename, userId, email, expiresAt: future() };
    try {
      const firstOperation = winner === "consume" ? "consume" : "issue";
      const firstHash = winner === "replace" ? nextHash : oldHash;
      const first = sqliteIdentityWorker({ ...common, operation: firstOperation, tokenHash: firstHash, gate });
      workers.push(first.worker); await first.holding();
      const observer = createSqliteClient({ filename, timeoutMs: 0, enableWal: false });
      try { assert.throws(() => observer.exec("BEGIN IMMEDIATE"), /locked|busy/i); }
      finally { if (observer.isTransaction) observer.exec("ROLLBACK"); observer.close(); }
      const secondOperation = winner === "replace" ? "consume" : "issue";
      const secondHash = winner === "replace" ? oldHash : nextHash;
      const second = sqliteIdentityWorker({ ...common, operation: secondOperation, tokenHash: secondHash });
      workers.push(second.worker); await second.beginning();
      Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0);
      const firstResult = await first.done(), secondResult = await second.done();
      if (firstResult.ok === false) throw new Error(`${firstResult.name}: ${firstResult.message}`);
      if (secondResult.ok === false) throw new Error(`${secondResult.name}: ${secondResult.message}`);
      if (winner === "consume") assert.deepEqual(firstResult.result, { userId, email });
      if (winner === "replace") assert.equal(secondResult.result, null);
      await f.drain();
      assert.equal(await hasToken(f, "source", oldHash), false);
      assert.equal(await hasToken(f, "target", oldHash), false);
      assert.equal(await hasToken(f, "target", nextHash), true);
    } finally {
      Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0);
      await Promise.all(workers.map((worker) => worker.terminate()));
    }
  });
}

for (const sourceProvider of ["sqlite", "postgres"] as const) {
  for (const mutation of ["password-change", "email-change"] as const) {
    test(`${sourceProvider}: HTTP login fails closed when ${mutation} wins after verification`, options, async (t) => {
      const f = await fixture(t, sourceProvider), password = `fixture-password-${randomUUID()}`;
      const account = { ...registration(randomUUID()), passwordHash: await hashPassword(password) };
      await f.source.createIdentityAccount(account);
      await f.drain();
      let attempts = 0;
      const store = { ...f.source, async createIdentitySession(
        session: Parameters<typeof f.source.createIdentitySession>[0], proof: Parameters<typeof f.source.createIdentitySession>[1],
      ) {
        attempts += 1;
        if (mutation === "password-change") await f.source.replaceIdentityPassword({ userId: account.userId, passwordHash: "fixture-password-after" });
        else await f.source.setIdentityEmail({ userId: account.userId, email: `moved-${account.email}` });
        const before = (await f.sourceJournal.getSession(f.sessionId)).nextSequence;
        const created = await f.source.createIdentitySession(session, proof);
        assert.equal((await f.sourceJournal.getSession(f.sessionId)).nextSequence, before, "the refused session leaves no journal records");
        return created;
      } };
      const records: unknown[] = [];
      const server = createApiServer({ store, env: {
        AUTH_JWT_SECRET: "test-fixture-secret-not-a-real-credential", AUTH_JWT_ISSUER: "test", AUTH_JWT_AUDIENCE: "test",
      }, logger: (record) => { records.push(record); } });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("The identity test server did not bind a port.");
        const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/auth/login`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: account.email, password }),
        });
        assert.equal(attempts, 1, "the password was verified before the account changed");
        assert.equal(response.status, 401);
        assert.equal(response.headers.get("set-cookie"), null);
        const body = await response.text(), parsed = JSON.parse(body);
        assert.equal(parsed.error?.code, "UNAUTHENTICATED");
        assert.ok(!parsed.data?.accessToken && !parsed.data?.refreshToken);
        for (const sensitive of [password, account.email, account.passwordHash]) {
          assert.ok(!body.includes(sensitive) && !JSON.stringify(records).includes(sensitive));
        }
        await f.drain();
        const expected = mutation === "password-change" ? [] : [account.session.sessionId];
        assert.deepEqual((await f.source.listIdentitySessions({ userId: account.userId, limit: 50 })).map((s) => s.sessionId), expected);
        assert.deepEqual((await f.targetStore.listIdentitySessions({ userId: account.userId, limit: 50 })).map((s) => s.sessionId), expected);
      } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
    });
  }
}

for (const sourceProvider of ["sqlite", "postgres"] as const) {
  for (const endpoint of ["password", "email"] as const) {
    test(`${sourceProvider}: HTTP ${endpoint} change is refused when a reset lands while it runs`, options, async (t) => {
      const f = await fixture(t, sourceProvider), password = `fixture-password-${randomUUID()}`;
      const account = { ...registration(randomUUID()), passwordHash: await hashPassword(password) };
      await f.source.createIdentityAccount(account);
      await f.drain();
      // The reset commits between the password check and the write. A change
      // that only verified the old credential would otherwise put it back.
      const store = { ...f.source,
        async replaceIdentityPassword(input: Parameters<typeof f.source.replaceIdentityPassword>[0]) {
          if (input.proof && endpoint === "password") {
            await f.source.replaceIdentityPassword({ userId: account.userId, passwordHash: "fixture-password-reset" });
          }
          return f.source.replaceIdentityPassword(input);
        },
        async setIdentityEmail(input: Parameters<typeof f.source.setIdentityEmail>[0]) {
          if (input.proof && endpoint === "email") {
            await f.source.replaceIdentityPassword({ userId: account.userId, passwordHash: "fixture-password-reset" });
          }
          return f.source.setIdentityEmail(input);
        } };
      const server = createApiServer({ store, env: {
        AUTH_JWT_SECRET: "test-fixture-secret-not-a-real-credential", AUTH_JWT_ISSUER: "test", AUTH_JWT_AUDIENCE: "test",
      } });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("The identity test server did not bind a port.");
        const base = `http://127.0.0.1:${address.port}/api/v1`;
        const login = await fetch(`${base}/auth/login`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: account.email, password }),
        });
        assert.equal(login.status, 200);
        const accessToken = (await login.json() as { data?: { accessToken?: string } }).data?.accessToken;
        assert.ok(accessToken, "the signed-in change is authenticated by the login it just made");
        const response = await fetch(`${base}/me/${endpoint}`, {
          method: "PUT", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
          body: JSON.stringify(endpoint === "password"
            ? { currentPassword: password, newPassword: "a-brand-new-password" }
            : { password, email: `moved-${account.email}` }),
        });
        assert.equal(response.status, 401);
        assert.equal((await response.json() as { error?: { code?: string } }).error?.code, "UNAUTHENTICATED");
        assert.equal((await f.source.findIdentityCredentials({ userId: account.userId }))?.passwordHash, "fixture-password-reset",
          "the reset is the credential that survives");
        assert.equal((await f.source.findIdentityAccountByUserId({ userId: account.userId }))?.email, account.email,
          "the refused change does not move the address");
      } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
    });
  }
}

for (const sourceProvider of ["sqlite", "postgres"] as const) {
  test(`${sourceProvider}: old-address recovery HTTP requests fail without logging credentials`, options, async (t) => {
    const f = await fixture(t, sourceProvider), account = registration(randomUUID());
    const verification = randomBytes(32).toString("base64url"), reset = randomBytes(32).toString("base64url"), password = `fixture-password-${randomUUID()}`;
    await f.source.createIdentityAccount(account);
    await f.source.issueIdentityToken({ userId: account.userId, email: account.email, purpose: "email_verification", tokenHash: digest(verification), expiresAt: future() });
    await f.source.issueIdentityToken({ userId: account.userId, email: account.email, purpose: "password_reset", tokenHash: digest(reset), expiresAt: future() });
    await f.source.setIdentityEmail({ userId: account.userId, email: `moved-${account.email}` });
    const records: unknown[] = [];
    const server = createApiServer({ store: f.source, env: {
      AUTH_JWT_SECRET: "test-fixture-secret-not-a-real-credential", AUTH_JWT_ISSUER: "test", AUTH_JWT_AUDIENCE: "test",
    }, logger: (record) => { records.push(record); } });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("The identity test server did not bind a port.");
      const post = (path: string, body: object) => fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const responses = [await post("/api/v1/auth/verify-email", { token: verification }),
        await post("/api/v1/auth/reset-password", { token: reset, password })];
      for (const response of responses) {
        assert.equal(response.status, 401);
        const body = await response.text();
        for (const secret of [verification, reset, password, account.email]) assert.ok(!body.includes(secret));
      }
      const journal = JSON.stringify(await f.sourceJournal.readChangeBatch({ sessionId: f.sessionId, afterSequence: 0, limit: 1000 }));
      const logs = JSON.stringify(records);
      for (const secret of [verification, reset, password]) assert.ok(!journal.includes(secret) && !logs.includes(secret));
      assert.ok(!logs.includes(account.email));
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
}

for (const sourceProvider of ["sqlite", "postgres"] as const) {
  for (const purpose of ["email_verification", "password_reset"] as const) {
    test(`${sourceProvider}: ${purpose} service fails closed if the proof changes after consumption`, options, async (t) => {
      const f = await fixture(t, sourceProvider), account = registration(randomUUID()), token = randomBytes(32).toString("base64url");
      await f.source.createIdentityAccount(account);
      await f.source.issueIdentityToken({ userId: account.userId, email: account.email, purpose, tokenHash: digest(token), expiresAt: future() });
      const store = { ...f.source, async consumeIdentityToken(input: { tokenHash: string; purpose: "email_verification" | "password_reset" }) {
        const consumed = await f.source.consumeIdentityToken(input);
        if (consumed) {
          await f.source.setIdentityEmail({ userId: account.userId, email: `moved-${account.email}` });
          await f.source.setIdentityEmail({ userId: account.userId, email: account.email });
        }
        return consumed;
      } };
      const service = createIdentityService({ store, env: {
        AUTH_JWT_SECRET: "test-fixture-secret-not-a-real-credential", AUTH_JWT_ISSUER: "test", AUTH_JWT_AUDIENCE: "test",
      } });
      if (purpose === "email_verification") await assert.rejects(service.verifyEmail({ token }, "192.0.2.12"), IdentityAuthenticationError);
      else await assert.rejects(service.resetPassword({ token, password: "test-password-after-change" }, "192.0.2.12"), IdentityAuthenticationError);
      await f.drain();
      assert.equal((await f.source.findIdentityAccountByUserId({ userId: account.userId }))?.emailVerifiedAt, null);
      assert.equal((await f.source.findIdentityCredentials({ userId: account.userId }))?.passwordHash, account.passwordHash);
      assert.equal(await f.targetStore.isSessionRevoked(account.session.accessTokenId), false);
      assert.deepEqual(await f.targetStore.findIdentityCredentials({ userId: account.userId }), await f.source.findIdentityCredentials({ userId: account.userId }));
    });
  }
}

for (const sourceProvider of ["sqlite", "postgres"] as const) {
  const targetProvider = sourceProvider === "sqlite" ? "postgres" : "sqlite";
  for (const phase of ["prepare", "first-apply"] as const) {
    test(`${sourceProvider} → ${targetProvider}: ${phase} rejects a pre-existing featured shelf`, options, async (t) => {
      const f = await fixture(t, sourceProvider, { prepare: phase !== "prepare" }), articleId = randomUUID(), slug = `baseline-${randomUUID()}`;
      if (targetProvider === "sqlite") {
        f.db.prepare("INSERT INTO articles (id, author_id, slug, status) VALUES (?, ?, ?, 'published')").run(articleId, "fixture-author", slug);
        f.db.prepare("INSERT INTO featured_articles (article_id, position, created_by) VALUES (?, 0, ?)").run(articleId, "fixture-editor");
      } else {
        await f.pg.unsafe("INSERT INTO articles (id, author_id, slug, status) VALUES ($1, $2, $3, 'published')", [articleId, "fixture-author", slug]);
        await f.pg.unsafe("INSERT INTO featured_articles (article_id, position, created_by) VALUES ($1, 0, $2)", [articleId, "fixture-editor"]);
      }
      if (phase === "prepare") await assert.rejects(prepareMigrationReplayTarget({ sourceJournal: f.sourceJournal, targetJournal: f.target, sessionId: f.sessionId, targetProvider }), /media|baseline/i);
      else {
        await f.source.revokeSession({ sessionId: randomUUID(), expiresAt: future() });
        await assert.rejects(f.drain(), /media|baseline/i);
        assert.equal(await f.target.getCheckpoint(f.sessionId), 0);
      }
    });
  }
}
