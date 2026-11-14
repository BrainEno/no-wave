import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isolatedEnvironment, shouldRunIsolated } from "./e2e-runner.ts";

test("a full local run uses three disposable stacks, but targeted or external runs retain Playwright behavior", () => {
  assert.equal(shouldRunIsolated([], {}), true);
  assert.equal(shouldRunIsolated(["--grep", "save"], {}), false);
  assert.equal(shouldRunIsolated([], { E2E_WEB_URL: "https://external.example" }), false);
  assert.equal(shouldRunIsolated([], { E2E_API_BASE_URL: "https://external.example" }), false);
});

test("the isolated stack cannot inherit a developer's database, mail, media or port settings", () => {
  const environment = isolatedEnvironment({
    PATH: "/bin",
    HOME: "/home/test",
    PLAYWRIGHT_BROWSERS_PATH: "/tmp/browsers",
    LD_LIBRARY_PATH: "/tmp/libs",
    DATABASE_URL: "postgres://external.example/production",
    AUTH_REGISTER_IP_LIMIT: "9999",
    API_BASE_URL: "https://external.example",
    API_PORT: "9999",
    MAIL_HOST: "mail.example",
    MEDIA_S3_BUCKET: "not-a-test-bucket",
  }, {
    databasePath: "/tmp/disposable-e2e.sqlite",
    apiPort: 41234,
    webPort: 41235,
    secret: "test-secret-with-at-least-thirty-two-bytes",
  });
  assert.equal(environment.DATABASE_PROVIDER, "sqlite");
  assert.equal(environment.DATABASE_PATH, "/tmp/disposable-e2e.sqlite");
  assert.equal(environment.DATABASE_URL, undefined);
  assert.equal(environment.MEDIA_S3_BUCKET, undefined);
  assert.equal(environment.MAIL_HOST, undefined);
  assert.equal(environment.API_PORT, undefined);
  assert.equal(environment.PORT, "41234");
  assert.equal(environment.API_BASE_URL, "http://127.0.0.1:41234");
  assert.equal(environment.E2E_API_BASE_URL, environment.API_BASE_URL);
  assert.equal(environment.E2E_WEB_URL, "http://127.0.0.1:41235");
  assert.equal(environment.E2E_ISOLATED_STACK, "1");
  assert.equal(environment.AUTH_REGISTER_IP_LIMIT, "80");
  assert.equal(environment.PLAYWRIGHT_BROWSERS_PATH, "/tmp/browsers");
  assert.equal(environment.LD_LIBRARY_PATH, "/tmp/libs");
});

test("CI shards and local disposable stacks use the same finite multi-account registration budget", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const e2eJob = workflow.slice(workflow.indexOf("  e2e:"), workflow.indexOf("  react-router-prototype:"));
  const environment = isolatedEnvironment({}, {
    databasePath: "/tmp/disposable-budget.sqlite", apiPort: 41234, webPort: 41235,
    secret: "test-secret-with-at-least-thirty-two-bytes",
  });
  assert.equal(environment.AUTH_REGISTER_IP_LIMIT, "80", "new independent account-switch journeys exceed the old 60/IP fixture budget");
  assert.match(e2eJob, new RegExp(`AUTH_REGISTER_IP_LIMIT: "${environment.AUTH_REGISTER_IP_LIMIT}"`));
  assert.doesNotMatch(e2eJob, /continue-on-error|AUTH_REGISTER_IP_LIMIT: "9999"/);
});
