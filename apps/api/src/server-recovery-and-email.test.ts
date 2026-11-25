/** Password recovery, email verification and email change. Split from server.test.ts (#357). */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { hashPassword } from "./security/passwords.ts";
import { MediaAssetNotFoundError } from "./application/media-assets.ts";
import { authEnv, signedToken, withServer } from "./test-support/rest-server-harness.ts";


/**
 * Recovery and verification, at the transport boundary.
 *
 * The assertions that matter here are the ones a client can observe: a recovery
 * request is accepted with 202 whether or not the address exists, the token is
 * never accepted from the path, and an unauthenticated caller cannot make the API
 * send mail at all.
 */
function recoveryStore(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const store: Record<string, unknown> = {
    calls,
    async consumeRateLimit() { return { allowed: true, resetAt: new Date(Date.now() + 60_000).toISOString() }; },
    async pruneExpiredIdentityState() { return true; },
    async findIdentityAccount({ email }) {
      calls.push({ method: "findIdentityAccount", args: { email } });
      return email === "owner@example.test" ? { userId: "owner-user", passwordHash: "hash-before" } : null;
    },
    async issueIdentityToken(args) { calls.push({ method: "issueIdentityToken", args }); return true; },
    async consumeIdentityToken({ tokenHash, purpose }) {
      calls.push({ method: "consumeIdentityToken", args: { tokenHash, purpose } });
      return tokenHash === RESET_TOKEN_HASH ? { userId: "owner-user", email: "owner@example.test" } : null;
    },
    async replaceIdentityPassword(args) { calls.push({ method: "replaceIdentityPassword", args }); return { updated: true, revokedSessions: 2 }; },
    async markIdentityEmailVerified(args) { calls.push({ method: "markIdentityEmailVerified", args }); return true; },
    async findIdentityAccountByUserId({ userId }) {
      calls.push({ method: "findIdentityAccountByUserId", args: { userId } });
      return userId === "owner-user" ? { userId, email: "owner@example.test", emailVerifiedAt: null } : null;
    },
    ...overrides,
  };
  return store;
}

const RESET_TOKEN = "A".repeat(43);
/** The only digest the fake store recognises, so the test exercises the real hashing. */
const RESET_TOKEN_HASH = createHash("sha256").update(RESET_TOKEN, "utf8").digest("hex");

test("REST password recovery accepts every address identically and never takes the token from the path", async () => {
  const store = recoveryStore();
  await withServer(async (baseUrl) => {
    const post = (path: string, body: unknown) => fetch(baseUrl + path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });

    const known = await post("/api/v1/auth/forgot-password", { email: "owner@example.test" });
    assert.equal(known.status, 202, "an accepted recovery request is not confirmed, only acknowledged");
    assert.deepEqual(await known.json(), { data: { ok: true } });

    // The whole point: the same answer for an address with no account behind it.
    const unknown = await post("/api/v1/auth/forgot-password", { email: "nobody@example.test" });
    assert.equal(unknown.status, 202);
    assert.deepEqual(await unknown.json(), { data: { ok: true } });

    const malformed = await post("/api/v1/auth/forgot-password", { email: "not-an-address" });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, "BAD_USER_INPUT");

    // A token in the path would be logged by every proxy between here and the
    // reader, so no route reads one: the path is simply not a route, and nothing
    // is spent. (Unknown paths answer a write with 405/allow: GET, the same
    // contract every other unrouted write gets.)
    const inPath = await fetch(baseUrl + "/api/v1/auth/reset-password/" + RESET_TOKEN, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "a-brand-new-password" }),
    });
    assert.equal(inPath.status, 405);
    assert.equal(inPath.headers.get("allow"), "GET");
    assert.ok(!store.calls.some((call) => call.method === "consumeIdentityToken"), "a token carried in a path is never spent");

    const wrongMethod = await fetch(baseUrl + "/api/v1/auth/forgot-password");
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "POST");
  }, { env: authEnv, store });
});

test("REST password reset spends the token once, replaces the credential and ends the sessions", async () => {
  const store = recoveryStore();
  await withServer(async (baseUrl) => {
    const post = (body: unknown) => fetch(baseUrl + "/api/v1/auth/reset-password", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const accepted = await post({ token: RESET_TOKEN, password: "a-brand-new-password" });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { data: { ok: true } });

    // A reset spares nothing, and it does that in the same call that carries
    // the new credential: the one failure mode worth designing out is a new
    // password with the session that was stolen still signed in.
    const replacement = store.calls.find((call) => call.method === "replaceIdentityPassword");
    assert.equal(replacement?.method, "replaceIdentityPassword");
    assert.equal(replacement?.args.userId, "owner-user");
    assert.equal(replacement?.args.exceptSessionId, null, "a reset has no session that proved anything");
    assert.match(String(replacement?.args.passwordHash), /^scrypt\$/, "and the new credential rides in the same call");

    // Well-formed but never issued: 401, not 400 — the shape is fine, the
    // credential is not. (A malformed one is rejected as bad input instead.)
    const unknown = await post({ token: randomBytes(32).toString("base64url"), password: "a-brand-new-password" });
    assert.equal(unknown.status, 401, "a token that was never issued is not a reset");
    const malformed = await post({ token: "not-a-token", password: "a-brand-new-password" });
    assert.equal(malformed.status, 400);

    const short = await post({ token: RESET_TOKEN, password: "short" });
    assert.equal(short.status, 400, "a recovered account gets a registration-strength password");
  }, { env: authEnv, store });
});

test("REST email verification stamps the account and only the account holder may ask for the mail", async () => {
  const store = recoveryStore();
  await withServer(async (baseUrl) => {
    const authorization = "Bearer " + signedToken("owner-user");
    const verified = await fetch(baseUrl + "/api/v1/auth/verify-email", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: RESET_TOKEN }),
    });
    assert.equal(verified.status, 200);
    assert.ok(store.calls.some((call) => call.method === "markIdentityEmailVerified"));

    const requested = await fetch(baseUrl + "/api/v1/me/email-verification", { method: "POST", headers: { authorization } });
    assert.equal(requested.status, 202);
    assert.deepEqual(await requested.json(), { data: { ok: true, alreadyVerified: false } });
    assert.deepEqual(store.calls.find((call) => call.method === "issueIdentityToken").args.purpose, "email_verification");

    // Unauthenticated: no way to aim mail at an address.
    const anonymous = await fetch(baseUrl + "/api/v1/me/email-verification", { method: "POST" });
    assert.equal(anonymous.status, 401);
  }, { env: authEnv, store });
});

/**
 * The mail switch, over HTTP.
 *
 * Both endpoints that would put a link in somebody's inbox answer 409 with
 * `MAIL_DISABLED` while the switch is off — 409 rather than 503 because nothing
 * is temporarily unavailable; the site simply cannot mail anybody. What they
 * must **not** do is answer 202: a page that says "check your mail" when no mail
 * exists is worse than one that says the site cannot do this.
 */
test("recovery and verification answer 503 while mail is switched off", async () => {
  const store = recoveryStore();
  const disabled = { ...authEnv, MAIL_ENABLED: "false" };
  await withServer(async (baseUrl) => {
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(baseUrl + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

    const reset = await post("/api/v1/auth/forgot-password", { email: "owner@example.test" });
    assert.equal(reset.status, 409, "a recovery link that cannot be delivered is not an accepted request");
    assert.equal((await reset.json()).error.code, "MAIL_DISABLED");
    assert.ok(!store.calls.some((call) => call.method === "issueIdentityToken"), "no token is issued for a mail that cannot be sent");

    const authorization = "Bearer " + signedToken("owner-user");
    const verification = await post("/api/v1/me/email-verification", {}, { authorization });
    assert.equal(verification.status, 409);
    assert.equal((await verification.json()).error.code, "MAIL_DISABLED");
  }, { env: disabled, store });
});

test("the same endpoints work the moment the switch is on", async () => {
  const store = recoveryStore();
  await withServer(async (baseUrl) => {
    const reset = await fetch(baseUrl + "/api/v1/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@example.test" }),
    });
    assert.equal(reset.status, 202);
    assert.deepEqual(await reset.json(), { data: { ok: true } });
    assert.ok(store.calls.some((call) => call.method === "issueIdentityToken"));
  }, { env: authEnv, store });
});

/**
 * The address a stored asset carries.
 *
 * `POST /me/media` answers with `src: /api/media/<id>` — the *application*
 * path, not the versioned one — because that is the address a content body
 * keeps, and the Web app serves it from its own origin. The stored `src` is not
 * changed (it would break every body already saved, and the editor that only
 * accepts it), so the API answers that path too: one address, both
 * deployments, and a client that talks to the API directly no longer has to
 * rewrite the address it was just handed.
 */
test("the application-relative media address a stored asset carries is served by the API too", async () => {
  const assetId = "11111111-1111-4111-8111-111111111111";
  const bytes = Buffer.from("RIFF-alias-webp");
  const sha256 = "b".repeat(64);
  const requested: string[] = [];
  const mediaAssets = {
    async upload() { throw new Error("unused"); },
    async getPublic({ id }: { id: string }) {
      requested.push(id);
      if (id !== assetId) throw new MediaAssetNotFoundError();
      return { id, bytes, byteSize: bytes.byteLength, width: 10, height: 8, sha256, contentType: "image/webp" as const };
    },
  };
  await withServer(async (baseUrl) => {
    const alias = await fetch(baseUrl + "/api/media/" + assetId);
    assert.equal(alias.status, 200);
    assert.equal(alias.headers.get("content-type"), "image/webp");
    assert.match(alias.headers.get("cache-control") ?? "", /immutable/);
    assert.equal(alias.headers.get("etag"), '"' + sha256 + '"');
    assert.deepEqual(Buffer.from(await alias.arrayBuffer()), bytes);
    assert.deepEqual(requested, [assetId], "the alias resolves through the same handler, not a second one");

    // An unknown asset on the alias is still a 404, and the alias is not a way
    // in for a write: one path, and the same rules the versioned one has.
    const missing = await fetch(baseUrl + "/api/media/22222222-2222-4222-8222-222222222222");
    assert.equal(missing.status, 404);
    const write = await fetch(baseUrl + "/api/media/" + assetId, { method: "POST" });
    assert.equal(write.status, 405);
    assert.equal(write.headers.get("allow"), "GET");
    assert.equal(requested.length, 2, "the rejected write never reached the media service");
  }, { mediaAssets });
});

/**
 * `PUT /api/v1/me/email`.
 *
 * The address is where account recovery lands, so this is the one account
 * change that needs the current password even more sharply than changing the
 * password does. What it must *not* do is gate on verification or send a mail —
 * on an instance where mail is off, that would make the change impossible
 * rather than merely unverified.
 */
test("REST email change stores the new address, unproven, and signs nobody out", async () => {
  const seen: { email: Record<string, unknown> | null } = { email: null };
  const passwordHash = await hashPassword("the-current-password");
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/v1/me/email", {
      method: "PUT",
      headers: {
        authorization: "Bearer " + signedToken("email-user"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ password: "the-current-password", email: "New.Owner@Example.test" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      data: { ok: true, email: "new.owner@example.test", emailVerifiedAt: null },
    });
    // The address move carries the state the service verified: the address the
    // account had when the password was checked, and the credential it checked.
    assert.deepEqual(seen.email, {
      userId: "email-user", email: "new.owner@example.test",
      proof: { email: "owner@example.test", passwordHash },
    });
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async findIdentityCredentials({ userId }) { return { userId, passwordHash }; },
      async findIdentityAccountByUserId({ userId }) {
        return { userId, email: "owner@example.test", emailVerifiedAt: "2026-01-01T00:00:00.000Z" };
      },
      async setIdentityEmail(args) { seen.email = args; return true; },
      async replaceIdentityPassword() { throw new Error("must not be called"); },
    },
  });
});

test("REST email change refuses a wrong password, reports a taken address, and is authenticated", async () => {
  let stored = 0;
  // A stable hash, as a real store has: the retry-on-failure path compares the
  // credential it verified with the one still on file.
  const passwordHash = await hashPassword("the-current-password");
  await withServer(async (baseUrl) => {
    const session = { authorization: "Bearer " + signedToken("email-user"), "content-type": "application/json" };

    const wrongPassword = await fetch(baseUrl + "/api/v1/me/email", {
      method: "PUT",
      headers: session,
      body: JSON.stringify({ password: "not-the-password", email: "moved@example.test" }),
    });
    assert.equal(wrongPassword.status, 401);
    assert.equal((await wrongPassword.json()).error.code, "UNAUTHENTICATED");

    const taken = await fetch(baseUrl + "/api/v1/me/email", {
      method: "PUT",
      headers: session,
      body: JSON.stringify({ password: "the-current-password", email: "taken@example.test" }),
    });
    assert.equal(taken.status, 409);
    // Which conflict it is, not just that it is one: the account page says
    // "that address is taken" and the reader picks another.
    assert.equal((await taken.json()).error.code, "EMAIL_TAKEN");

    const anonymous = await fetch(baseUrl + "/api/v1/me/email", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "the-current-password", email: "moved@example.test" }),
    });
    assert.equal(anonymous.status, 401);

    const read = await fetch(baseUrl + "/api/v1/me/email", { headers: { authorization: "Bearer " + signedToken("email-user") } });
    assert.equal(read.status, 405);
    assert.equal(read.headers.get("allow"), "PUT");
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async findIdentityCredentials({ userId }) { return { userId, passwordHash }; },
      async findIdentityAccountByUserId({ userId }) {
        return { userId, email: "owner@example.test", emailVerifiedAt: null };
      },
      async setIdentityEmail({ email }) { stored += 1; return email !== "taken@example.test"; },
    },
  });
  assert.equal(stored, 1, "only the accepted-password attempt reaches the store");
});
