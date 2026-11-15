import assert from "node:assert/strict";
import test from "node:test";
import { productionStartupDiagnostics } from "./support/production-web.ts";
import { resolveRefreshSettings } from "../refresh/settings.ts";

const shared = { WEB_REFRESH_COORDINATOR: "postgres", WEB_INSTANCE_COUNT: "2", WEB_REFRESH_DATABASE_URL: "postgres://fixture@127.0.0.1/fixture", WEB_REFRESH_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url") };

test("one Web process defaults to memory, but a declared replica set cannot silently use it", () => {
  assert.equal(resolveRefreshSettings({}).mode, "memory");
  assert.throws(() => resolveRefreshSettings({ WEB_INSTANCE_COUNT: "2" }), /shared|postgres/i);
  assert.throws(() => resolveRefreshSettings({ WEB_INSTANCE_COUNT: "2", WEB_REFRESH_COORDINATOR: "memory" }), /shared|postgres/i);
  assert.equal(resolveRefreshSettings(shared).mode, "postgres");
});

test("shared settings are strict, bounded and never include supplied values in errors", () => {
  for (const [key, value] of Object.entries({ WEB_INSTANCE_COUNT: "2x", WEB_REFRESH_COORDINATOR: "redis", WEB_REFRESH_DATABASE_URL: "https://fixture:private-canary@invalid/secret", WEB_REFRESH_ENCRYPTION_KEY: "private-canary", WEB_REFRESH_NAMESPACE: "unsafe;private-canary", WEB_REFRESH_MAX_ENTRIES: "0", WEB_REFRESH_DRIVER_TIMEOUT_MS: "1", WEB_REFRESH_MAX_PENDING: "999999" })) {
    assert.throws(() => resolveRefreshSettings({ ...shared, [key]: value }), error => error instanceof Error && !error.message.includes("private-canary"), key);
  }
});

test("coordination DSNs cannot override timeouts, load arbitrary key files or smuggle duplicate options", () => {
  for (const query of ["statement_timeout=0", "options=-c%20statement_timeout=0", "sslrootcert=/fixture-private-canary", "sslmode=require&sslmode=disable", "search_path=public%3Bprivate-canary", "sslmode=private-canary", "connect_timeout=0"]) {
    assert.throws(() => resolveRefreshSettings({ ...shared, WEB_REFRESH_DATABASE_URL: shared.WEB_REFRESH_DATABASE_URL + "?" + query }), error => error instanceof Error && !error.message.includes("private-canary"), query);
  }
  assert.throws(() => resolveRefreshSettings({ ...shared, WEB_REFRESH_DATABASE_URL: "postgres://fixture@remote.example.test/database" }));
  assert.equal(resolveRefreshSettings({ ...shared, WEB_REFRESH_DATABASE_URL: "postgres://fixture@remote.example.test/database?sslmode=verify-full" }).mode, "postgres");
});


test("production fixture startup diagnostics preserve fixed categories, never captured private output", () => {
  assert.equal(productionStartupDiagnostics("Error [ERR_MODULE_NOT_FOUND]: private-path-canary\nERR_MODULE_NOT_FOUND"), "ERR_MODULE_NOT_FOUND");
  assert.equal(productionStartupDiagnostics("fixture-secret-canary EADDRINUSE on private-port-canary ENOENT"), "EADDRINUSE,ENOENT");
  assert.equal(productionStartupDiagnostics("private-key-canary unexpected configuration failure"), "unclassified");
});
