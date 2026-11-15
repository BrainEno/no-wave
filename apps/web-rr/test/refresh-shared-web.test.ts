import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createApiServer } from "../../api/src/server.ts";
import { signAccessToken } from "../../api/src/security/authentication.ts";
import { createRefreshQuotaFixture } from "../../api/src/persistence/test-support/refresh-quota-fixture.ts";
import { createSharedRefreshFixture } from "./support/shared-refresh-store.ts";
import { callFrom, closeServer, listen, FIRST_CLIENT } from "./support/client-address-stack.ts";
import { startProductionWeb } from "./support/production-web.ts";

const options = { timeout: 45_000, skip: !process.env.TEST_DATABASE_URL && "Set TEST_DATABASE_URL for two real Web processes sharing PostgreSQL coordination." };
function deferred() { let resolve!: () => void; return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() }; }
function cookie(headers: Headers, name: string) { return headers.getSetCookie().find(value => value.startsWith(name + "="))?.split(";")[0]?.slice(name.length + 1); }
function expiredAccess(f: Awaited<ReturnType<typeof createRefreshQuotaFixture>>) {
  const now = Math.floor(Date.now() / 1000);
  return signAccessToken({ subject: f.userId, tokenId: f.initial.accessTokenId, sessionId: f.initial.sessionId, issuedAt: now - 600, expiresAt: now - 60, env: f.env });
}

for (const provider of ["sqlite", "postgres"] as const) {
  test(`${provider}: two production Web processes share explicit/automatic refresh without revoking the API family`, options, async t => {
    const f = await createRefreshQuotaFixture(provider); t.after(() => f.cleanup());
    const coordination = await createSharedRefreshFixture(); t.after(() => coordination.cleanup());
    const entered = deferred(), release = deferred(); let rotations = 0;
    const api = createApiServer({ env: f.env, logger: () => {}, store: { ...f.store, async rotateIdentityRefresh(input) {
      rotations++; entered.resolve(); await release.promise; return f.store.rotateIdentityRefresh(input);
    } } }); t.after(() => closeServer(api));
    const origin = await listen(api);
    const env = { ...coordination.env, API_BASE_URL: origin, API_TIMEOUT_MS: "5000", BFF_CLIENT_ADDRESS_SECRET: "" };
    const one = await startProductionWeb(env), two = await startProductionWeb(env); t.after(() => Promise.all([one.close(), two.close()]));
    const refreshOnly = `nw_refresh=${f.initial.refreshToken}`, full = `nw_access=${expiredAccess(f)}; ${refreshOnly}`;
    try {
      const explicit = callFrom(one.origin, FIRST_CLIENT, "/api/auth/refresh", { headers: { cookie: refreshOnly } });
      await entered.promise;
      const automatic = callFrom(two.origin, FIRST_CLIENT, "/api/authoring/session", { method: "GET", headers: { cookie: full } });
      const absentAccess = callFrom(one.origin, FIRST_CLIENT, "/api/authoring/session", { method: "GET", headers: { cookie: refreshOnly } });
      release.resolve();
      const results = await Promise.all([explicit, automatic, absentAccess]);
      assert.deepEqual(results.map(value => value.status), [200, 200, 200]); assert.equal(rotations, 1);
      const nextRefresh = cookie(results[0]!.headers, "nw_refresh"), nextAccess = cookie(results[0]!.headers, "nw_access");
      assert.ok(nextRefresh && nextAccess); assert.notEqual(nextRefresh, f.initial.refreshToken);
      for (const result of results) {
        assert.equal(cookie(result.headers, "nw_refresh"), nextRefresh); assert.equal(cookie(result.headers, "nw_access"), nextAccess);
        assert.equal(result.headers.getSetCookie().length, 3); assert.match(result.headers.get("cache-control") ?? "", /no-store/);
        assert.ok(!result.text.includes(nextRefresh) && !result.text.includes(nextAccess));
      }
      const late = await callFrom(two.origin, FIRST_CLIENT, "/api/auth/refresh", { headers: { cookie: refreshOnly } });
      assert.equal(late.status, 200); assert.equal(cookie(late.headers, "nw_refresh"), nextRefresh); assert.equal(rotations, 1);
      assert.equal((await f.refreshRows()).length, 2);
      assert.equal((await f.buckets()).find(row => row.key === f.rateKey("refresh:session", f.initial.sessionId))?.attempts, 1);
      const current = await callFrom(two.origin, FIRST_CLIENT, "/api/authoring/session", { method: "GET", headers: { cookie: `nw_access=${nextAccess}; nw_refresh=${nextRefresh}` } });
      assert.equal(current.status, 200); assert.equal(JSON.parse(current.text).data.id, f.userId);
      const [stored] = await coordination.inspect`SELECT * FROM web_refresh_coordination`;
      assert.equal(stored!.state, "resolved"); assert.ok(!JSON.stringify(stored).includes(nextRefresh) && !JSON.stringify(stored).includes(nextAccess));
      assert.deepEqual(await (await fetch(two.origin + "/readyz")).json(), { ready: true, mode: "postgres", status: "ready" });
      for (const log of [one.output(), two.output()]) assert.ok(!log.includes(nextRefresh) && !log.includes(nextAccess) && !log.includes(coordination.env.WEB_REFRESH_ENCRYPTION_KEY));
    } finally { release.resolve(); }
  });
}

test("a real Web winner killed after API commit cannot cause another replica to replay or revoke the family", options, async t => {
  const f = await createRefreshQuotaFixture("sqlite"); t.after(() => f.cleanup());
  const coordination = await createSharedRefreshFixture({ WEB_REFRESH_ROTATION_TIMEOUT_MS: "600" }); t.after(() => coordination.cleanup());
  const committed = deferred(), release = deferred(); let rotations = 0, accessId = "";
  const api = createApiServer({ env: f.env, logger: () => {}, store: { ...f.store, async rotateIdentityRefresh(input) {
    rotations++; const result = await f.store.rotateIdentityRefresh(input); accessId = input.accessTokenId; committed.resolve(); await release.promise; return result;
  } } }); t.after(() => closeServer(api));
  const env = { ...coordination.env, API_BASE_URL: await listen(api), API_TIMEOUT_MS: "5000", BFF_CLIENT_ADDRESS_SECRET: "" };
  const one = await startProductionWeb(env), two = await startProductionWeb(env); t.after(() => Promise.all([one.close(), two.close()]));
  const winning = callFrom(one.origin, FIRST_CLIENT, "/api/auth/refresh", { headers: { cookie: `nw_refresh=${f.initial.refreshToken}` } }).catch(() => null);
  try {
    await committed.promise; assert.equal(one.signal("SIGKILL"), true); await winning;
    await delay(650);
    const after = await callFrom(two.origin, FIRST_CLIENT, "/api/auth/refresh", { headers: { cookie: `nw_refresh=${f.initial.refreshToken}` } });
    assert.equal(after.status, 503); assert.equal(JSON.parse(after.text).error.code, "REFRESH_UNCERTAIN");
    assert.deepEqual(after.headers.getSetCookie(), []); assert.equal(rotations, 1);
    assert.equal(await f.store.isSessionRevoked(accessId), false);
    assert.equal((await f.refreshRows()).length, 2); assert.equal(await coordination.store.sweep(), 0);
    const [row] = await coordination.inspect`SELECT state, sealed_result FROM web_refresh_coordination`;
    assert.equal(row!.state, "uncertain"); assert.equal(row!.sealed_result, null);
  } finally { release.resolve(); await winning; }
});

test("the actual production entry refuses a declared memory replica set before listening", { timeout: 10_000 }, async () => {
  const child = spawn(process.execPath, ["server.ts"], { cwd: new URL("../", import.meta.url),
    env: { ...process.env, WEB_INSTANCE_COUNT: "2", WEB_REFRESH_COORDINATOR: "memory", PORT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", chunk => { output += chunk.toString(); }); child.stderr.on("data", chunk => { output += chunk.toString(); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try { assert.deepEqual(await once(child, "close"), [1, null]); assert.match(output, /shared postgres/); assert.doesNotMatch(output, /server_listening/); }
  finally { clearTimeout(timer); }
});

async function until(assertion: () => Promise<boolean>, maximumMs = 12_000) {
  const deadline = performance.now() + maximumMs;
  do { if (await assertion()) return; await delay(100); } while (performance.now() < deadline);
  assert.fail("The expected periodic runtime transition did not occur within its bounded window.");
}

test("production readiness/metrics expose cached samples, recover schema faults and drain without credentials", options, async t => {
  const coordination = await createSharedRefreshFixture(); t.after(() => coordination.cleanup());
  const metricsToken = "fixture-only-metrics-credential-0123456789abcdef";
  const web = await startProductionWeb({ ...coordination.env, WEB_REFRESH_METRICS_TOKEN: metricsToken });
  t.after(() => web.close());
  const metrics = () => fetch(web.origin + "/internal/refresh-metrics", { headers: { authorization: `Bearer ${metricsToken}` } });
  assert.equal((await fetch(web.origin + "/internal/refresh-metrics")).status, 401);
  const first = await metrics(); assert.equal(first.status, 200); const firstText = await first.text(); assert.match(firstText, /web_refresh_coordination_storage_available 1/);
  assert.equal(await (await metrics()).text(), firstText, "scraping alone must not replace the cached database-clock sample");
  await coordination.inspect`ALTER TABLE web_refresh_coordination ENABLE ROW LEVEL SECURITY`;
  await until(async () => (await fetch(web.origin + "/readyz")).status === 503);
  assert.match(await (await metrics()).text(), /web_refresh_coordination_storage_available 0/);
  assert.equal((await fetch(web.origin + "/healthz")).status, 200, "a database outage is not a process-liveness failure");
  await coordination.inspect`ALTER TABLE web_refresh_coordination DISABLE ROW LEVEL SECURITY`;
  await until(async () => (await fetch(web.origin + "/readyz")).status === 200);
  const text = await (await metrics()).text(); assert.match(text, /web_refresh_coordination_storage_available 1/);
  assert.ok(!text.includes(metricsToken) && !text.includes(coordination.env.WEB_REFRESH_ENCRYPTION_KEY));
  await web.close();
  const completed = web.output().split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line))
    .find(line => line.event === "server_shutdown_complete");
  assert.ok(completed); assert.equal(completed.coordinationDrained, true); assert.equal(completed.forced, false);
  assert.ok(!web.output().includes(metricsToken) && !web.output().includes(coordination.env.WEB_REFRESH_DATABASE_URL));
});

test("a disconnected production caller cannot cancel a sibling's shared refresh", options, async t => {
  const f = await createRefreshQuotaFixture("sqlite"); t.after(() => f.cleanup());
  const coordination = await createSharedRefreshFixture(); t.after(() => coordination.cleanup());
  const entered = deferred(), release = deferred(); let rotations = 0;
  const api = createApiServer({ env: f.env, logger: () => {}, store: { ...f.store, async rotateIdentityRefresh(input) {
    rotations++; entered.resolve(); await release.promise; return f.store.rotateIdentityRefresh(input);
  } } }); t.after(() => closeServer(api));
  const web = await startProductionWeb({ ...coordination.env, API_BASE_URL: await listen(api), API_TIMEOUT_MS: "5000", BFF_CLIENT_ADDRESS_SECRET: "" });
  t.after(() => web.close()); const controller = new AbortController();
  const url = web.origin + "/api/auth/refresh", headers = { origin: web.origin, cookie: `nw_refresh=${f.initial.refreshToken}` };
  const canceled = fetch(url, { method: "POST", headers, signal: controller.signal });
  const rejected = assert.rejects(canceled);
  try {
    await entered.promise; controller.abort(); await rejected;
    const sibling = fetch(url, { method: "POST", headers }); release.resolve();
    const result = await sibling; assert.equal(result.status, 200); await result.body?.cancel();
    assert.equal(rotations, 1); assert.ok(cookie(result.headers, "nw_refresh"));
    assert.equal(await f.store.isSessionRevoked(f.initial.accessTokenId), false);
  } finally { controller.abort(); release.resolve(); await rejected; }
});

test("Vite's real native ingress and production SSR share the injected PostgreSQL coordinator", options, async t => {
  const f = await createRefreshQuotaFixture("sqlite"); t.after(() => f.cleanup());
  const coordination = await createSharedRefreshFixture(); t.after(() => coordination.cleanup());
  let rotations = 0;
  const api = createApiServer({ env: f.env, logger: () => {}, store: { ...f.store, async rotateIdentityRefresh(input) {
    rotations++; return f.store.rotateIdentityRefresh(input);
  } } }); t.after(() => closeServer(api));
  const env = { ...coordination.env, API_BASE_URL: await listen(api), API_TIMEOUT_MS: "5000", BFF_CLIENT_ADDRESS_SECRET: "" };
  const production = await startProductionWeb(env); t.after(() => production.close());
  const dev = spawn(process.execPath, ["test/fixtures/refresh-dev-server.ts"], { cwd: new URL("../", import.meta.url),
    env: { ...process.env, ...env, NODE_ENV: "development", PORT: "0", API_SERVICE_URL: "", API_GRAPHQL_URL: "" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; const exited = once(dev, "close");
  const origin = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("The real Vite fixture did not listen within its startup budget.")), 20_000);
    dev.once("error", error => { clearTimeout(timeout); reject(error); });
    dev.once("exit", () => { clearTimeout(timeout); reject(new Error("The real Vite fixture exited before its ready event.")); });
    dev.stdout.on("data", chunk => {
      output += chunk.toString();
      for (const line of output.split("\n")) {
        if (!line.startsWith('{"event":"refresh_fixture_listening"')) continue;
        const record = JSON.parse(line); clearTimeout(timeout); resolve(`http://127.0.0.1:${record.port}`);
      }
    });
    dev.stderr.on("data", chunk => { output += chunk.toString(); });
  });
  t.after(async () => {
    if (dev.exitCode !== null || dev.signalCode !== null) return;
    const deadline = setTimeout(() => dev.kill("SIGKILL"), 5000); dev.kill("SIGTERM");
    try { await exited; } finally { clearTimeout(deadline); }
  });
  const development = await origin;
  // Compile the actual resource route before presenting a one-time credential.
  const warm = await fetch(development + "/api/auth/refresh", { method: "POST", headers: { origin: development }, signal: AbortSignal.timeout(20_000) });
  assert.equal(warm.status, 401); await warm.body?.cancel();
  const headers = { cookie: `nw_refresh=${f.initial.refreshToken}` };
  const results = await Promise.all([callFrom(development, FIRST_CLIENT, "/api/auth/refresh", { headers }),
    callFrom(production.origin, FIRST_CLIENT, "/api/auth/refresh", { headers })]);
  assert.deepEqual(results.map(result => result.status), [200, 200]); assert.equal(rotations, 1);
  assert.equal(cookie(results[0]!.headers, "nw_refresh"), cookie(results[1]!.headers, "nw_refresh"));
  assert.ok(!output.includes(coordination.env.WEB_REFRESH_ENCRYPTION_KEY));
});
