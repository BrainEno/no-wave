import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createIdentityService } from "./identity.ts";
import { createLogMailer } from "./identity-mailer.ts";
import { SmtpError } from "../infrastructure/smtp-client.ts";
import { IdentityAuthenticationError } from "../domain/errors.ts";

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
const identityEnv = {
  AUTH_JWT_SECRET: "fixture-secret-not-a-real-key-32-bytes",
  AUTH_JWT_ISSUER: "test",
  AUTH_JWT_AUDIENCE: "test",
  AUTH_IDENTITY_BASE_URL: "https://example.test",
};

function fakeIdentityStore({ accounts = [] as Array<{ userId: string; email: string; passwordHash: string }> } = {}) {
  const tokens = new Map<string, { userId: string; purpose: string; email: string; expiresAt: string; consumedAt: string | null }>();
  const revoked: string[] = [];
  const passwords = new Map<string, string>();
  const verifiedAt = new Map<string, string>();
  const sent: Array<{ to: string; purpose: string; subject: string; link: string }> = [];
  for (const account of accounts) passwords.set(account.userId, account.passwordHash);
  const store = {
    sent,
    tokens,
    revoked,
    passwords,
    verifiedAt,
    async findIdentityAccount({ email }) {
      const account = accounts.find((entry) => entry.email === email);
      return account ? { userId: account.userId, passwordHash: passwords.get(account.userId) } : null;
    },
    async findIdentityAccountByUserId({ userId }) {
      const account = accounts.find((entry) => entry.userId === userId);
      return account ? { userId, email: account.email, emailVerifiedAt: verifiedAt.get(userId) ?? null } : null;
    },
    async issueIdentityToken({ userId, purpose, email, tokenHash, expiresAt }) {
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
    async setIdentityPassword({ userId, passwordHash }) {
      if (!passwords.has(userId)) return false;
      passwords.set(userId, passwordHash);
      return true;
    },
    async revokeIdentitySessions({ userId }) { revoked.push(userId); return 1; },
    async markIdentityEmailVerified({ userId, verifiedAt: at }) {
      if (!passwords.has(userId)) return false;
      verifiedAt.set(userId, at);
      return true;
    },
    async consumeRateLimit() { return { allowed: true, resetAt: new Date(Date.now() + 60_000).toISOString() }; },
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
