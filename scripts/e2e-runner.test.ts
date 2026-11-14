import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isolatedEnvironment, shouldRunIsolated } from "./e2e-runner.ts";

test("a full local run uses four disposable stacks, but targeted or external runs retain Playwright behavior", () => {
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
    BFF_CLIENT_ADDRESS_SECRET: "must-not-be-inherited",
    WEB_TRUSTED_PROXY_HOPS: "5",
    WEB_TRUSTED_PROXY_PEERS: "0.0.0.0/0",
    TRUSTED_PROXY_HOPS: "5",
    API_BASE_URL: "https://external.example",
    API_PORT: "9999",
    MAIL_HOST: "mail.example",
    MEDIA_S3_BUCKET: "not-a-test-bucket",
  }, {
    databasePath: "/tmp/disposable-e2e.sqlite",
    apiPort: 41234,
    webPort: 41235,
    secret: "test-secret-with-at-least-thirty-two-bytes",
    clientAddressSecret: "test-only-bff-client-address-key-different-from-jwt",
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
  assert.equal(environment.BFF_CLIENT_ADDRESS_SECRET, "test-only-bff-client-address-key-different-from-jwt");
  assert.notEqual(environment.BFF_CLIENT_ADDRESS_SECRET, environment.AUTH_JWT_SECRET);
  assert.equal(environment.WEB_TRUSTED_PROXY_HOPS, "0");
  assert.equal(environment.TRUSTED_PROXY_HOPS, "0");
  assert.equal(environment.WEB_TRUSTED_PROXY_PEERS, undefined);
  assert.equal(environment.PLAYWRIGHT_BROWSERS_PATH, "/tmp/browsers");
  assert.equal(environment.LD_LIBRARY_PATH, "/tmp/libs");
});

test("CI shards and local disposable stacks use the same finite multi-account registration budget", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const e2eJob = workflow.slice(workflow.indexOf("  e2e:"), workflow.indexOf("  react-router-prototype:"));
  const environment = isolatedEnvironment({}, {
    databasePath: "/tmp/disposable-budget.sqlite", apiPort: 41234, webPort: 41235,
    secret: "test-secret-with-at-least-thirty-two-bytes",
    clientAddressSecret: "test-only-bff-client-address-key-different-from-jwt",
  });
  assert.equal(environment.AUTH_REGISTER_IP_LIMIT, "80", "new independent account-switch journeys exceed the old 60/IP fixture budget");
  assert.match(e2eJob, new RegExp(`AUTH_REGISTER_IP_LIMIT: "${environment.AUTH_REGISTER_IP_LIMIT}"`));
  assert.doesNotMatch(e2eJob, /continue-on-error|AUTH_REGISTER_IP_LIMIT: "9999"/);
});

test("the full browser inventory has four isolated rate-limit domains in both CI and the local runner", async () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const e2eJob = workflow.slice(workflow.indexOf("  e2e:"), workflow.indexOf("  react-router-prototype:"));
  const shards = e2eJob.match(/shard: \[([^\]]+)\]/)?.[1].split(",").map(Number);
  assert.deepEqual(shards, [1, 2, 3, 4], "131 journeys put more than 30 real article writes in the first of three file-level shards");
  assert.match(e2eJob, /pnpm test:e2e --shard=\$\{\{ matrix\.shard \}\}\/4/);
  const runner = await import("./e2e-runner.ts");
  assert.equal("E2E_SHARD_COUNT" in runner && runner.E2E_SHARD_COUNT, 4);
  const source = readFileSync(new URL("./e2e-runner.ts", import.meta.url), "utf8");
  assert.match(source, /shard <= E2E_SHARD_COUNT/);
  assert.match(source, /--shard=\$\{shard\}\/\$\{E2E_SHARD_COUNT\}/);
  assert.doesNotMatch(e2eJob, /ARTICLE_CREATE.*LIMIT|continue-on-error/);
});
