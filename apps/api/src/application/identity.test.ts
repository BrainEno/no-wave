import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createIdentityService } from "./identity.ts";
import { createLogMailer, resolveIdentityMailer } from "./identity-mailer.ts";
import { SmtpError } from "../infrastructure/smtp-client.ts";
import { IdentityAuthenticationError, IdentityInputError, MailDisabledError } from "../domain/errors.ts";
import { hashPassword, verifyPassword } from "../security/passwords.ts";

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
  const passwords = new Map<string, string>();
  const verifiedAt = new Map<string, string>();
  const sent: Array<{ to: string; purpose: string; subject: string; link: string }> = [];
  for (const account of accounts) {
    passwords.set(account.userId, account.passwordHash);
    sessions.set(account.userId, ["session-1", "session-2"]);
  }
  const store = {
    sent,
    tokens,
    revoked,
    revocations,
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
    async findIdentityCredentials({ userId }) {
      if (!passwords.has(userId)) return null;
      return { userId, passwordHash: passwords.get(userId) };
    },
    async setIdentityPassword({ userId, passwordHash }) {
      if (!passwords.has(userId)) return false;
      passwords.set(userId, passwordHash);
      return true;
    },
    async revokeIdentitySessions({ userId, exceptSessionId = null }) {
      revoked.push(userId);
      revocations.push({ userId, exceptSessionId });
      return 1;
    },
    async markIdentityEmailVerified({ userId, verifiedAt: at }) {
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
