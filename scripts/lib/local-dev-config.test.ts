import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildLocalEnvFile,
  buildProbeIdentity,
  envTemplateFile,
  evaluateAuthSecret,
  evaluateNodeVersion,
  extractEnvFileKeys,
  extractEnvTemplateKeys,
  loopbackBaseUrl,
  parseCheckArguments,
  parseDevArguments,
  parsePort,
  redactDatabaseUrl,
  resolveLocalDevConfig,
} from "./local-dev-config.ts";

// The local tooling encodes three failure modes that were previously invisible:
// an unsupported Node major, a JWT secret shorter than 32 bytes (surfaced by the
// API only as 503 SERVICE_UNAVAILABLE), and an unusable port setting. These
// tests pin the rules, not the implementation.

test("Node.js support matches the pinned engines range", () => {
  assert.equal(evaluateNodeVersion("v24.16.0").supported, true);
  assert.equal(evaluateNodeVersion("v24.15.0").supported, true);
  assert.equal(evaluateNodeVersion("v24.16.0").message.includes("Release Candidate"), true);
  assert.match(evaluateNodeVersion("v24.10.0").message, /24\.15\.0 or newer/);
  assert.equal(evaluateNodeVersion("v22.22.3").supported, false);
  assert.match(evaluateNodeVersion("v22.22.3").message, /older than the supported 24\.x/);
  assert.equal(evaluateNodeVersion("v26.0.0").supported, false);
  assert.match(evaluateNodeVersion("v26.0.0").message, /newer than the supported 24\.x/);
  assert.equal(evaluateNodeVersion("not-a-version").supported, false);
});

test("AUTH_JWT_SECRET must be at least 32 bytes", () => {
  const missing = evaluateAuthSecret(undefined);
  assert.equal(missing.ok, false);
  assert.equal(missing.issue?.code, "AUTH_SECRET_MISSING");
  assert.match(missing.issue?.remedy ?? "", /setup:local/);

  const short = evaluateAuthSecret("a".repeat(31));
  assert.equal(short.ok, false);
  assert.equal(short.bytes, 31);
  assert.equal(short.issue?.code, "AUTH_SECRET_TOO_SHORT");

  const exact = evaluateAuthSecret("a".repeat(32));
  assert.equal(exact.ok, true);
  assert.equal(exact.bytes, 32);

  // Multi-byte characters count by bytes, matching Buffer.byteLength in the API.
  assert.equal(evaluateAuthSecret("密".repeat(16)).ok, true);
  assert.equal(evaluateAuthSecret("密".repeat(10)).ok, false);
});

test("port settings fall back and report invalid values", () => {
  assert.deepEqual(parsePort(undefined, 4000, "PORT"), { port: 4000 });
  assert.deepEqual(parsePort("  ", 4000, "PORT"), { port: 4000 });
  assert.deepEqual(parsePort("4100", 4000, "PORT"), { port: 4100 });
  const notANumber = parsePort("40 00", 4000, "PORT");
  assert.equal(notANumber.port, 4000);
  assert.equal(notANumber.issue?.code, "INVALID_PORT");
  assert.equal(parsePort("70000", 4000, "PORT").issue?.code, "INVALID_PORT");
  assert.equal(parsePort("0", 4000, "PORT").issue?.code, "INVALID_PORT");
});

test("local config derives loopback URLs and the persistence description", () => {
  const sqlite = resolveLocalDevConfig({ DATABASE_PATH: "data/dev.sqlite", AUTH_JWT_SECRET: "x".repeat(48), PORT: "4100" });
  assert.equal(sqlite.api.baseUrl, loopbackBaseUrl(4100));
  assert.equal(sqlite.api.baseUrl, "http://127.0.0.1:4100");
  assert.equal(sqlite.web.baseUrl, "http://127.0.0.1:3000");
  assert.match(sqlite.persistence.description, /^SQLite \(\/.*apps\/api\/data\/dev\.sqlite\)$/);
  assert.deepEqual(sqlite.issues, []);
  assert.equal(sqlite.auth.configuredBytes, 48);

  const postgres = resolveLocalDevConfig({
    DATABASE_PROVIDER: "postgres",
    DATABASE_URL: "postgres://user:secret-password@127.0.0.1:5432/bot_thk_dev",
    AUTH_JWT_SECRET: "x".repeat(32),
  });
  assert.equal(postgres.persistence.provider, "postgres");
  assert.match(postgres.persistence.description, /^PostgreSQL \(postgres:\/\/user:\*\*\*@127\.0\.0\.1:5432\/bot_thk_dev\)$/);
  // The description is printed to the console, so credentials must never leak.
  assert.equal(postgres.persistence.description.includes("secret-password"), false);

  // A legacy DATABASE_URL without DATABASE_PROVIDER keeps selecting PostgreSQL,
  // matching resolveDatabaseProvider in apps/api.
  const legacy = resolveLocalDevConfig({ DATABASE_URL: "postgres://127.0.0.1:5432/dev", AUTH_JWT_SECRET: "x".repeat(32) });
  assert.equal(legacy.persistence.provider, "postgres");

  const missingSecret = resolveLocalDevConfig({});
  assert.deepEqual(missingSecret.issues.map((issue) => issue.code), ["AUTH_SECRET_MISSING"]);
});

test("database URLs are redacted without becoming unusable", () => {
  assert.equal(
    redactDatabaseUrl("postgres://app:hunter2@db.internal:5432/app?sslmode=require"),
    "postgres://app:***@db.internal:5432/app?sslmode=require",
  );
  assert.equal(redactDatabaseUrl("not a url"), "<unparseable DATABASE_URL>");
  assert.equal(redactDatabaseUrl("postgres://db.internal/app"), "postgres://db.internal/app");
});

test("generated .env.local documents every key it needs in .env.example", async () => {
  const template = await readFile(envTemplateFile, "utf8");
  const documented = new Set(extractEnvTemplateKeys(template));
  for (const provider of ["sqlite", "postgres"] as const) {
    const generated = buildLocalEnvFile({ jwtSecret: "s".repeat(32), provider });
    for (const key of extractEnvFileKeys(generated)) {
      assert.equal(documented.has(key), true, `${key} is generated by setup:local but missing from .env.example`);
    }
    assert.equal(generated.endsWith("\n"), true);
    assert.equal(generated.includes("AUTH_JWT_SECRET="), true);
  }
});

test("generated .env.local selects exactly one persistence provider", () => {
  const sqlite = buildLocalEnvFile({ jwtSecret: "s".repeat(32), provider: "sqlite" });
  assert.match(sqlite, /^DATABASE_PROVIDER=sqlite$/m);
  assert.equal(/^DATABASE_URL=/m.test(sqlite), false);

  const postgres = buildLocalEnvFile({ jwtSecret: "s".repeat(32), provider: "postgres" });
  assert.match(postgres, /^DATABASE_PROVIDER=postgres$/m);
  assert.match(postgres, /^DATABASE_URL=postgres:\/\//m);
  // The integration-test database stays opt-in, so `pnpm test` does not start
  // failing merely because a developer generated a PostgreSQL profile.
  assert.equal(/^TEST_DATABASE_URL=/m.test(postgres), false);
  assert.match(postgres, /^# TEST_DATABASE_URL=postgres:/m);
});

test("dev and check argument parsing rejects unknown options", () => {
  assert.deepEqual(parseDevArguments([]).args, { apiOnly: false, webOnly: false, check: false, exit: false });
  assert.deepEqual(parseDevArguments(["--api-only", "--check"]).args, {
    apiOnly: true,
    webOnly: false,
    check: true,
    exit: false,
  });
  assert.deepEqual(parseDevArguments(["--api-only", "--check", "--exit"]).args, {
    apiOnly: true,
    webOnly: false,
    check: true,
    exit: true,
  });
  assert.match(parseDevArguments(["--api-only", "--web-only"]).error ?? "", /cannot be combined/);
  assert.match(parseDevArguments(["--exit"]).error ?? "", /requires --check/);
  assert.match(parseDevArguments(["--nope"]).error ?? "", /Unknown option/);

  const parsed = parseCheckArguments(["--api-only", "--read-only", "--api-url", "http://127.0.0.1:4100", "--timeout", "5000"]);
  assert.deepEqual(parsed.args, {
    apiOnly: true,
    readOnly: true,
    apiBaseUrl: "http://127.0.0.1:4100",
    timeoutMs: 5000,
  });
  assert.match(parseCheckArguments(["--api-url"]).error ?? "", /requires a value/);
  assert.match(parseCheckArguments(["--timeout", "0"]).error ?? "", /positive integer/);
  assert.match(parseCheckArguments(["--verbose"]).error ?? "", /Unknown option/);
});

test("probe identities are valid and unique per run", () => {
  const first = buildProbeIdentity(new Date("2026-10-29T06:00:00.000Z"), () => 0.5);
  const second = buildProbeIdentity(new Date("2026-10-29T06:00:00.000Z"), () => 0.25);
  assert.match(first.email, /^local-check-\d{14}[a-z0-9]{6}@example\.test$/);
  assert.notEqual(first.email, second.email);
  assert.notEqual(first.slug, second.slug);
  assert.match(first.email, /^[a-z0-9.-]+@[a-z0-9.-]+\.[a-z]{2,}$/);
  // The API rejects registration passwords shorter than 12 characters.
  assert.equal(first.password.length >= 12, true);
  // Article slugs must satisfy ^[a-z0-9]+(?:-[a-z0-9]+)*$.
  assert.match(first.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
});
