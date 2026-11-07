import assert from "node:assert/strict";
import test from "node:test";
import { DIAGNOSTIC_MAX_LENGTH, redactDiagnostic, secretValues } from "./log-redaction.ts";

/**
 * What a diagnostic log line may contain (audit F-21).
 *
 * The startup failure line and `rest_unhandled_error` both quote a driver
 * message, because "the access log says 500 and nothing else" is not
 * diagnosable. These tests pin the other half: the message is *useful*, not
 * *verbatim* — a DSN's password, a `password=` pair and the process's own secrets
 * never reach it.
 */

test("a DSN in a driver message loses its password and keeps everything else", () => {
  const message = "connect failed for postgres://writer:hunter2@db.internal:5432/no_wave?sslmode=require";
  const redacted = redactDiagnostic(message);
  assert.equal(redacted, "connect failed for postgres://<redacted>@db.internal:5432/no_wave?sslmode=require");
  assert.equal(redacted?.includes("hunter2"), false);
  // The host and database stay: they are what makes the line worth writing.
  assert.match(redacted ?? "", /db\.internal:5432\/no_wave/);
});

test("every scheme with userinfo is treated the same way", () => {
  for (const scheme of ["postgresql", "postgres", "redis", "https", "amqp"]) {
    const redacted = redactDiagnostic(`${scheme}://user:pw@host/x`);
    assert.equal(redacted, `${scheme}://<redacted>@host/x`, scheme);
  }
});

test("key/value credentials in a message are masked too", () => {
  assert.equal(redactDiagnostic("login failed password=hunter2"), "login failed password=<redacted>");
  assert.equal(redactDiagnostic("token: abc123"), "token: <redacted>");
  assert.equal(redactDiagnostic("api_key = \"quoted secret\""), "api_key = <redacted>");
  // Nothing secret-shaped: left alone.
  assert.equal(redactDiagnostic("relation \"articles\" does not exist"), "relation \"articles\" does not exist");
});

test("a value the process holds as a secret is masked wherever it appears", () => {
  const secrets = ["s3cr3t-bucket-key-value", "short"];
  const message = "S3 rejected s3cr3t-bucket-key-value for bucket no-wave; short is ignored";
  const redacted = redactDiagnostic(message, { secrets });
  assert.equal(redacted?.includes("s3cr3t-bucket-key-value"), false);
  assert.match(redacted ?? "", /S3 rejected <redacted> for bucket no-wave/);
  // A value too short to be a secret is not replaced everywhere it appears.
  assert.match(redacted ?? "", /short is ignored/);
});

test("only the variables the API actually reads are collected as secrets", () => {
  const values = secretValues({
    DATABASE_URL: "postgres://writer:hunter2@db.internal/no_wave",
    AUTH_JWT_SECRET: "a-perfectly-long-test-secret-value",
    MAIL_SMTP_PASSWORD: "short", // below the minimum: not collected
    PORT: "4000",
    UNRELATED: "do-not-collect-this-value",
  });
  assert.deepEqual(values, [
    "postgres://writer:hunter2@db.internal/no_wave",
    "a-perfectly-long-test-secret-value",
  ]);
});

test("a multi-line message becomes one line, and a long one is capped", () => {
  const oneLine = redactDiagnostic("first line\nsecond\tline   third");
  assert.equal(oneLine, "first line second line third");
  assert.equal(oneLine?.includes("\n"), false);

  const long = redactDiagnostic("x".repeat(5000));
  assert.equal(long?.length, DIAGNOSTIC_MAX_LENGTH);
  assert.equal(redactDiagnostic("x".repeat(5000), { maxLength: 20 })?.length, 20);
});

test("nothing worth logging produces no field at all", () => {
  assert.equal(redactDiagnostic(undefined), null);
  assert.equal(redactDiagnostic({ message: "an object" }), null);
  assert.equal(redactDiagnostic(42), null);
  assert.equal(redactDiagnostic(""), null);
  assert.equal(redactDiagnostic("   \n  "), null);
  assert.equal(redactDiagnostic("secret=hunter2"), "secret=<redacted>", "not empty after redaction");
});
