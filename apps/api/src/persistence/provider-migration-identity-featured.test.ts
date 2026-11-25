import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { createIdentityService } from "../application/identity.ts";
import { IdentityAuthenticationError } from "../domain/errors.ts";

import test from "node:test";
import { createPostgresStore } from "./postgres.ts";

import { prepareMigrationReplayTarget } from "./provider-migration-replay.ts";

import { options, digest, future, fixture, registration, deferred, bounded, heldTransaction, observedTransaction, waitUntilBlocked, hasToken, injectInsertFailure, sqliteRaceWorker } from "./test-support/provider-migration-identity-featured-fixtures.ts";

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
