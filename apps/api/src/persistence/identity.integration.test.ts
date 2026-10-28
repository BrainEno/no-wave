import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { createApiServer } from "../server.ts";
import { createPostgresClient, createPostgresStore } from "./postgres.ts";
import { runMigrations } from "./migrate.ts";
import { createSqliteClient, runSqliteMigrations } from "./sqlite.ts";
import { createSqliteStore } from "./sqlite-store.ts";

const testDatabase = process.env.TEST_DATABASE_URL;
let sql;
before(async () => {
  if (!testDatabase) return;
  sql = await createPostgresClient({ connectionString: testDatabase, max: 6 });
  await runMigrations(sql);
});
after(async () => { if (sql) await sql.end({ timeout: 5 }); });

const password = "correct horse battery staple"; // Disposable test fixture only.

async function fixture(provider) {
  let db;
  let store;
  if (provider === "SQLite") {
    db = createSqliteClient({ filename: ":memory:", enableWal: false });
    await runSqliteMigrations(db);
    store = createSqliteStore(db);
  } else {
    store = createPostgresStore(sql);
  }
  const env = {
    AUTH_JWT_SECRET: `disposable-test-secret-${randomUUID()}`,
    AUTH_JWT_ISSUER: "https://auth.integration.test",
    AUTH_JWT_AUDIENCE: "api-integration",
  };
  const email = `test+${randomUUID()}@example.test`;
  let server;
  let base;
  async function start() {
    server = createApiServer({ env, store });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  await start();
  const post = (path, body, headers = {}) => fetch(base + path, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  const me = (accessToken) => fetch(base + "/api/v1/me", { headers: { authorization: `Bearer ${accessToken}` } });
  return {
    store, db, env, email, post, me,
    get base() { return base; },
    async restart() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await start();
    },
    async inspect() {
      if (db) {
        const account = db.prepare("SELECT * FROM auth_accounts WHERE email = ?").get(email);
        const sessions = db.prepare("SELECT * FROM auth_sessions WHERE user_id = ?").all(account.user_id);
        const refresh = db.prepare("SELECT * FROM auth_refresh_tokens WHERE session_id = ?").all(sessions[0].id);
        return { account, sessions, refresh };
      }
      const [account] = await sql.unsafe("SELECT * FROM auth_accounts WHERE email = $1", [email]);
      const sessions = await sql.unsafe("SELECT * FROM auth_sessions WHERE user_id = $1", [account.user_id]);
      const refresh = await sql.unsafe("SELECT * FROM auth_refresh_tokens WHERE session_id = $1", [sessions[0].id]);
      return { account, sessions, refresh };
    },
    async expireSession() {
      if (db) db.prepare("UPDATE auth_sessions SET expires_at = ? WHERE user_id = (SELECT user_id FROM auth_accounts WHERE email = ?)")
        .run("2000-01-01T00:00:00.000Z", email);
      else await sql.unsafe("UPDATE auth_sessions SET expires_at = '2000-01-01T00:00:00Z' WHERE user_id = (SELECT user_id FROM auth_accounts WHERE email = $1)", [email]);
    },
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      if (db) db.close();
      else {
        await sql.unsafe(`DELETE FROM revoked_sessions WHERE session_id IN (
          SELECT a.token_id FROM auth_access_tokens a JOIN auth_sessions s ON s.id = a.session_id
          JOIN auth_accounts u ON u.user_id = s.user_id WHERE u.email = $1
        )`, [email]);
        await sql.unsafe("DELETE FROM user_profiles WHERE user_id IN (SELECT user_id FROM auth_accounts WHERE email = $1)", [email]);
        await sql.unsafe("DELETE FROM auth_accounts WHERE email = $1", [email]);
        const rateSubjects = [
          ["register:ip", "127.0.0.1"], ["register:email", email],
          ["login:ip", "127.0.0.1"], ["login:email", email], ["login:email", `unknown-${email}`],
          ["refresh:ip", "127.0.0.1"], ["logout:ip", "127.0.0.1"],
        ];
        const rateSecret = createHmac("sha256", env.AUTH_JWT_SECRET).update("bot-thk:identity-rate-limit:v1").digest();
        const rateKeys = rateSubjects.map((subject) => createHmac("sha256", rateSecret).update(JSON.stringify(subject)).digest("hex"));
        await sql.unsafe("DELETE FROM auth_rate_limits WHERE key = ANY($1::text[])", [rateKeys]);
      }
    },
  };
}

function registerIdentityContracts(provider, options = {}) {
  test(`${provider}: registration, password login and session logout stay independent`, options, async () => {
    const f = await fixture(provider);
    try {
      const register = await f.post("/api/v1/auth/register", { email: f.email.toUpperCase(), password });
      assert.equal(register.status, 201);
      assert.equal(register.headers.get("cache-control"), "no-store");
      assert.equal(register.headers.get("set-cookie"), null);
      const first = (await register.json()).data;
      assert.equal(first.tokenType, "Bearer");
      assert.ok(first.accessToken && first.refreshToken && first.accessExpiresAt && first.refreshExpiresAt);
      const me = await f.me(first.accessToken);
      assert.equal(me.status, 200);
      const userId = (await me.json()).data.id;
      const profile = await fetch(f.base + "/api/v1/me/profile", {
        method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${first.accessToken}` },
        body: JSON.stringify({ displayName: "Test account", locale: "zh-CN" }),
      });
      assert.equal(profile.status, 200);
      const publicProfile = await fetch(f.base + `/api/v1/authors/${userId}?locale=zh-CN`);
      assert.equal(publicProfile.status, 200);
      const publicText = await publicProfile.text();
      assert.ok(!publicText.includes(f.email) && !publicText.includes(password) && !publicText.includes(first.refreshToken));
      const stored = await f.inspect();
      const serialized = JSON.stringify(stored);
      assert.ok(!serialized.includes(password), "plaintext password must not be persisted");
      assert.ok(!serialized.includes(first.refreshToken), "plaintext refresh token must not be persisted");
      assert.ok(!serialized.includes(first.accessToken), "access token must not be persisted");

      const login = await f.post("/api/v1/auth/login", { email: f.email, password });
      assert.equal(login.status, 200);
      const second = (await login.json()).data;
      assert.notEqual(first.accessToken, second.accessToken);
      assert.notEqual(first.refreshToken, second.refreshToken);
      const logout = await f.post("/api/v1/auth/logout", { refreshToken: first.refreshToken });
      assert.equal(logout.status, 200);
      assert.equal((await f.me(first.accessToken)).status, 401);
      assert.equal((await f.me(second.accessToken)).status, 200, "logout must not revoke an independent login");
      assert.equal((await f.post("/api/v1/auth/refresh", { refreshToken: first.refreshToken })).status, 401);
      assert.equal((await f.post("/api/v1/auth/logout", { refreshToken: first.refreshToken })).status, 200);
      assert.equal((await f.post("/api/v1/auth/logout", { refreshToken: randomBytes(32).toString("base64url") })).status, 200);
    } finally { await f.close(); }
  });

  test(`${provider}: access-token logout revokes every access and refresh token in that session`, options, async () => {
    const f = await fixture(provider);
    try {
      const first = (await (await f.post("/api/v1/auth/register", { email: f.email, password })).json()).data;
      const rotatedResponse = await f.post("/api/v1/auth/refresh", { refreshToken: first.refreshToken });
      assert.equal(rotatedResponse.status, 200);
      const rotated = (await rotatedResponse.json()).data;
      assert.notEqual(first.refreshToken, rotated.refreshToken);
      assert.notEqual(first.accessToken, rotated.accessToken);
      assert.equal(rotated.refreshExpiresAt, first.refreshExpiresAt, "refresh does not extend the absolute session expiry");
      assert.equal((await f.me(first.accessToken)).status, 200);
      assert.equal((await f.me(rotated.accessToken)).status, 200);
      const revoke = await fetch(f.base + "/api/v1/me/session", {
        method: "DELETE", headers: { authorization: `Bearer ${first.accessToken}` },
      });
      assert.equal(revoke.status, 200);
      assert.equal((await f.me(first.accessToken)).status, 401);
      assert.equal((await f.me(rotated.accessToken)).status, 401);
      assert.equal((await f.post("/api/v1/auth/refresh", { refreshToken: rotated.refreshToken })).status, 401);
      const graphql = await f.post("/graphql", { query: "{ viewer { id } }" }, { authorization: `Bearer ${rotated.accessToken}` });
      assert.equal((await graphql.json()).data.viewer, null);
    } finally { await f.close(); }
  });

  test(`${provider}: transitional GraphQL logout revokes the self-hosted refresh family`, options, async () => {
    const f = await fixture(provider);
    try {
      const first = (await (await f.post("/api/v1/auth/register", { email: f.email, password })).json()).data;
      const rotated = (await (await f.post("/api/v1/auth/refresh", { refreshToken: first.refreshToken })).json()).data;
      const response = await f.post("/graphql", { query: "mutation { revokeCurrentSession }" }, { authorization: `Bearer ${first.accessToken}` });
      assert.deepEqual(await response.json(), { data: { revokeCurrentSession: true } });
      assert.equal((await f.me(first.accessToken)).status, 401);
      assert.equal((await f.me(rotated.accessToken)).status, 401);
      assert.equal((await f.post("/api/v1/auth/refresh", { refreshToken: rotated.refreshToken })).status, 401);
    } finally { await f.close(); }
  });

  test(`${provider}: concurrent refresh reuse revokes the entire token family`, options, async () => {
    const f = await fixture(provider);
    try {
      const first = (await (await f.post("/api/v1/auth/register", { email: f.email, password })).json()).data;
      const responses = await Promise.all([
        f.post("/api/v1/auth/refresh", { refreshToken: first.refreshToken }),
        f.post("/api/v1/auth/refresh", { refreshToken: first.refreshToken }),
      ]);
      assert.deepEqual(responses.map((response) => response.status).sort(), [200, 401]);
      const winner = (await responses.find((response) => response.status === 200).json()).data;
      assert.equal((await f.me(first.accessToken)).status, 401);
      assert.equal((await f.me(winner.accessToken)).status, 401);
      assert.equal((await f.post("/api/v1/auth/refresh", { refreshToken: winner.refreshToken })).status, 401);
    } finally { await f.close(); }
  });

  test(`${provider}: logout racing refresh cannot leave the rotated session active`, options, async () => {
    const f = await fixture(provider);
    try {
      const first = (await (await f.post("/api/v1/auth/register", { email: f.email, password })).json()).data;
      const [refresh, logout] = await Promise.all([
        f.post("/api/v1/auth/refresh", { refreshToken: first.refreshToken }),
        f.post("/api/v1/auth/logout", { refreshToken: first.refreshToken }),
      ]);
      assert.equal(logout.status, 200);
      assert.ok([200, 401].includes(refresh.status));
      assert.equal((await f.me(first.accessToken)).status, 401);
      if (refresh.status === 200) {
        const issued = (await refresh.json()).data;
        assert.equal((await f.me(issued.accessToken)).status, 401);
        assert.equal((await f.post("/api/v1/auth/refresh", { refreshToken: issued.refreshToken })).status, 401);
      }
    } finally { await f.close(); }
  });

  test(`${provider}: invalid credentials are generic, inputs are bounded, and attempts are throttled durably`, options, async () => {
    const f = await fixture(provider);
    try {
      assert.equal((await f.post("/api/v1/auth/register", { email: f.email, password: "short" })).status, 400);
      assert.equal((await f.post("/api/v1/auth/register", { email: f.email, password, userId: "client-spoof" })).status, 400);
      assert.equal((await f.post("/api/v1/auth/register", { email: f.email, password })).status, 201);
      const wrong = await f.post("/api/v1/auth/login", { email: f.email, password: "wrong password" });
      const unknown = await f.post("/api/v1/auth/login", { email: `unknown-${f.email}`, password: "wrong password" });
      assert.equal(wrong.status, 401);
      assert.equal(unknown.status, 401);
      assert.deepEqual(await wrong.json(), await unknown.json());
      for (let i = 0; i < 4; i += 1) {
        const attempt = await f.post("/api/v1/auth/login", { email: f.email, password: "wrong password" }, { "x-forwarded-for": `203.0.113.${i}` });
        assert.equal(attempt.status, 401);
      }
      await f.restart(); // Limits must survive an API process restart.
      const limited = await f.post("/api/v1/auth/login", { email: f.email, password });
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get("cache-control"), "no-store");
      assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    } finally { await f.close(); }
  });

  test(`${provider}: concurrent throttle increments cannot exceed the configured allowance`, options, async () => {
    const f = await fixture(provider);
    const key = randomBytes(32).toString("hex");
    try {
      const results = await Promise.all(Array.from({ length: 20 }, () =>
        f.store.consumeIdentityRateLimit({ key, limit: 5, windowSeconds: 60 })));
      assert.equal(results.filter((result) => result.allowed).length, 5);
      assert.equal(results.filter((result) => !result.allowed).length, 15);
      const row = f.db
        ? f.db.prepare("SELECT attempts FROM auth_rate_limits WHERE key = ?").get(key)
        : (await sql.unsafe("SELECT attempts FROM auth_rate_limits WHERE key = $1", [key]))[0];
      assert.equal(Number(row.attempts), 6, "rejected traffic must not overflow an unbounded counter");
    } finally {
      if (!f.db) await sql.unsafe("DELETE FROM auth_rate_limits WHERE key = $1", [key]);
      await f.close();
    }
  });

  test(`${provider}: bounded maintenance removes expired sessions, limits and revocations without touching active state`, options, async () => {
    const f = await fixture(provider);
    const expiredKey = randomBytes(32).toString("hex");
    const activeKey = randomBytes(32).toString("hex");
    const expiredRevocationId = `cleanup-expired-${randomUUID()}`;
    const activeRevocationId = `cleanup-active-${randomUUID()}`;
    try {
      const registration = await f.post("/api/v1/auth/register", { email: f.email, password });
      assert.equal(registration.status, 201);
      const stored = await f.inspect();
      const sessionId = stored.sessions[0].id;
      await f.expireSession();
      // A damaged/admin-shortened session expiry must not erase the mapping
      // while an access token for that family can still authenticate.
      await f.store.pruneExpiredIdentityState();
      if (f.db) {
        assert.ok(f.db.prepare("SELECT id FROM auth_sessions WHERE id = ?").get(sessionId));
        f.db.prepare("UPDATE auth_access_tokens SET expires_at = ? WHERE session_id = ?").run("2000-01-01T00:00:00.000Z", sessionId);
      } else {
        assert.equal((await sql.unsafe("SELECT id FROM auth_sessions WHERE id = $1", [sessionId])).length, 1);
        await sql.unsafe("UPDATE auth_access_tokens SET expires_at = '2000-01-01T00:00:00Z' WHERE session_id = $1", [sessionId]);
      }
      const recentSession = randomUUID();
      const recentExpiry = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      await f.store.createIdentitySession({
        userId: stored.account.user_id, sessionId: recentSession, expiresAt: recentExpiry,
        accessTokenId: randomUUID(), accessExpiresAt: recentExpiry, refreshHash: randomBytes(32).toString("hex"),
      });
      await f.store.consumeIdentityRateLimit({ key: expiredKey, limit: 2, windowSeconds: 60 });
      await f.store.consumeIdentityRateLimit({ key: activeKey, limit: 2, windowSeconds: 60 });
      if (f.db) f.db.prepare("UPDATE auth_rate_limits SET reset_at = ? WHERE key = ?").run("2000-01-01T00:00:00.000Z", expiredKey);
      else await sql.unsafe("UPDATE auth_rate_limits SET reset_at = '2000-01-01T00:00:00Z' WHERE key = $1", [expiredKey]);

      if (f.db) {
        const insertRevocation = f.db.prepare("INSERT INTO revoked_sessions (session_id, expires_at) VALUES (?, ?)");
        insertRevocation.run(expiredRevocationId, "2000-01-01T00:00:00.000Z");
        insertRevocation.run(activeRevocationId, new Date(Date.now() + 60 * 60 * 1000).toISOString());
      } else {
        await sql.unsafe(
          "INSERT INTO revoked_sessions (session_id, expires_at) VALUES ($1, '2000-01-01T00:00:00Z'), ($2, clock_timestamp() + interval '1 hour')",
          [expiredRevocationId, activeRevocationId],
        );
      }

      await f.store.pruneExpiredIdentityState();
      assert.ok(await f.store.findIdentityAccount({ email: f.email }), "account data is not part of session cleanup");
      if (f.db) {
        assert.equal(f.db.prepare("SELECT id FROM auth_sessions WHERE id = ?").get(sessionId), undefined);
        assert.ok(f.db.prepare("SELECT id FROM auth_sessions WHERE id = ?").get(recentSession));
        assert.equal(f.db.prepare("SELECT key FROM auth_rate_limits WHERE key = ?").get(expiredKey), undefined);
        assert.ok(f.db.prepare("SELECT key FROM auth_rate_limits WHERE key = ?").get(activeKey));
        assert.equal(f.db.prepare("SELECT session_id FROM revoked_sessions WHERE session_id = ?").get(expiredRevocationId), undefined);
        assert.ok(f.db.prepare("SELECT session_id FROM revoked_sessions WHERE session_id = ?").get(activeRevocationId));
      } else {
        assert.equal((await sql.unsafe("SELECT id FROM auth_sessions WHERE id = $1", [sessionId])).length, 0);
        assert.equal((await sql.unsafe("SELECT id FROM auth_sessions WHERE id = $1", [recentSession])).length, 1);
        assert.equal((await sql.unsafe("SELECT key FROM auth_rate_limits WHERE key = $1", [expiredKey])).length, 0);
        assert.equal((await sql.unsafe("SELECT key FROM auth_rate_limits WHERE key = $1", [activeKey])).length, 1);
        assert.equal((await sql.unsafe("SELECT session_id FROM revoked_sessions WHERE session_id = $1", [expiredRevocationId])).length, 0);
        assert.equal((await sql.unsafe("SELECT session_id FROM revoked_sessions WHERE session_id = $1", [activeRevocationId])).length, 1);
      }
    } finally {
      if (!f.db) {
        await sql.unsafe("DELETE FROM auth_rate_limits WHERE key = ANY($1::text[])", [[expiredKey, activeKey]]);
        await sql.unsafe("DELETE FROM revoked_sessions WHERE session_id = ANY($1::text[])", [[expiredRevocationId, activeRevocationId]]);
      }
      await f.close();
    }
  });

  test(`${provider}: duplicate registration is unique and expired refresh sessions fail closed`, options, async () => {
    const f = await fixture(provider);
    try {
      const attempts = await Promise.all([
        f.post("/api/v1/auth/register", { email: f.email, password }),
        f.post("/api/v1/auth/register", { email: f.email.toUpperCase(), password }),
      ]);
      assert.deepEqual(attempts.map((response) => response.status).sort(), [201, 409]);
      const first = (await attempts.find((response) => response.status === 201).json()).data;
      await f.expireSession();
      assert.equal((await f.post("/api/v1/auth/refresh", { refreshToken: first.refreshToken })).status, 401);
    } finally { await f.close(); }
  });
}

registerIdentityContracts("SQLite");
registerIdentityContracts("PostgreSQL", { skip: !testDatabase && "TEST_DATABASE_URL is not set" });

test("PostgreSQL refresh cannot revive a session that expires while waiting on its row lock", { skip: !testDatabase && "TEST_DATABASE_URL is not set" }, async () => {
  const f = await fixture("PostgreSQL");
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let signalLocked;
  const locked = new Promise((resolve) => { signalLocked = resolve; });
  let blocker;
  try {
    const first = (await (await f.post("/api/v1/auth/register", { email: f.email, password })).json()).data;
    const [session] = await sql.unsafe("SELECT id FROM auth_sessions WHERE user_id = (SELECT user_id FROM auth_accounts WHERE email = $1)", [f.email]);
    await sql.unsafe("UPDATE auth_sessions SET expires_at = clock_timestamp() + interval '1 second' WHERE id = $1", [session.id]);
    blocker = sql.begin(async (tx) => {
      await tx.unsafe("SELECT id FROM auth_sessions WHERE id = $1 FOR UPDATE", [session.id]);
      signalLocked();
      await held;
    });
    await locked;
    const pending = f.post("/api/v1/auth/refresh", { refreshToken: first.refreshToken });
    await new Promise((resolve) => setTimeout(resolve, 1400));
    release();
    await blocker;
    const response = await pending;
    assert.equal(response.status, 401);
  } finally {
    release();
    if (blocker) await blocker;
    await f.close();
  }
});

test("identity HTTP errors are bounded, sanitized and fail closed when configuration or storage is unavailable", async () => {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  await runSqliteMigrations(db);
  const underlying = createSqliteStore(db);
  const badStore = {
    ...underlying,
    async consumeIdentityRateLimit() { throw new Error(`private diagnostic ${password}`); },
  };
  const goodEnv = { AUTH_JWT_SECRET: "disposable-test-only-secret-32-bytes", AUTH_JWT_ISSUER: "test", AUTH_JWT_AUDIENCE: "test" };
  let server;
  async function start(env, store) {
    server = createApiServer({ env, store });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  const send = (base, body) => fetch(base + "/api/v1/auth/register", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    let base = await start(goodEnv, badStore);
    const wrongMethod = await fetch(base + "/api/v1/auth/login");
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "POST");
    const wrongType = await fetch(base + "/api/v1/auth/register", { method: "POST", body: "not json" });
    assert.equal(wrongType.status, 415);
    const oversized = await send(base, { email: "example@example.test", password: "x".repeat(5000) });
    assert.equal(oversized.status, 413);
    const failure = await send(base, { email: "example@example.test", password });
    assert.equal(failure.status, 500);
    const text = await failure.text();
    assert.ok(!text.includes(password));
    assert.ok(!text.includes("private diagnostic"));
    assert.equal(db.prepare("SELECT count(*) AS n FROM auth_accounts").get().n, 0);
    await stop();
    base = await start({ ...goodEnv, AUTH_JWT_SECRET: "short" }, underlying);
    const misconfigured = await send(base, { email: "example@example.test", password });
    assert.equal(misconfigured.status, 503);
    assert.equal(db.prepare("SELECT count(*) AS n FROM auth_accounts").get().n, 0);
  } finally {
    if (server?.listening) await stop();
    db.close();
  }
});

test("identity rate limiting uses the socket peer and ignores spoofed forwarding headers", async () => {
  const keys = [];
  const services = {
    async consumeIdentityRateLimit({ key }) { keys.push(key); return { allowed: true, resetAt: new Date(Date.now() + 60000).toISOString() }; },
    async revokeIdentityRefresh() { return true; },
    async pruneExpiredIdentityState() {},
  };
  const env = { AUTH_JWT_SECRET: "disposable-test-only-secret-32-bytes", AUTH_JWT_ISSUER: "test", AUTH_JWT_AUDIENCE: "test" };
  const server = createApiServer({ env, applicationServices: services });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = randomBytes(32).toString("base64url");
  try {
    for (const forwarded of ["203.0.113.2", "203.0.113.3"]) {
      const response = await fetch(base + "/api/v1/auth/logout", {
        method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": forwarded },
        body: JSON.stringify({ refreshToken: token }),
      });
      assert.equal(response.status, 200);
    }
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
    assert.match(keys[0], /^[0-9a-f]{64}$/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
