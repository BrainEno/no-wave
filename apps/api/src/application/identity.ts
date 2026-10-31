import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  IdentityAuthenticationError, IdentityConflictError, IdentityInputError,
  IdentityRateLimitError, IdentityUnavailableError, MailDisabledError,
} from "../domain/errors.ts";
import { accessIssuerConfiguration, signAccessToken } from "../security/authentication.ts";
import { hashPassword, verifyPassword } from "../security/passwords.ts";
import {
  identityLink, isMailEnabled, resolveIdentityMailer,
  type IdentityMailer, type IdentityTokenPurpose,
} from "./identity-mailer.ts";

const REFRESH_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const WINDOW_SECONDS = 15 * 60;
/** Registration is throttled over a longer window than login: it creates rows. */
const REGISTER_WINDOW_SECONDS = 60 * 60;
/**
 * How long a recovery or verification token stays usable.
 *
 * A reset link is a credential that arrives by mail and sits in an inbox
 * nobody watches: thirty minutes is short enough that a forwarded or leaked
 * mailbox is not a standing key to the account. Verification is not a
 * credential — it only proves the address was reachable — so a day is enough
 * to survive an inbox that delivers slowly.
 */
const RESET_TOKEN_LIFETIME_SECONDS = 30 * 60;
const VERIFICATION_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;

/**
 * How many accounts one address may create in that window.
 *
 * Registration is the only unauthenticated write that creates rows, and behind
 * the Web proxy every browser shares an address, so the default is deliberately
 * tight. It is configurable because the right number belongs to whoever runs
 * the instance: readers behind one NAT legitimately share an address, and a
 * browser suite that registers one account per journey must not run at one
 * hundred per cent of a budget it cannot see — which is exactly what happened
 * when a journey needed two accounts in it. Only the operator can widen the
 * limit, and a value that does not parse, or that would switch the throttle
 * off, falls back to the default rather than leaving registration open.
 */
const DEFAULT_REGISTER_IP_LIMIT = 20;

/**
 * Refuse a request whose whole purpose is to put mail in an inbox, while mail is
 * switched off.
 *
 * Before any rate limit is spent and before any token is issued: issuing a
 * reset token nobody can receive would be worse than refusing, because the
 * account would look recoverable. The observation is recorded as `skipped`, not
 * `failed` — nothing failed, the feature simply is not on — so an operator can
 * see that visitors are asking for something this instance cannot do.
 *
 * The refusal is a 409 `MAIL_DISABLED`: not an outage, and not something
 * retrying will fix.
 */
function requireMail(env: NodeJS.ProcessEnv, purpose: IdentityTokenPurpose, onMailDelivery: MailDeliveryObserver | null): void {
  if (isMailEnabled(env)) return;
  onMailDelivery?.({ purpose, outcome: "skipped", durationMs: 0, code: "MAIL_DISABLED" });
  throw new MailDisabledError();
}

/** One mail delivery, sent or skipped, as the observability layer sees it. */
type MailDeliverySample = { purpose: string; outcome: string; durationMs: number; code?: string; message?: string };
type MailDeliveryObserver = (sample: MailDeliverySample) => void;

function registerIpLimit(env: NodeJS.ProcessEnv): number {
  const raw = env.AUTH_REGISTER_IP_LIMIT;
  if (typeof raw !== "string" || raw.trim() === "") return DEFAULT_REGISTER_IP_LIMIT;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_REGISTER_IP_LIMIT;
}

type IdentitySession = {
  sessionId: string; userId: string; accessTokenId: string; refreshHash: string;
  expiresAt: string; accessExpiresAt: string;
};
type Rotation = { status: "invalid" | "reused" } | {
  status: "rotated"; userId: string; accessExpiresAt: string; refreshExpiresAt: string;
};
export type IdentityStore = {
  createIdentityAccount(input: { userId: string; email: string; passwordHash: string; session: IdentitySession }): Promise<boolean>;
  findIdentityAccount(input: { email: string }): Promise<{ userId: string; passwordHash: string } | null>;
  createIdentitySession(session: IdentitySession): Promise<unknown>;
  rotateIdentityRefresh(input: { refreshHash: string; nextRefreshHash: string; accessTokenId: string; issuedAt: string; accessExpiresAt: string }): Promise<Rotation>;
  revokeIdentityRefresh(input: { refreshHash: string }): Promise<unknown>;
  consumeRateLimit(input: { key: string; limit: number; windowSeconds: number }): Promise<{ allowed: boolean; resetAt: string }>;
  issueIdentityToken(input: { userId: string; purpose: IdentityTokenPurpose; email: string; tokenHash: string; expiresAt: string }): Promise<unknown>;
  consumeIdentityToken(input: { tokenHash: string; purpose: IdentityTokenPurpose }): Promise<{ userId: string; email: string } | null>;
  setIdentityPassword(input: { userId: string; passwordHash: string }): Promise<boolean>;
  /**
   * Move an account to another address, and drop its proof of the old one.
   *
   * `false` means the address belongs to somebody else — the unique index is
   * the arbiter, so two callers racing for one address cannot both win. The
   * address is normalised and the account is known to exist before this is
   * called, so `false` has only that one meaning.
   */
  setIdentityEmail(input: { userId: string; email: string }): Promise<boolean>;
  /** The credential of one account, and nothing else about it. */
  findIdentityCredentials(input: { userId: string }): Promise<{ userId: string; passwordHash: string } | null>;
  /**
   * Revoke every live session of one user, optionally sparing one.
   *
   * `exceptSessionId` exists because "the password changed" has two shapes: a
   * reset has no device that proved anything, so all of them go; a change made
   * from inside a session keeps the one that proved it knew the old password.
   */
  revokeIdentitySessions(input: { userId: string; exceptSessionId?: string }): Promise<number>;
  markIdentityEmailVerified(input: { userId: string; verifiedAt: string }): Promise<boolean>;
  findIdentityAccountByUserId(input: { userId: string }): Promise<{ userId: string; email: string; emailVerifiedAt: string | null } | null>;
  pruneExpiredIdentityState(): Promise<unknown>;
};

function configuration(env: NodeJS.ProcessEnv): ReturnType<typeof accessIssuerConfiguration> {
  try { return accessIssuerConfiguration(env); }
  catch { throw new IdentityUnavailableError(); }
}
function requireOnly(body: Record<string, unknown>, fields: readonly string[]): void {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !fields.includes(key))) {
    throw new IdentityInputError();
  }
}
function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") throw new IdentityInputError();
  const email = value.trim().toLowerCase();
  if (email.length > 254) throw new IdentityInputError();
  const parts = email.split("@");
  if (parts.length !== 2) throw new IdentityInputError();
  const [local, domain] = parts;
  const labels = domain.split(".");
  if (local.length < 1 || local.length > 64 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) ||
      local.startsWith(".") || local.endsWith(".") || local.includes("..") || labels.length < 2 ||
      labels.some((label) => label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new IdentityInputError();
  }
  return email;
}
function passwordInput(value: unknown, registration: boolean): string {
  if (typeof value !== "string") throw new IdentityInputError();
  const length = Array.from(value).length;
  if (length < (registration ? 12 : 1) || length > 128 || Buffer.byteLength(value, "utf8") > 512) throw new IdentityInputError();
  return value;
}
function tokenInput(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new IdentityInputError();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== value) throw new IdentityInputError();
  return value;
}
function refreshHash(token: string): string { return createHash("sha256").update(token, "utf8").digest("hex"); }
/** Same shape as a refresh credential, so `tokenInput` accepts it unchanged. */
function randomToken(): string { return randomBytes(32).toString("base64url"); }
function tokenHash(token: string): string { return createHash("sha256").update(token, "utf8").digest("hex"); }
function randomRefresh(): string { return randomBytes(32).toString("base64url"); }
function rateKey(secret: string, scope: string, subject: string): string {
  // Domain-separate throttle identifiers from JWT signatures even though both
  // are rooted in the server-only authentication secret.
  const key = createHmac("sha256", secret).update("bot-thk:identity-rate-limit:v1").digest();
  return createHmac("sha256", key).update(JSON.stringify([scope, subject])).digest("hex");
}
function timestamp(seconds: number): string { return new Date(seconds * 1000).toISOString(); }

/** Transport-independent registration, login, rotation and logout use cases. */
export function createIdentityService({ store, env, mailer = null, onMailDelivery = null }: {
  store: IdentityStore;
  env: NodeJS.ProcessEnv;
  mailer?: IdentityMailer | null;
  onMailDelivery?: MailDeliveryObserver | null;
}) {
  const delivery: IdentityMailer | null = mailer ?? resolveIdentityMailer(env);
  let rateOperations = 0;
  async function consume(scope: string, subject: string, limit: number, windowSeconds: number, secret: string): Promise<void> {
    // Opportunistic bounded cleanup; no detached work can outlive the request.
    rateOperations += 1;
    if (rateOperations >= 128) {
      rateOperations = 0;
      await store.pruneExpiredIdentityState();
    }
    const result = await store.consumeRateLimit({ key: rateKey(secret, scope, subject), limit, windowSeconds });
    if (!result.allowed) {
      const wait = Math.ceil((new Date(result.resetAt).getTime() - Date.now()) / 1000);
      throw new IdentityRateLimitError(Number.isFinite(wait) ? Math.max(1, wait) : windowSeconds);
    }
  }
  async function limitPasswordRequest(action: "register" | "login", email: string, ip: string, secret: string): Promise<void> {
    const window = action === "register" ? REGISTER_WINDOW_SECONDS : WINDOW_SECONDS;
    await consume(`${action}:ip`, ip, action === "register" ? registerIpLimit(env) : 60, window, secret);
    await consume(`${action}:email`, email, 5, window, secret);
  }
  async function limitTokenRequest(action: "refresh" | "logout", ip: string, secret: string): Promise<void> {
    await consume(`${action}:ip`, ip, 120, WINDOW_SECONDS, secret);
  }
  /**
   * Hand a message to the mailer, if one is configured.
   *
   * A recovery flow that fails because mail is broken must not look like a
   * failed request to the caller — the token is already stored, and the answer
   * is the same either way. The failure is logged by the observability layer.
   */
  async function deliver({ purpose, to, token, subject, text }: {
    purpose: IdentityTokenPurpose; to: string; token: string; subject: string; text: string;
  }): Promise<void> {
    if (!delivery) return;
    const startedAt = Date.now();
    try {
      await delivery.send({ to, purpose, subject, text, link: identityLink({ env, purpose, token }) });
      onMailDelivery?.({ purpose, outcome: "sent", durationMs: Date.now() - startedAt });
    } catch (error: unknown) {
      // Swallowed as far as the caller is concerned: the account state is
      // already committed, and an undeliverable mail is not a reason to report
      // a failed request. It *is* a reason to record one. Before a relay
      // existed, a swallowed failure cost nothing; with one configured, silence
      // is how recovery breaks for a week without anybody noticing. The address
      // is left out here on purpose — the observer decides what is safe to keep.
      onMailDelivery?.({
        purpose,
        outcome: "failed",
        durationMs: Date.now() - startedAt,
        code: typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "MAIL_FAILED",
        message: error instanceof Error ? error.message : "The mail could not be delivered.",
      });
    }
  }
  function prepareSession(userId: string, config: ReturnType<typeof accessIssuerConfiguration>): { refreshToken: string; issuedAt: number; session: IdentitySession } {
    const issuedAt = Math.floor(Date.now() / 1000);
    const refreshToken = randomRefresh();
    return {
      refreshToken,
      issuedAt,
      session: {
        sessionId: randomUUID(), userId, accessTokenId: randomUUID(), refreshHash: refreshHash(refreshToken),
        expiresAt: timestamp(issuedAt + REFRESH_LIFETIME_SECONDS),
        accessExpiresAt: timestamp(issuedAt + config.ttlSeconds),
      },
    };
  }
  function tokens({ userId, accessTokenId, issuedAt, accessExpiresAt, refreshExpiresAt, refreshToken }: {
    userId: string; accessTokenId: string; issuedAt: number; accessExpiresAt: string; refreshExpiresAt: string; refreshToken: string;
  }) {
    const expiresAt = Math.floor(new Date(accessExpiresAt).getTime() / 1000);
    return {
      accessToken: signAccessToken({ subject: userId, tokenId: accessTokenId, issuedAt, expiresAt, env }),
      tokenType: "Bearer",
      accessExpiresAt: timestamp(expiresAt),
      refreshToken,
      refreshExpiresAt: new Date(refreshExpiresAt).toISOString(),
    };
  }
  return Object.freeze({
    async register(body: Record<string, unknown>, ip: string) {
      requireOnly(body, ["email", "password"]);
      const email = normalizeEmail(body.email);
      const password = passwordInput(body.password, true);
      const config = configuration(env);
      await limitPasswordRequest("register", email, ip, config.secret);
      const passwordHash = await hashPassword(password);
      const userId = randomUUID();
      const prepared = prepareSession(userId, config);
      const response = tokens({ userId, accessTokenId: prepared.session.accessTokenId, issuedAt: prepared.issuedAt,
        accessExpiresAt: prepared.session.accessExpiresAt, refreshExpiresAt: prepared.session.expiresAt, refreshToken: prepared.refreshToken });
      const created = await store.createIdentityAccount({ userId, email, passwordHash, session: prepared.session });
      if (!created) throw new IdentityConflictError();
      return response;
    },
    async login(body: Record<string, unknown>, ip: string) {
      requireOnly(body, ["email", "password"]);
      const email = normalizeEmail(body.email);
      const password = passwordInput(body.password, false);
      const config = configuration(env);
      await limitPasswordRequest("login", email, ip, config.secret);
      const account = await store.findIdentityAccount({ email });
      const valid = await verifyPassword(password, account?.passwordHash ?? null);
      if (!account || !valid) throw new IdentityAuthenticationError();
      const prepared = prepareSession(account.userId, config);
      const response = tokens({ userId: account.userId, accessTokenId: prepared.session.accessTokenId, issuedAt: prepared.issuedAt,
        accessExpiresAt: prepared.session.accessExpiresAt, refreshExpiresAt: prepared.session.expiresAt, refreshToken: prepared.refreshToken });
      await store.createIdentitySession(prepared.session);
      return response;
    },
    async refresh(body: Record<string, unknown>, ip: string) {
      requireOnly(body, ["refreshToken"]);
      const token = tokenInput(body.refreshToken);
      const config = configuration(env);
      await limitTokenRequest("refresh", ip, config.secret);
      const issuedAt = Math.floor(Date.now() / 1000);
      const nextRefresh = randomRefresh();
      const accessTokenId = randomUUID();
      const result = await store.rotateIdentityRefresh({ refreshHash: refreshHash(token), nextRefreshHash: refreshHash(nextRefresh),
        accessTokenId, issuedAt: timestamp(issuedAt), accessExpiresAt: timestamp(issuedAt + config.ttlSeconds) });
      if (result.status !== "rotated") throw new IdentityAuthenticationError();
      return tokens({ userId: result.userId, accessTokenId, issuedAt, accessExpiresAt: result.accessExpiresAt,
        refreshExpiresAt: result.refreshExpiresAt, refreshToken: nextRefresh });
    },
    async logout(body: Record<string, unknown>, ip: string) {
      requireOnly(body, ["refreshToken"]);
      const token = tokenInput(body.refreshToken);
      const config = configuration(env);
      await limitTokenRequest("logout", ip, config.secret);
      await store.revokeIdentityRefresh({ refreshHash: refreshHash(token) });
      return { ok: true };
    },
    /**
     * Ask for a recovery link.
     *
     * The answer is identical whether or not the address exists. Registration
     * already answers a duplicate address with a conflict and therefore leaks
     * which addresses have accounts; this endpoint is the one an attacker would
     * actually automate, so it does not repeat the mistake. The work is only
     * done when there is an account to do it for.
     */
    async requestPasswordReset(body: Record<string, unknown>, ip: string) {
      requireOnly(body, ["email"]);
      const email = normalizeEmail(body.email);
      const config = configuration(env);
      requireMail(env, "password_reset", onMailDelivery);
      await consume("password-reset:ip", ip, 20, REGISTER_WINDOW_SECONDS, config.secret);
      await consume("password-reset:email", email, 5, REGISTER_WINDOW_SECONDS, config.secret);
      const account = await store.findIdentityAccount({ email });
      if (account) {
        const token = randomToken();
        await store.issueIdentityToken({
          userId: account.userId, purpose: "password_reset", email,
          tokenHash: tokenHash(token), expiresAt: timestamp(Math.floor(Date.now() / 1000) + RESET_TOKEN_LIFETIME_SECONDS),
        });
        await deliver({
          purpose: "password_reset",
          to: email,
          token,
          subject: "重置你的密码",
          text: "我们收到了重置密码的请求。如果这不是你本人操作，忽略这封邮件即可，你的密码不会改变。",
        });
      }
      return { ok: true };
    },
    async resetPassword(body: Record<string, unknown>, ip: string) {
      requireOnly(body, ["token", "password"]);
      const token = tokenInput(body.token);
      // A recovered account is being handed a new credential, so hold it to the
      // same length rules as registration rather than the laxer login check.
      const password = passwordInput(body.password, true);
      const config = configuration(env);
      await consume("reset-password:ip", ip, 20, WINDOW_SECONDS, config.secret);
      await consume("reset-password:token", tokenHash(token), 5, WINDOW_SECONDS, config.secret);
      const consumed = await store.consumeIdentityToken({ tokenHash: tokenHash(token), purpose: "password_reset" });
      if (!consumed) throw new IdentityAuthenticationError();
      const passwordHash = await hashPassword(password);
      await store.setIdentityPassword({ userId: consumed.userId, passwordHash });
      // Every device signs out. Changing the password has to answer "what about
      // the session that was already stolen", and the refresh family would
      // otherwise outlive the credential it was issued against.
      await store.revokeIdentitySessions({ userId: consumed.userId });
      return { ok: true };
    },
    /**
     * Change the password of an account that is already signed in.
     *
     * The old credential is required first, so a stolen session on its own
     * gains nothing: it cannot take the account over, and it cannot lock the
     * owner out by pointing the password somewhere they do not know. The new
     * password is held to the registration rules rather than the laxer login
     * check, because it is a new credential — exactly as after a reset.
     *
     * Every *other* session of the account is signed out and this one is kept:
     * the device that just proved it knew the old password stays signed in, so
     * changing a password does not throw the visitor out of the page they are
     * using. A reset has no device that proved anything, which is why it signs
     * out everything instead.
     */
    async changePassword({ userId, sessionId, body, ip }: {
      userId: string; sessionId: string; body: Record<string, unknown>; ip: string;
    }) {
      requireOnly(body, ["currentPassword", "newPassword"]);
      const current = passwordInput(body.currentPassword, false);
      const next = passwordInput(body.newPassword, true);
      const config = configuration(env);
      await consume("change-password:user", userId, 5, WINDOW_SECONDS, config.secret);
      await consume("change-password:ip", ip, 20, WINDOW_SECONDS, config.secret);
      const account = await store.findIdentityCredentials({ userId });
      // A missing account costs the same KDF work as a wrong password, so the
      // response time does not say which one it was.
      const valid = await verifyPassword(current, account?.passwordHash ?? null);
      if (!account || !valid) throw new IdentityAuthenticationError();
      const passwordHash = await hashPassword(next);
      const updated = await store.setIdentityPassword({ userId, passwordHash });
      if (!updated) throw new IdentityAuthenticationError();
      const revokedSessions = await store.revokeIdentitySessions({ userId, exceptSessionId: sessionId });
      return { ok: true, revokedSessions };
    },
    /**
     * Move the signed-in account to another address.
     *
     * The current password is required for the same reason it is required to
     * change the password, and the reason is sharper here: whoever controls an
     * account's address controls its recovery, so a stolen session that could
     * move the address could then take the account over through the mailbox.
     *
     * The address is marked unverified, because the proof on file is proof of
     * the *old* one. Verification itself gates nothing (an unverified account
     * still signs in and publishes), and no mail is sent: on an instance where
     * mail is switched off, forcing a round trip through an inbox nobody can
     * reach would make changing an address impossible rather than merely slow.
     *
     * No session is revoked. Changing an address is not replacing a credential:
     * the devices already signed in are still the owner's devices, and signing
     * them out would only punish the person who just proved who they are.
     */
    async changeEmail({ userId, body, ip }: { userId: string; body: Record<string, unknown>; ip: string }) {
      requireOnly(body, ["password", "email"]);
      const password = passwordInput(body.password, false);
      const email = normalizeEmail(body.email);
      const config = configuration(env);
      await consume("change-email:user", userId, 5, REGISTER_WINDOW_SECONDS, config.secret);
      await consume("change-email:ip", ip, 20, REGISTER_WINDOW_SECONDS, config.secret);
      const credentials = await store.findIdentityCredentials({ userId });
      const valid = await verifyPassword(password, credentials?.passwordHash ?? null);
      if (!credentials || !valid) throw new IdentityAuthenticationError();
      const account = await store.findIdentityAccountByUserId({ userId });
      if (!account) throw new IdentityAuthenticationError();
      // Asking for the address the account already has is not a change, and
      // must not cost it a proof it has already earned.
      if (account.email === email) {
        return { ok: true, email: account.email, emailVerifiedAt: account.emailVerifiedAt };
      }
      const changed = await store.setIdentityEmail({ userId, email });
      if (!changed) throw new IdentityConflictError();
      return { ok: true, email, emailVerifiedAt: null };
    },
    /**
     * Send (or re-send) the verification link for the signed-in user's address.
     *
     * Authenticated, because the address it proves belongs to the caller is the
     * one already on the account — letting an unauthenticated caller ask would
     * turn this into a mail-bomb aimed at any address in the database.
     */
    async requestEmailVerification(userId: string, ip: string) {
      const config = configuration(env);
      requireMail(env, "email_verification", onMailDelivery);
      await consume("email-verification:user", userId, 5, REGISTER_WINDOW_SECONDS, config.secret);
      await consume("email-verification:ip", ip, 20, REGISTER_WINDOW_SECONDS, config.secret);
      const account = await store.findIdentityAccountByUserId({ userId });
      if (!account) throw new IdentityAuthenticationError();
      if (account.emailVerifiedAt) return { ok: true, alreadyVerified: true };
      const token = randomToken();
      await store.issueIdentityToken({
        userId, purpose: "email_verification", email: account.email,
        tokenHash: tokenHash(token), expiresAt: timestamp(Math.floor(Date.now() / 1000) + VERIFICATION_TOKEN_LIFETIME_SECONDS),
      });
      await deliver({
        purpose: "email_verification",
        to: account.email,
        token,
        subject: "确认你的邮箱",
        text: "请打开下面的链接确认这个邮箱属于你。链接只用一次，一天后失效。",
      });
      return { ok: true, alreadyVerified: false };
    },
    async verifyEmail(body: Record<string, unknown>, ip: string) {
      requireOnly(body, ["token"]);
      const token = tokenInput(body.token);
      const config = configuration(env);
      await consume("verify-email:ip", ip, 30, WINDOW_SECONDS, config.secret);
      const consumed = await store.consumeIdentityToken({ tokenHash: tokenHash(token), purpose: "email_verification" });
      if (!consumed) throw new IdentityAuthenticationError();
      await store.markIdentityEmailVerified({ userId: consumed.userId, verifiedAt: timestamp(Math.floor(Date.now() / 1000)) });
      return { ok: true };
    },
    /**
     * What the account holder is allowed to know about their own account.
     *
     * Deliberately not gated on verification: proving an address must not be a
     * precondition for reading your own state, or the screen that explains why
     * you should verify would be behind the thing it explains.
     */
    async describeAccount(userId: string) {
      const account = await store.findIdentityAccountByUserId({ userId });
      if (!account) return { id: userId, email: null, emailVerifiedAt: null };
      return { id: account.userId, email: account.email, emailVerifiedAt: account.emailVerifiedAt };
    },
  });
}
