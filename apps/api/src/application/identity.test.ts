import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createIdentityService } from "./identity.ts";
import { createLogMailer, resolveIdentityMailer } from "./identity-mailer.ts";
import { SmtpError } from "../infrastructure/smtp-client.ts";
import {
  IdentityAuthenticationError, IdentityConflictError, IdentityInputError,
  IdentitySessionNotFoundError, MailDisabledError,
} from "../domain/errors.ts";
import { hashPassword, verifyPassword } from "../security/passwords.ts";

test("login fails closed when the verified account state changes before session creation", async () => {
  const password = "fixture-password-for-login";
  const passwordHash = await hashPassword(password);
  const email = "fixture-login@example.test";
  let seenProof: unknown;
  const service = createIdentityService({
    env: { AUTH_JWT_SECRET: "fixture-secret-not-a-real-key-32-bytes", AUTH_JWT_ISSUER: "test", AUTH_JWT_AUDIENCE: "test" },
    store: {
      async consumeRateLimit() { return { allowed: true, resetAt: new Date(Date.now() + 60_000).toISOString() }; },
      async findIdentityAccount() { return { userId: "fixture-user", passwordHash }; },
      async createIdentitySession(_session, proof) { seenProof = proof; return false; },
    },
  });
  await assert.rejects(service.login({ email, password }, "192.0.2.10"), IdentityAuthenticationError);
  assert.deepEqual(seenProof, { email, passwordHash }, "the adapter must recheck the exact verified credentials");
});

test("identity maintenance is periodically invoked without exposing throttle subjects", async () => {
  const keys = [];
  let cleanups = 0;
  const service = createIdentityService({
    env: { AUTH_JWT_SECRET: "fixture-secret-not-a-real-key-32-bytes", AUTH_JWT_ISSUER: "test", AUTH_JWT_AUDIENCE: "test" },
    store: {
      async consumeRateLimit({ key }) { keys.push(key); return { allowed: true, resetAt: new Date(Date.now() + 60000).toISOString() }; },
      async revokeIdentityRefresh() { return true; },
      async pruneExpiredIdentityState() { cleanups += 1; },
    },
  });
  const refreshToken = randomBytes(32).toString("base64url");
  for (let i = 0; i < 128; i += 1) await service.logout({ refreshToken }, "192.0.2.123");
  assert.equal(cleanups, 1);
  assert.equal(keys.length, 128);
  assert.ok(keys.every((key) => /^[0-9a-f]{64}$/.test(key)));
  assert.equal(new Set(keys).size, 1);
  assert.ok(!keys.some((key) => key.includes("192.0.2.123")));
});

/**
 * The registration throttle's address limit.
 *
 * The default is a production abuse control and must not move: registration is
 * the only unauthenticated write that creates rows, and behind the Web proxy
 * every browser shares an address. What is asserted here is that the number the
 * limiter sees is that default unless the operator names another one, and that a
 * value which cannot be read as a limit cannot quietly switch the throttle off.
 */
async function registerLimitSeenByTheThrottle(env: Record<string, string>): Promise<number> {
  const limits: number[] = [];
  const service = createIdentityService({
    env: { AUTH_JWT_SECRET: "fixture-secret-not-a-real-key-32-bytes", AUTH_JWT_ISSUER: "test", AUTH_JWT_AUDIENCE: "test", ...env },
    store: {
      async consumeRateLimit({ limit }) { limits.push(limit); return { allowed: true, resetAt: new Date(Date.now() + 60_000).toISOString() }; },
      async createIdentityAccount() { return true; },
      async findIdentityAccount() { return null; },
      async createIdentitySession() { return true; },
      async revokeIdentityRefresh() { return true; },
      async pruneExpiredIdentityState() { return true; },
    },
  });
  await service.register({ email: `throttle-${Date.now().toString(36)}@example.test`, password: "e2e-browser-password" }, "192.0.2.123");
  // The address bucket is charged first, then the address's own email bucket.
  return { ip: limits[0] ?? -1, email: limits[1] ?? -1 };
}

test("the registration throttle keeps its default, and only the operator can widen it", async () => {
  const defaulted = await registerLimitSeenByTheThrottle({});
  assert.equal(defaulted.ip, 20, "the default is unchanged");
  assert.equal(defaulted.email, 5, "the per-address email throttle is unchanged too");
  assert.equal((await registerLimitSeenByTheThrottle({ AUTH_REGISTER_IP_LIMIT: "40" })).ip, 40, "a configured limit is honoured");

  // A limit that does not parse — or that would disable the throttle — falls
  // back to the default instead of leaving registration open.
  for (const unusable of ["0", "-3", "unlimited", "   "]) {
    assert.equal(
      (await registerLimitSeenByTheThrottle({ AUTH_REGISTER_IP_LIMIT: unusable })).ip,
      20,
      `"${unusable}" must not be read as a limit`,
    );
  }
});

/**
 * Recovery and verification.
 *
 * These are the two transitions ADR 0008 left open, and the assertions here are
 * the ones that make them safe to expose: the answer must not reveal whether an
 * address has an account, a token must work exactly once, changing a password
 * must sign out every device, and the link that can reset an account must not be
 * written to a log by default.
 */
/**
 * Mail is **on** for this fixture.
 *
 * These tests are about what the recovery and verification flows do, so the
 * switch is enabled and the log mailer carries the message. The switch's own
 * behaviour — off by default, and what it refuses — has tests of its own below.
 */
const identityEnv = {
  AUTH_JWT_SECRET: "fixture-secret-not-a-real-key-32-bytes",
  AUTH_JWT_ISSUER: "test",
  AUTH_JWT_AUDIENCE: "test",
  AUTH_IDENTITY_BASE_URL: "https://example.test",
  MAIL_ENABLED: "true",
};

function fakeIdentityStore({ accounts = [] as Array<{ userId: string; email: string; passwordHash: string }>, limits = null as number[] | null } = {}) {
  const tokens = new Map<string, { userId: string; purpose: string; email: string; expiresAt: string; consumedAt: string | null }>();
  /** Two devices are signed in per account, so a revocation can spare one. */
  const sessions = new Map<string, string[]>();
  const revoked: string[] = [];
  const revocations: Array<{ userId: string; exceptSessionId: string | null }> = [];
  const replacements: Array<{ userId: string; exceptSessionId: string | null }> = [];
  const passwords = new Map<string, string>();
  const verifiedAt = new Map<string, string>();
  /** The proofs the service hands the store for its signed-in changes. */
  const proofs: Array<{ operation: string; proof: unknown }> = [];
  /** Runs inside the write, before the proof is compared: a competing reset. */
  let duringReplace: (() => void) | null = null;
  let duringEmailChange: (() => void) | null = null;
  /** Set to make the store refuse the replacement, the way a failed write does. */
  let refuseReplacement = false;
  const ended: string[] = [];
  const used = new Map<string, string>();
  const sent: Array<{ to: string; purpose: string; subject: string; link: string }> = [];
  for (const account of accounts) {
    passwords.set(account.userId, account.passwordHash);
    sessions.set(account.userId, ["session-1", "session-2"]);
  }
  const store = {
    accounts,
    sent,
    tokens,
    revoked,
    revocations,
    replacements,
    proofs,
    ended,
    used,
    passwords,
    verifiedAt,
    set refuseReplacement(value: boolean) { refuseReplacement = value; },
    set duringReplace(value: (() => void) | null) { duringReplace = value; },
    set duringEmailChange(value: (() => void) | null) { duringEmailChange = value; },
    async findIdentityAccount({ email }) {
      const account = accounts.find((entry) => entry.email === email);
      return account ? { userId: account.userId, passwordHash: passwords.get(account.userId) } : null;
    },
    async findIdentityAccountByUserId({ userId }) {
      const account = accounts.find((entry) => entry.userId === userId);
      return account ? { userId, email: account.email, emailVerifiedAt: verifiedAt.get(userId) ?? null } : null;
    },
    async issueIdentityToken({ userId, purpose, email, tokenHash, expiresAt }) {
      if (!accounts.some((entry) => entry.userId === userId && entry.email === email)) return false;
      for (const [hash, token] of tokens) if (token.userId === userId && token.purpose === purpose) tokens.delete(hash);
      tokens.set(tokenHash, { userId, purpose, email, expiresAt, consumedAt: null });
      return true;
    },
    async consumeIdentityToken({ tokenHash, purpose }) {
      const token = tokens.get(tokenHash);
      if (!token || token.purpose !== purpose || token.consumedAt) return null;
      if (new Date(token.expiresAt).getTime() <= Date.now()) return null;
      token.consumedAt = new Date().toISOString();
      return { userId: token.userId, email: token.email };
    },
    async findIdentityCredentials({ userId }) {
      if (!passwords.has(userId)) return null;
      return { userId, passwordHash: passwords.get(userId) };
    },
    async setIdentityEmail({ userId, email, proof = undefined }) {
      proofs.push({ operation: "email", proof });
      duringEmailChange?.();
      duringEmailChange = null;
      if (!passwords.has(userId)) return false;
      const current = accounts.find((entry) => entry.userId === userId);
      if (proof && (!current || current.email !== proof.email || passwords.get(userId) !== proof.passwordHash)) return false;
      // Same rule as the real adapters: the address is unique, so a second
      // account cannot be moved onto one that is already taken.
      if (accounts.some((entry) => entry.userId !== userId && entry.email === email)) return false;
      accounts.find((entry) => entry.userId === userId).email = email;
      verifiedAt.delete(userId);
      for (const [hash, token] of tokens) if (token.userId === userId) tokens.delete(hash);
      return true;
    },
    async listIdentitySessions({ userId, limit }) {
      const live = sessions.get(userId) ?? [];
      return live.slice(0, limit).map((sessionId) => ({
        sessionId,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastUsedAt: used.get(sessionId) ?? null,
        expiresAt: "2026-01-08T00:00:00.000Z",
      }));
    },
    async revokeIdentitySession({ userId, sessionId }) {
      const live = sessions.get(userId) ?? [];
      const index = live.indexOf(sessionId);
      if (index === -1) return false;
      live.splice(index, 1);
      ended.push(sessionId);
      return true;
    },
    async revokeIdentitySessions({ userId, exceptSessionId = null }) {
      const live = sessions.get(userId) ?? [];
      const doomed = live.filter((id) => id !== exceptSessionId);
      for (const sessionId of doomed) live.splice(live.indexOf(sessionId), 1);
      ended.push(...doomed);
      return doomed.length;
    },
    /**
     * One call, in the order the real adapters use: the sessions go first, so a
     * failure anywhere leaves the old credential in place. There is no separate
     * setter to fall back on, which is the whole reason the service cannot be
     * left half-done by this call failing.
     */
    async replaceIdentityPassword({ userId, passwordHash, exceptSessionId = null, consumedTokenHash = undefined, proof = undefined }) {
      replacements.push({ userId, exceptSessionId });
      proofs.push({ operation: "password", proof });
      duringReplace?.();
      duringReplace = null;
      if (refuseReplacement) throw new Error("the store refused the replacement");
      // Same rule as the real adapters: the state verified before the KDF has
      // to still be the state on file when the write runs.
      const account = accounts.find((entry) => entry.userId === userId);
      if (proof && (!account || account.email !== proof.email || passwords.get(userId) !== proof.passwordHash)) {
        return { updated: false, revokedSessions: 0 };
      }
      if (consumedTokenHash !== undefined) {
        const token = tokens.get(consumedTokenHash);
        if (!token || token.userId !== userId || token.purpose !== "password_reset" || !token.consumedAt ||
          !accounts.some((account) => account.userId === userId && account.email === token.email)) {
          return { updated: false, revokedSessions: 0 };
        }
      }
      if (!passwords.has(userId)) return { updated: false, revokedSessions: 0 };
      const live = sessions.get(userId) ?? [];
      const doomed = live.filter((id) => id !== exceptSessionId);
      for (const sessionId of doomed) live.splice(live.indexOf(sessionId), 1);
      revoked.push(userId);
      revocations.push({ userId, exceptSessionId });
      passwords.set(userId, passwordHash);
      return { updated: true, revokedSessions: doomed.length };
    },
    async markIdentityEmailVerified({ userId, verifiedAt: at, consumedTokenHash = undefined }) {
      if (consumedTokenHash !== undefined) {
        const token = tokens.get(consumedTokenHash);
        if (!token || token.userId !== userId || token.purpose !== "email_verification" || !token.consumedAt ||
          !accounts.some((account) => account.userId === userId && account.email === token.email)) return false;
      }
      if (!passwords.has(userId)) return false;
      verifiedAt.set(userId, at);
      return true;
    },
    async consumeRateLimit({ limit }) {
      limits?.push(limit);
      return { allowed: true, resetAt: new Date(Date.now() + 60_000).toISOString() };
    },
    async pruneExpiredIdentityState() { return true; },
  };
  return store;
}

function capturingMailer() {
  const sent: Array<{ to: string; purpose: string; subject: string; text: string; link: string }> = [];
  return { sent, mailer: { async send(message) { sent.push(message); } } };
}

const resetToken = (store: ReturnType<typeof fakeIdentityStore>, index = 0) => Array.from(store.tokens.keys())[index];

test("a recovery request answers identically whether or not the address has an account", async () => {
  const known = fakeIdentityStore({ accounts: [{ userId: "user-1", email: "owner@example.test", passwordHash: "hash-1" }] });
  const knownMail = capturingMailer();
  const service = createIdentityService({ env: identityEnv, store: known, mailer: knownMail.mailer });
  const answer = await service.requestPasswordReset({ email: "Owner@Example.test" }, "192.0.2.10");
  assert.deepEqual(answer, { ok: true });
  assert.equal(knownMail.sent.length, 1);
  assert.equal(knownMail.sent[0].to, "owner@example.test");

  const unknown = fakeIdentityStore();
  const unknownMail = capturingMailer();
  const other = createIdentityService({ env: identityEnv, store: unknown, mailer: unknownMail.mailer });
  assert.deepEqual(await other.requestPasswordReset({ email: "nobody@example.test" }, "192.0.2.10"), { ok: true });
  assert.equal(unknownMail.sent.length, 0, "no account means no mail, and the response says nothing about it");
  assert.equal(unknown.tokens.size, 0);
});

test("a recovery token is stored only as a digest, works once, and signs every device out", async () => {
  const store = fakeIdentityStore({ accounts: [{ userId: "user-1", email: "owner@example.test", passwordHash: "hash-1" }] });
  const mail = capturingMailer();
  const service = createIdentityService({ env: identityEnv, store, mailer: mail.mailer });
  await service.requestPasswordReset({ email: "owner@example.test" }, "192.0.2.10");

  const link = mail.sent[0].link;
  const token = decodeURIComponent(new URL(link).searchParams.get("token") ?? "");
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!Array.from(store.tokens.keys()).includes(token), "the raw token must never reach the database");
  assert.ok(Array.from(store.tokens.keys()).every((hash) => /^[0-9a-f]{64}$/.test(hash)));

  assert.deepEqual(await service.resetPassword({ token, password: "a-brand-new-password" }, "192.0.2.10"), { ok: true });
  assert.notEqual(store.passwords.get("user-1"), "hash-1");
  assert.deepEqual(store.revoked, ["user-1"], "a password change must end the sessions that were already signed in");

  await assert.rejects(service.resetPassword({ token, password: "a-brand-new-password" }, "192.0.2.10"), IdentityAuthenticationError);
});

test("an expired or wrong-purpose recovery token is not a password change", async () => {
  const store = fakeIdentityStore({ accounts: [{ userId: "user-1", email: "owner@example.test", passwordHash: "hash-1" }] });
  const service = createIdentityService({ env: identityEnv, store, mailer: capturingMailer().mailer });
  await service.requestPasswordReset({ email: "owner@example.test" }, "192.0.2.10");
  const [hash] = Array.from(store.tokens.keys());
  store.tokens.get(hash).expiresAt = new Date(Date.now() - 1000).toISOString();
  await assert.rejects(
    service.resetPassword({ token: "A".repeat(43) + "", password: "a-brand-new-password" }, "192.0.2.10"),
    IdentityAuthenticationError,
  );
  assert.equal(store.passwords.get("user-1"), "hash-1");
});

/**
 * Changing the password from inside a session.
 *
 * This is the one password transition that does not arrive by mail, so it is
 * the only one that works while mail is switched off — and the only one where
 * somebody has already proved who they are. Two properties follow and are what
 * these tests pin down: the old credential is still required, so a stolen
 * session alone is worth nothing here, and the session that proved it stays
 * signed in instead of being thrown out by its own request.
 */
async function changePasswordFixture() {
  const currentPassword = "the-current-password";
  const passwordHash = await hashPassword(currentPassword);
  const store = fakeIdentityStore({ accounts: [{ userId: "user-1", email: "owner@example.test", passwordHash }] });
  const service = createIdentityService({ env: identityEnv, store, mailer: capturingMailer().mailer });
  return { store, service, currentPassword, passwordHash };
}

test("a signed-in password change needs the old password and spares the session that made it", async () => {
  const { store, service, currentPassword, passwordHash } = await changePasswordFixture();
  assert.deepEqual(await service.changePassword({
    userId: "user-1",
    sessionId: "session-1",
    body: { currentPassword, newPassword: "a-brand-new-password" },
    ip: "192.0.2.10",
  }), { ok: true, revokedSessions: 1 });

  const stored = store.passwords.get("user-1") ?? null;
  assert.notEqual(stored, passwordHash, "the stored credential is replaced");
  assert.ok(await verifyPassword("a-brand-new-password", stored));
  assert.equal(await verifyPassword(currentPassword, stored), false, "the old password no longer opens the account");
  // A reset signs out everything; a change spares the device that proved it.
  assert.deepEqual(store.revocations, [{ userId: "user-1", exceptSessionId: "session-1" }]);
});

/**
 * Multi-device management.
 *
 * The properties the transport cannot check for itself: the device list marks
 * the session that asked and nothing else, a device that is not this account's
 * is not found (so the endpoint cannot be used to probe for one), and "end the
 * others" spares the one that asked — or, when the token cannot name its
 * session, spares nothing and says so.
 */
test("the device list marks the session that asked, and only that one", async () => {
  const store = fakeIdentityStore({ accounts: [{ userId: "user-1", email: "owner@example.test", passwordHash: "hash-1" }] });
  const service = createIdentityService({ env: identityEnv, store, mailer: capturingMailer().mailer });
  const listed = await service.listSessions({ userId: "user-1", sessionId: "session-2", ip: "192.0.2.10" });
  assert.deepEqual(listed.sessions.map((session) => session.sessionId), ["session-1", "session-2"]);
  assert.deepEqual(listed.sessions.map((session) => session.current), [false, true]);

  // A token too old to carry a session id spares nothing rather than guessing.
  const anonymous = await service.listSessions({ userId: "user-1", sessionId: null, ip: "192.0.2.10" });
  assert.deepEqual(anonymous.sessions.map((session) => session.current), [false, false],
    "an unknown session is not claimed to be the device in the reader's hands");
});

test("ending a device that is not this account's is not found, and no device is ended", async () => {
  const store = fakeIdentityStore({ accounts: [{ userId: "user-1", email: "owner@example.test", passwordHash: "hash-1" }] });
  const service = createIdentityService({ env: identityEnv, store, mailer: capturingMailer().mailer });
  await assert.rejects(service.endSession({ userId: "user-1", sessionId: "session-9", ip: "192.0.2.10" }),
    IdentitySessionNotFoundError);
  assert.deepEqual(store.ended, [], "a session that is not this account's ends nothing");
  await assert.rejects(service.endSession({ userId: "user-1", sessionId: "   ", ip: "192.0.2.10" }),
    IdentitySessionNotFoundError, "and an empty id is never a session");

  assert.deepEqual(await service.endSession({ userId: "user-1", sessionId: "session-1", ip: "192.0.2.10" }), { ok: true });
  assert.deepEqual(store.ended, ["session-1"]);
});

test("ending every other device spares the one that asked", async () => {
  const store = fakeIdentityStore({ accounts: [{ userId: "user-1", email: "owner@example.test", passwordHash: "hash-1" }] });
  const service = createIdentityService({ env: identityEnv, store, mailer: capturingMailer().mailer });
  assert.deepEqual(await service.endOtherSessions({ userId: "user-1", sessionId: "session-1", ip: "192.0.2.10" }),
    { ok: true, revokedSessions: 1 });
  assert.deepEqual(store.ended, ["session-2"]);

  // A token that cannot name its session spares nothing: the safe direction.
  assert.deepEqual(await service.endOtherSessions({ userId: "user-1", sessionId: null, ip: "192.0.2.10" }),
    { ok: true, revokedSessions: 1 });
  assert.deepEqual(store.ended, ["session-2", "session-1"]);
});

test("looking at devices is throttled per account, then per address", async () => {
  const limits: number[] = [];
  const store = fakeIdentityStore({ accounts: [{ userId: "user-1", email: "owner@example.test", passwordHash: "hash-1" }], limits });
  const service = createIdentityService({ env: identityEnv, store, mailer: capturingMailer().mailer });
  await service.listSessions({ userId: "user-1", sessionId: "session-1", ip: "192.0.2.10" });
  assert.deepEqual(limits, [30, 120], "thirty per quarter hour for one account, a hundred and twenty for one address");
});

test("a password change that the store cannot carry out is reported, not half applied", async () => {
  const { store, service, currentPassword, passwordHash } = await changePasswordFixture();
  store.refuseReplacement = true;
  await assert.rejects(service.changePassword({
    userId: "user-1",
    sessionId: "session-1",
    body: { currentPassword, newPassword: "a-brand-new-password" },
    ip: "192.0.2.10",
  }), /the store refused the replacement/);

  // The service gets one chance and no fallback: the credential and the
  // revocation travel in the same call, so a failure cannot leave the account
  // with the new password and the old sessions still signed in.
  assert.deepEqual(store.replacements, [{ userId: "user-1", exceptSessionId: "session-1" }],
    "the session to spare is named in the same call that replaces the credential");
  assert.equal(store.passwords.get("user-1"), passwordHash, "and the old credential is what is still on file");
});

test("a password change that began before a reset cannot overwrite it", async () => {
  const { store, service, currentPassword, passwordHash } = await changePasswordFixture();
  // The reset commits while this change is hashing the new password: the old
  // credential still verifies, and only the write can notice the difference.
  const resetHash = await hashPassword("the-password-the-owner-reset-to");
  store.duringReplace = () => { store.passwords.set("user-1", resetHash); };
  await assert.rejects(service.changePassword({
    userId: "user-1",
    sessionId: "session-1",
    body: { currentPassword, newPassword: "a-brand-new-password" },
    ip: "192.0.2.10",
  }), IdentityAuthenticationError);
  assert.equal(store.passwords.get("user-1"), resetHash, "the owner's reset is what stays on file");
  assert.ok(await verifyPassword("the-password-the-owner-reset-to", store.passwords.get("user-1") ?? null));
  assert.equal(await verifyPassword("a-brand-new-password", store.passwords.get("user-1") ?? null), false);
  assert.deepEqual(store.revocations, [], "the refused change signs nobody out");
  assert.deepEqual(store.proofs, [{ operation: "password", proof: { email: "owner@example.test", passwordHash } }],
    "the store is given exactly the state the service verified");
});

test("a wrong current password changes nothing and signs nobody out", async () => {
  const { store, service, currentPassword, passwordHash } = await changePasswordFixture();
  await assert.rejects(service.changePassword({
    userId: "user-1",
    sessionId: "session-1",
    body: { currentPassword: "not-the-password", newPassword: "a-brand-new-password" },
    ip: "192.0.2.10",
  }), IdentityAuthenticationError);
  assert.equal(store.passwords.get("user-1"), passwordHash);
  assert.deepEqual(store.revocations, [], "a failed change must not end a session");

  // A session for an account that no longer exists fails identically: the
  // answer is the same, and so is the work done to produce it.
  await assert.rejects(service.changePassword({
    userId: "nobody",
    sessionId: "session-x",
    body: { currentPassword, newPassword: "a-brand-new-password" },
    ip: "192.0.2.10",
  }), IdentityAuthenticationError);
});

test("the new password is held to the rules a new credential is held to, and the body is exactly two fields", async () => {
  const { store, service, currentPassword, passwordHash } = await changePasswordFixture();
  // Eleven characters is enough to log in and not enough to become the
  // credential the account is protected by.
  await assert.rejects(service.changePassword({
    userId: "user-1",
    sessionId: "session-1",
    body: { currentPassword, newPassword: "short-one-1" },
    ip: "192.0.2.10",
  }), IdentityInputError);
  // An extra field is refused outright rather than ignored: this body names
  // the account by session, so anything else in it is a caller's mistake.
  await assert.rejects(service.changePassword({
    userId: "user-1",
    sessionId: "session-1",
    body: { currentPassword, newPassword: "a-brand-new-password", email: "attacker@example.test" },
    ip: "192.0.2.10",
  }), IdentityInputError);
  assert.equal(store.passwords.get("user-1"), passwordHash);
  assert.deepEqual(store.revocations, []);
});

test("a signed-in password change is throttled per account, then per address", async () => {
  const currentPassword = "the-current-password";
  const limits: number[] = [];
  const store = fakeIdentityStore({
    accounts: [{ userId: "user-1", email: "owner@example.test", passwordHash: await hashPassword(currentPassword) }],
    limits,
  });
  const service = createIdentityService({ env: identityEnv, store, mailer: capturingMailer().mailer });
  await service.changePassword({
    userId: "user-1",
    sessionId: "session-1",
    body: { currentPassword, newPassword: "a-brand-new-password" },
    ip: "192.0.2.10",
  });
  assert.deepEqual(limits, [5, 20], "five per quarter hour for one account, twenty for one address");
});

/**
 * Changing the address while signed in.
 *
 * The address is where recovery lands, so this is the one account change that
 * needs the current password even more than changing the password does: a
 * stolen session that could move the address could then take the account over
 * through the mailbox. What it must *not* do is gate on verification or send a
 * mail — on an instance where mail is off, that would make the change
 * impossible rather than merely unverified.
 */
async function changeEmailFixture(secondEmail = "second-owner@example.test") {
  const currentPassword = "the-current-password";
  const store = fakeIdentityStore({
    accounts: [
      { userId: "user-1", email: "owner@example.test", passwordHash: await hashPassword(currentPassword) },
      ...(secondEmail ? [{ userId: "user-2", email: secondEmail, passwordHash: "hash-2" }] : []),
    ],
  });
  const service = createIdentityService({ env: identityEnv, store, mailer: capturingMailer().mailer });
  return { store, service, currentPassword, secondEmail };
}

test("changing the address needs the current password, and leaves the account unverified", async () => {
  const { store, service, currentPassword } = await changeEmailFixture();
  // The account has a proof on file — for the address it is about to leave.
  await store.markIdentityEmailVerified({ userId: "user-1", verifiedAt: new Date().toISOString() });
  assert.ok((await service.describeAccount("user-1")).emailVerifiedAt);

  assert.deepEqual(await service.changeEmail({
    userId: "user-1",
    body: { password: currentPassword, email: "New.Owner@Example.test" },
    ip: "192.0.2.10",
  }), { ok: true, email: "new.owner@example.test", emailVerifiedAt: null });

  const account = await service.describeAccount("user-1");
  assert.equal(account.email, "new.owner@example.test", "the address is normalised and stored");
  assert.equal(account.emailVerifiedAt, null, "proof of the old address is not proof of the new one");
  assert.deepEqual(store.revocations, [], "changing an address is not replacing a credential");
});

test("a wrong password leaves the address alone, and an address that is taken is a conflict", async () => {
  const { store, service, currentPassword, secondEmail } = await changeEmailFixture();
  await assert.rejects(service.changeEmail({
    userId: "user-1",
    body: { password: "not-the-password", email: "moved@example.test" },
    ip: "192.0.2.10",
  }), IdentityAuthenticationError);
  assert.equal((await service.describeAccount("user-1")).email, "owner@example.test");

  await assert.rejects(service.changeEmail({
    userId: "user-1",
    body: { password: currentPassword, email: secondEmail },
    ip: "192.0.2.10",
  }), IdentityConflictError, "one address cannot belong to two accounts");
  assert.equal((await service.describeAccount("user-1")).email, "owner@example.test");

  // The body is exactly two fields: nothing else travels with the address.
  await assert.rejects(service.changeEmail({
    userId: "user-1",
    body: { password: currentPassword, email: "moved@example.test", userId: "user-2" },
    ip: "192.0.2.10",
  }), IdentityInputError);
  await assert.rejects(service.changeEmail({
    userId: "user-1",
    body: { password: currentPassword, email: "not-an-address" },
    ip: "192.0.2.10",
  }), IdentityInputError);
  assert.deepEqual(store.revocations, []);
});

test("an address change that began before a reset cannot move the account", async () => {
  const { store, service, currentPassword } = await changeEmailFixture();
  const resetHash = await hashPassword("the-password-the-owner-reset-to");
  store.duringEmailChange = () => { store.passwords.set("user-1", resetHash); };
  await assert.rejects(service.changeEmail({
    userId: "user-1",
    body: { password: currentPassword, email: "moved@example.test" },
    ip: "192.0.2.10",
  }), IdentityAuthenticationError, "a stale proof asks the visitor to sign in again, it does not claim a conflict");
  assert.equal((await service.describeAccount("user-1")).email, "owner@example.test",
    "the address does not move after the credential it was proved with has been replaced");
});

test("an address change cannot overwrite an address the account moved to meanwhile", async () => {
  const { store, service, currentPassword } = await changeEmailFixture();
  // Another tab of the same owner moved the account while this request was
  // hashing the password: the proof names the address the account had then.
  store.duringEmailChange = () => { store.accounts.find((entry) => entry.userId === "user-1").email = "owner-moved@example.test"; };
  await assert.rejects(service.changeEmail({
    userId: "user-1",
    body: { password: currentPassword, email: "moved@example.test" },
    ip: "192.0.2.10",
  }), IdentityAuthenticationError);
  assert.equal((await service.describeAccount("user-1")).email, "owner-moved@example.test");
});

test("an address change is only ever made with the state it verified", async () => {
  const { store, service, currentPassword, secondEmail } = await changeEmailFixture();
  await assert.rejects(service.changeEmail({
    userId: "user-1",
    body: { password: currentPassword, email: secondEmail },
    ip: "192.0.2.10",
  }), IdentityConflictError);
  assert.equal(store.proofs.at(-1)?.operation, "email");
  assert.deepEqual(store.proofs.at(-1)?.proof, {
    email: "owner@example.test", passwordHash: store.passwords.get("user-1"),
  }, "the refusal re-reads the account before calling it a conflict, and the proof is what it verified");
});

test("asking for the address the account already has is not a change, and keeps its proof", async () => {
  const { store, service, currentPassword } = await changeEmailFixture();
  const verifiedAt = new Date().toISOString();
  await store.markIdentityEmailVerified({ userId: "user-1", verifiedAt });
  assert.deepEqual(await service.changeEmail({
    userId: "user-1",
    body: { password: currentPassword, email: "Owner@Example.test" },
    ip: "192.0.2.10",
  }), { ok: true, email: "owner@example.test", emailVerifiedAt: verifiedAt });
});

test("changing the address is throttled per account, then per address", async () => {
  const currentPassword = "the-current-password";
  const limits: number[] = [];
  const store = fakeIdentityStore({
    accounts: [{ userId: "user-1", email: "owner@example.test", passwordHash: await hashPassword(currentPassword) }],
    limits,
  });
  const service = createIdentityService({ env: identityEnv, store, mailer: capturingMailer().mailer });
  await service.changeEmail({
    userId: "user-1",
    body: { password: currentPassword, email: "moved@example.test" },
    ip: "192.0.2.10",
  });
  assert.deepEqual(limits, [5, 20], "five per hour for one account, twenty for one peer address");
});

test("verification is sent to the signed-in account's own address and stamped once", async () => {
  const store = fakeIdentityStore({ accounts: [{ userId: "user-1", email: "owner@example.test", passwordHash: "hash-1" }] });
  const mail = capturingMailer();
  const service = createIdentityService({ env: identityEnv, store, mailer: mail.mailer });

  const requested = await service.requestEmailVerification("user-1", "192.0.2.10");
  assert.deepEqual(requested, { ok: true, alreadyVerified: false });
  assert.equal(mail.sent[0].to, "owner@example.test");
  assert.equal(mail.sent[0].purpose, "email_verification");

  const token = decodeURIComponent(new URL(mail.sent[0].link).searchParams.get("token") ?? "");
  assert.deepEqual(await service.verifyEmail({ token }, "192.0.2.10"), { ok: true });
  assert.ok((await service.describeAccount("user-1")).emailVerifiedAt);

  await assert.rejects(service.verifyEmail({ token }, "192.0.2.10"), IdentityAuthenticationError, "the link works once");

  const again = await service.requestEmailVerification("user-1", "192.0.2.10");
  assert.deepEqual(again, { ok: true, alreadyVerified: true });
  assert.equal(mail.sent.length, 1, "an already verified address is not mailed again");

  await assert.rejects(service.requestEmailVerification("nobody", "192.0.2.10"), IdentityAuthenticationError);
});

test("the account holder can read their own address and verification state", async () => {
  const store = fakeIdentityStore({ accounts: [{ userId: "user-1", email: "owner@example.test", passwordHash: "hash-1" }] });
  const service = createIdentityService({ env: identityEnv, store, mailer: capturingMailer().mailer });
  assert.deepEqual(await service.describeAccount("user-1"), { id: "user-1", email: "owner@example.test", emailVerifiedAt: null });
  assert.deepEqual(await service.describeAccount("external-user"), { id: "external-user", email: null, emailVerifiedAt: null });
});

test("the recovery link is not written to the log unless an operator opts in", async () => {
  for (const [env, expectLink] of [[{}, false], [{ AUTH_IDENTITY_MAIL_LOG_LINK: "1" }, true]] as const) {
    const lines: string[] = [];
    const store = fakeIdentityStore({ accounts: [{ userId: "user-1", email: "owner@example.test", passwordHash: "hash-1" }] });
    const service = createIdentityService({
      env: { ...identityEnv, ...env },
      store,
      mailer: createLogMailer({ env: { ...identityEnv, ...env }, log: (line) => lines.push(line) }),
    });
    await service.requestPasswordReset({ email: "owner@example.test" }, "192.0.2.10");
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.event, "identity_mail");
    assert.equal(entry.link === null, !expectLink, `link in the log with ${JSON.stringify(env)}`);
  }
});
test("an undeliverable mail is recorded, and the caller is told nothing about it", async () => {
  const store = fakeIdentityStore({ accounts: [{ userId: "user-1", email: "owner@example.test", passwordHash: "hash-1" }] });
  const observations: Array<{ purpose: string; outcome: string; code?: string; message?: string }> = [];
  const service = createIdentityService({
    env: identityEnv,
    store,
    mailer: { async send() { throw new SmtpError("CONNECT", "connect ECONNREFUSED relay.test:587"); } },
    onMailDelivery: (sample) => { observations.push(sample); },
  });

  assert.deepEqual(
    await service.requestPasswordReset({ email: "owner@example.test" }, "192.0.2.10"),
    { ok: true },
    "a broken relay must not look like a failed recovery request",
  );
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.purpose, "password_reset");
  assert.equal(observations[0]?.outcome, "failed");
  assert.equal(observations[0]?.code, "CONNECT");
  assert.equal(String(observations[0]?.message).includes("owner@example.test"), false, "the observation carries no address");
  assert.ok(store.tokens.size > 0, "the token is stored either way, so the user can ask for a new link");
});

test("a delivered mail is recorded as sent", async () => {
  const store = fakeIdentityStore({ accounts: [{ userId: "user-1", email: "owner@example.test", passwordHash: "hash-1" }] });
  const observations: Array<{ purpose: string; outcome: string }> = [];
  const service = createIdentityService({
    env: identityEnv,
    store,
    mailer: capturingMailer().mailer,
    onMailDelivery: (sample) => { observations.push(sample); },
  });

  await service.requestEmailVerification("user-1", "192.0.2.10");
  assert.deepEqual(observations, [{ purpose: "email_verification", outcome: "sent", durationMs: observations[0]?.durationMs }]);
  assert.ok(typeof observations[0]?.durationMs === "number");
});

/**
 * The mail switch.
 *
 * Off by default, because a site that has not chosen a relay should not behave
 * as though it can reach its readers' inboxes. What matters here is what "off"
 * does **not** do: it does not issue a token nobody can redeem, and it does not
 * answer 202 as though a mail were on its way.
 */
test("a recovery request while mail is off is refused, and no token is issued", async () => {
  const store = fakeIdentityStore({ accounts: [{ userId: "user-1", email: "owner@example.test", passwordHash: "hash-1" }] });
  const observations: Array<{ purpose: string; outcome: string }> = [];
  const service = createIdentityService({
    env: { ...identityEnv, MAIL_ENABLED: "false" },
    store,
    mailer: capturingMailer().mailer,
    onMailDelivery: (sample) => { observations.push(sample); },
  });

  await assert.rejects(
    service.requestPasswordReset({ email: "owner@example.test" }, "192.0.2.10"),
    (error: unknown) => error instanceof MailDisabledError && error.code === "MAIL_DISABLED",
    "a recovery that cannot be delivered must not look accepted",
  );
  assert.equal(store.tokens.size, 0, "no token is issued for a mail that cannot be sent");
  assert.deepEqual(observations, [{ purpose: "password_reset", outcome: "skipped", durationMs: 0, code: "MAIL_DISABLED" }]);
});

test("a verification request while mail is off is refused the same way", async () => {
  const store = fakeIdentityStore({ accounts: [{ userId: "user-1", email: "owner@example.test", passwordHash: "hash-1" }] });
  const service = createIdentityService({
    env: { ...identityEnv, MAIL_ENABLED: "false" },
    store,
    mailer: capturingMailer().mailer,
  });
  await assert.rejects(service.requestEmailVerification("user-1", "192.0.2.10"), MailDisabledError);
  assert.equal(store.tokens.size, 0);
});

test("mail stays off unless the operator says otherwise", async () => {
  const store = fakeIdentityStore({ accounts: [{ userId: "user-1", email: "owner@example.test", passwordHash: "hash-1" }] });
  // Unset, empty and unrecognised all mean off: a typo must not switch mail on.
  for (const value of [undefined, "", "  ", "false", "0", "no", "off", "TRUEish", "yes please"]) {
    const env = { ...identityEnv };
    if (value === undefined) delete env.MAIL_ENABLED; else env.MAIL_ENABLED = value;
    const service = createIdentityService({ env, store, mailer: capturingMailer().mailer });
    await assert.rejects(
      service.requestEmailVerification("user-1", "192.0.2.10"),
      MailDisabledError,
      `MAIL_ENABLED=${JSON.stringify(value)} must leave mail off`,
    );
  }
  for (const value of ["true", "TRUE", " true ", "1", "yes", "on"]) {
    const service = createIdentityService({
      env: { ...identityEnv, MAIL_ENABLED: value },
      store,
      mailer: capturingMailer().mailer,
    });
    const answer = await service.requestEmailVerification("user-1", "192.0.2.10");
    assert.equal(answer.ok, true, `MAIL_ENABLED=${JSON.stringify(value)} must switch mail on`);
  }
});

test("a configured relay does not switch mail on by itself", async () => {
  const store = fakeIdentityStore({ accounts: [{ userId: "user-1", email: "owner@example.test", passwordHash: "hash-1" }] });
  const configured = {
    ...identityEnv,
    MAIL_ENABLED: undefined,
    MAIL_SMTP_HOST: "relay.example.test",
    MAIL_FROM: "no-reply@example.test",
  };
  const service = createIdentityService({ env: configured, store });
  await assert.rejects(
    service.requestPasswordReset({ email: "owner@example.test" }, "192.0.2.10"),
    MailDisabledError,
    "credentials in the environment are not consent",
  );
  const mail = resolveIdentityMailer(configured);
  await assert.rejects(mail.send({ to: "owner@example.test", purpose: "password_reset", subject: "s", text: "t", link: "https://example.test" }),
    MailDisabledError, "the mailer refuses too, so an unchecked path cannot quietly send");
});

test("a stale-address token issuance does not send an invalid link", async () => {
  const store = fakeIdentityStore({ accounts: [{ userId: "user-1", email: "owner@example.test", passwordHash: "fixture-hash" }] });
  store.issueIdentityToken = async () => false;
  const mail = capturingMailer();
  const service = createIdentityService({ store, env: identityEnv, mailer: mail.mailer });
  assert.deepEqual(await service.requestPasswordReset({ email: "owner@example.test" }, "192.0.2.10"), { ok: true });
  assert.deepEqual(await service.requestEmailVerification("user-1", "192.0.2.10"), { ok: true, alreadyVerified: false });
  assert.equal(mail.sent.length, 0);
});
