import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { resolveRefreshSettings } from "../refresh/settings.ts";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { handleAuthRequest } from "@no-wave/web-http";
import { PostgresRefreshCoordinator } from "../refresh/coordinator.ts";
import { PostgresRefreshStore } from "../refresh/postgres-store.ts";
import { RefreshResultCodec } from "../refresh/result-codec.ts";
import { createSharedRefreshFixture } from "./support/shared-refresh-store.ts";

const options = { timeout: 30_000, skip: !process.env.TEST_DATABASE_URL && "Set TEST_DATABASE_URL for real shared-refresh PostgreSQL concurrency." };
const key = "a".repeat(64);
const endpoint = "https://api.example.test/api/v1/auth/refresh";
function tokenSet() { return { accessToken: "fixture-pg-access-token-".repeat(3), tokenType: "Bearer" as const, accessExpiresAt: new Date(Date.now() + 60000).toISOString(), refreshToken: "b".repeat(43), refreshExpiresAt: new Date(Date.now() + 3600000).toISOString() }; }

test("PostgreSQL: independent pools atomically spend one shared generation and protect stored results", options, async t => {
  const f = await createSharedRefreshFixture(); t.after(() => f.cleanup());
  const one = new PostgresRefreshCoordinator({ settings: f.settings, codec: f.codec, store: f.store });
  const otherStore = new PostgresRefreshStore(f.settings, f.codec.fingerprint);
  const two = new PostgresRefreshCoordinator({ settings: f.settings, codec: new RefreshResultCodec(f.settings.encryptionKey), store: otherStore });
  t.after(() => Promise.all([one.close(), two.close()]));
  await Promise.all([one.start(), two.start()]);
  let rotations = 0; const tokens = tokenSet();
  const rotate = async () => { rotations++; await delay(60); return tokens; };
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? one : two).resolve(key, rotate, { endpoint })));
  assert.equal(rotations, 1); for (const result of results) assert.deepEqual(result, tokens);
  const rows = await f.inspect`SELECT * FROM web_refresh_coordination`;
  assert.equal(rows.length, 1); assert.equal(rows[0]!.state, "resolved");
  assert.ok(!JSON.stringify(rows).includes(tokens.refreshToken) && !JSON.stringify(rows).includes(tokens.accessToken));
  // A wrong-key replica must refuse policy before consuming a refresh.
  const wrongCodec = new RefreshResultCodec(Buffer.alloc(32, 1));
  const wrong = new PostgresRefreshStore(f.settings, wrongCodec.fingerprint);
  try { await assert.rejects(wrong.verify()); } finally { await wrong.close(); wrongCodec.dispose(); }
});

test("PostgreSQL: an interrupted owner leaves a durable no-replay fence and sweep never steals it", options, async t => {
  const f = await createSharedRefreshFixture({ WEB_REFRESH_ROTATION_TIMEOUT_MS: "100" }); t.after(() => f.cleanup());
  const claim = await f.store.claim(key, randomUUID(), endpoint); assert.equal(claim.owner, true);
  await delay(125);
  const coordinator = new PostgresRefreshCoordinator({ settings: f.settings, codec: f.codec, store: f.store }); t.after(() => coordinator.close());
  let rotations = 0;
  const result = await coordinator.resolve(key, async () => { rotations++; return tokenSet(); }, { endpoint });
  assert.ok(result && "kind" in result && result.code === "REFRESH_UNCERTAIN"); assert.equal(rotations, 0);
  assert.equal(await f.store.sweep(1), 0);
  const [row] = await f.inspect`SELECT state, expires_at FROM web_refresh_coordination`;
  assert.equal(row!.state, "uncertain"); assert.ok(new Date(row!.expires_at).getTime() - Date.now() > 29 * 86400000);
});

test("PostgreSQL: namespace capacity is atomic and completion is owner/deadline fenced", options, async t => {
  const f = await createSharedRefreshFixture({ WEB_REFRESH_MAX_ENTRIES: "1" }); t.after(() => f.cleanup());
  const [first, second] = await Promise.allSettled([f.store.claim(key, randomUUID(), endpoint), f.store.claim("c".repeat(64), randomUUID(), endpoint)]);
  assert.equal([first, second].filter(result => result.status === "fulfilled").length, 1);
  const [row] = await f.inspect`SELECT generation_key FROM web_refresh_coordination`;
  assert.equal(await f.store.complete({ key: row!.generation_key, owner: randomUUID(), sealed: "v1.invalid", resultUntil: Date.now() + 1000, uncertain: false }), false);
  await f.inspect`UPDATE web_refresh_coordination SET expires_at = clock_timestamp() - interval '1 second'`;
  assert.equal(await f.store.sweep(1), 1);
  assert.equal(await f.store.sweep(1), 0);
});

test("PostgreSQL: incompatible or filtered coordination tables fail readiness before rotation", options, async t => {
  const f = await createSharedRefreshFixture(); t.after(() => f.cleanup());
  await f.store.verify();
  await f.inspect`ALTER TABLE web_refresh_coordination ENABLE ROW LEVEL SECURITY`;
  await assert.rejects(f.store.verify(), "RLS may hide a committed claim from another replica");
  await f.inspect`ALTER TABLE web_refresh_coordination DISABLE ROW LEVEL SECURITY`;
  await f.inspect`ALTER TABLE web_refresh_coordination ALTER COLUMN sealed_result TYPE varchar(22000)`;
  await assert.rejects(f.store.verify(), "schema drift must not silently bypass the storage contract");
});

test("PostgreSQL: crash-discarded tables and enabled rewrite hooks cannot masquerade as durable claims", options, async t => {
  const f = await createSharedRefreshFixture(); t.after(() => f.cleanup());
  await f.inspect`ALTER TABLE web_refresh_coordination SET UNLOGGED`;
  await assert.rejects(f.store.verify(), "UNLOGGED rows vanish after a crash and could replay a spent credential");
  await f.inspect`ALTER TABLE web_refresh_coordination SET LOGGED`;
  await f.inspect.unsafe("CREATE FUNCTION suppress_refresh_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$");
  await f.inspect.unsafe("CREATE TRIGGER suppress_refresh_claim BEFORE INSERT ON web_refresh_coordination FOR EACH ROW EXECUTE FUNCTION suppress_refresh_claim()");
  await assert.rejects(f.store.verify(), "an enabled application trigger can hide or redirect a committed fence");
  await f.inspect.unsafe("DROP TRIGGER suppress_refresh_claim ON web_refresh_coordination");
  await f.inspect.unsafe("ALTER TABLE web_refresh_coordination DROP CONSTRAINT web_refresh_coordination_pkey");
  await f.inspect.unsafe("ALTER TABLE web_refresh_coordination ADD PRIMARY KEY (namespace, generation_key) DEFERRABLE INITIALLY DEFERRED");
  await assert.rejects(f.store.verify(), "a deferred uniqueness contract is not the immediate claim key contract");
});

test("PostgreSQL: a namespace cannot split one API family across different upstream aliases", options, async t => {
  const f = await createSharedRefreshFixture(); t.after(() => f.cleanup());
  await f.store.claim(key, randomUUID(), "https://api.example.test/api/v1/auth/refresh");
  await assert.rejects(f.store.claim("d".repeat(64), randomUUID(), "https://api-alias.example.test/api/v1/auth/refresh"),
    "different hash keys for two aliases of the same API must never spend the same one-time credential twice");
  const rows = await f.inspect`SELECT generation_key FROM web_refresh_coordination`;
  assert.equal(rows.length, 1);
});


test("PostgreSQL: API call budgets do not become shorter whole-coordination deadlines", options, async t => {
  const f = await createSharedRefreshFixture(); t.after(() => f.cleanup());
  const coordinator = new PostgresRefreshCoordinator({ settings: f.settings, codec: f.codec, store: f.store });
  t.after(() => coordinator.close()); await coordinator.start();
  const response = await handleAuthRequest(new Request("https://web.example.test/api/auth/refresh", {
    method: "POST", headers: { origin: "https://web.example.test", cookie: "nw_refresh=" + "z".repeat(43) },
  }), "refresh", { apiBaseUrl: "https://api.example.test", upstreamTimeoutMs: 50, refreshCoordinator: coordinator,
    fetchImpl: async () => new Promise<Response>(() => {}) });
  assert.equal(response.status, 504, "a 50 ms API deadline begins after the committed claim, not before queueing and database work");
  assert.equal((await response.json()).error.code, "UPSTREAM_TIMEOUT");
  assert.deepEqual(response.headers.getSetCookie(), []);
});


test("PostgreSQL: a least-privilege runtime overrides asynchronous role defaults before acknowledging a claim", options, async t => {
  const f = await createSharedRefreshFixture(); t.after(() => f.cleanup());
  const role = "nw_refresh_role_" + randomUUID().replaceAll("-", "");
  const password = randomUUID();
  const [schema] = await f.inspect`SELECT current_schema() AS name`;
  // Both literals are locally generated UUIDs, never user-supplied SQL.
  await f.inspect.unsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
  let store: PostgresRefreshStore | undefined;
  try {
    await f.inspect`ALTER ROLE ${f.inspect(role)} SET synchronous_commit TO off`;
    await f.inspect`GRANT USAGE ON SCHEMA ${f.inspect(String(schema!.name))} TO ${f.inspect(role)}`;
    await f.inspect`GRANT SELECT ON web_refresh_coordinator_policy TO ${f.inspect(role)}`;
    await f.inspect`GRANT UPDATE(upstream_fingerprint) ON web_refresh_coordinator_policy TO ${f.inspect(role)}`;
    await f.inspect`GRANT SELECT, INSERT, UPDATE, DELETE ON web_refresh_coordination TO ${f.inspect(role)}`;
    await f.inspect.unsafe("ALTER TABLE web_refresh_coordination ADD CONSTRAINT require_synchronous_claim CHECK (current_setting('synchronous_commit') = 'on')");
    const url = new URL(f.env.WEB_REFRESH_DATABASE_URL); url.username = role; url.password = password;
    const raw = postgres(url.toString(), { max: 1, onnotice: () => {} });
    try { const [setting] = await raw`SELECT current_setting('synchronous_commit') AS value`; assert.equal(setting!.value, "off"); }
    finally { await raw.end({ timeout: 1 }); }
    store = new PostgresRefreshStore(resolveRefreshSettings({ ...f.env, WEB_REFRESH_DATABASE_URL: url.toString() }), f.codec.fingerprint);
    await store.verify();
    assert.equal((await store.claim(key, randomUUID(), endpoint)).owner, true);
  } finally {
    await store?.close();
    await f.inspect`DROP OWNED BY ${f.inspect(role)}`;
    await f.inspect`DROP ROLE ${f.inspect(role)}`;
  }
});

test("PostgreSQL: real operator CLI migration/check/status/sweep emit only bounded sanitized results", options, async t => {
  const f = await createSharedRefreshFixture(); t.after(() => f.cleanup());
  const cli = fileURLToPath(new URL("../refresh/command.ts", import.meta.url));
  for (const command of ["migrate", "check", "status", "sweep"]) {
    const result = await promisify(execFile)(process.execPath, [cli, command], { env: { ...process.env, ...f.env }, timeout: 8000 });
    assert.equal(result.stderr, ""); const report = JSON.parse(result.stdout);
    assert.match(report.event, /^web_refresh_/);
    if (command === "status") { assert.equal(report.entries, 0); assert.equal(report.pending, 0); }
    if (command === "sweep") { assert.equal(report.converged, true); assert.equal(report.removed, 0); }
    assert.ok(!result.stdout.includes(f.env.WEB_REFRESH_DATABASE_URL) && !result.stdout.includes(f.env.WEB_REFRESH_ENCRYPTION_KEY));
  }
  await assert.rejects(promisify(execFile)(process.execPath, [cli, "check"], {
    env: { ...process.env, ...f.env, WEB_REFRESH_ENCRYPTION_KEY: "private-cli-canary" }, timeout: 8000,
  }), error => {
    const failure = error as Error & { stderr: string; stdout: string };
    assert.match(failure.stderr, /Web refresh command failed/);
    assert.doesNotMatch(failure.stderr + failure.stdout, /private-cli-canary|postgres:\/\//);
    return true;
  });
});
