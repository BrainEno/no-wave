import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { isMainModule } from "./entrypoint.ts";
import { apiHttpSettings, integerSetting, readinessSettings, serviceRole, shutdownSettings, workerHealthSettings } from "./service-settings.ts";

test("operational settings reject ambiguous numbers and never reproduce untrusted environment contents", () => {
  for (const value of ["-1", "+100", "1.5", "1e3", "0x100", " 100", "100 ", "NaN", "Infinity", "private-setting-canary", "9007199254740992"]) {
    assert.throws(() => integerSetting({ TEST_SETTING: value }, "TEST_SETTING", 100, 1, 1000), error => {
      assert.ok(error instanceof RangeError);
      assert.match(error.message, /TEST_SETTING/);
      assert.doesNotMatch(error.message, /private-setting-canary/);
      return true;
    });
  }
  assert.equal(integerSetting({}, "TEST_SETTING", 100, 1, 1000), 100);
  assert.equal(integerSetting({ TEST_SETTING: "001" }, "TEST_SETTING", 100, 1, 1000), 1);
  assert.throws(() => integerSetting({ TEST_SETTING: "0" }, "TEST_SETTING", 100, 1, 1000));
});

test("HTTP, readiness, worker role and shutdown budgets have bounded defaults and reject inconsistent relationships", () => {
  assert.deepEqual(apiHttpSettings({}), { headersTimeout: 15_000, requestTimeout: 60_000, keepAliveTimeout: 5000 });
  assert.deepEqual(readinessSettings({}), { timeoutMs: 500, cacheMs: 1000, maxPendingAgeMs: 120_000 });
  assert.deepEqual(shutdownSettings({}), { deadlineMs: 8000, cleanupMs: 2000 });
  assert.deepEqual(shutdownSettings({ SHUTDOWN_GRACE_MS: "100" }), { deadlineMs: 100, cleanupMs: 25 });
  assert.throws(() => shutdownSettings({ SHUTDOWN_GRACE_MS: "100", SHUTDOWN_CLEANUP_MS: "100" }));
  assert.throws(() => apiHttpSettings({ API_HEADERS_TIMEOUT_MS: "200", API_REQUEST_TIMEOUT_MS: "100" }));
  assert.throws(() => apiHttpSettings({ API_REQUEST_TIMEOUT_MS: "600001" }));
  assert.throws(() => readinessSettings({ API_OUTBOX_MAX_PENDING_AGE_MS: "999" }));
  assert.equal(serviceRole({}), "api");
  assert.equal(serviceRole({ SERVICE_ROLE: "notification-worker" }), "notification-worker");
  assert.throws(() => serviceRole({ SERVICE_ROLE: "private-role-canary" }), error => {
    assert.ok(error instanceof RangeError); assert.doesNotMatch(error.message, /private-role-canary/); return true;
  });
  assert.equal(workerHealthSettings({}).enabled, false);
  assert.deepEqual(workerHealthSettings({ SERVICE_ROLE: "notification-worker" }), { enabled: true, host: "127.0.0.1", port: 4001 });
  assert.equal(workerHealthSettings({ OUTBOX_HEALTH_PORT: "0" }).port, 0);
  for (const host of ["", "localhost/path", "host?query", "host#fragment", "127.0.0.1 private-canary"]) {
    assert.throws(() => workerHealthSettings({ OUTBOX_HEALTH_HOST: host }), /listen address/);
  }
});

test("entry detection recognizes encoded POSIX and relative paths without confusing an imported module with the executable", () => {
  for (const entry of ["apps/api/src/server.ts", "./apps/api/src/server.ts", "/tmp/编码 #100%/server.ts"]) {
    assert.equal(isMainModule(pathToFileURL(resolve(entry)).href, entry), true, entry);
    assert.equal(isMainModule(pathToFileURL(resolve(entry)).href + "?imported", entry), false);
  }
  assert.equal(isMainModule(import.meta.url, "apps/api/src/server.ts"), false);
  assert.equal(isMainModule(import.meta.url, ""), false);
  assert.equal(isMainModule(import.meta.url, "--test"), false);
  assert.equal(isMainModule("not a URL", "server.ts"), false);
});

test("entry detection handles Windows drive and UNC file URLs on every test platform", () => {
  for (const entry of [String.raw`C:\No Wave\100% #中文\server.ts`, "C:/No Wave/100% #中文/server.ts", String.raw`\\fileserver\share\No Wave\server.ts`]) {
    const url = pathToFileURL(entry, { windows: true }).href;
    assert.equal(isMainModule(url, entry), true, entry);
    assert.equal(isMainModule(url, entry.replace("server.ts", "imported.ts")), false);
  }
});
