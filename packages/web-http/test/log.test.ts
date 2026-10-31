import assert from "node:assert/strict";
import { test } from "node:test";
import { WEB_LOG_COMPONENT, formatLogLine, safeLogPath } from "../src/log.ts";

/**
 * The Web tier's log contract: one event is one line of JSON, and a request is
 * described by its path — never by its query string, because that is where
 * password-reset and email-verification tokens live.
 */

test("a log line is one JSON object with the house shape", () => {
  const line = formatLogLine(
    "server_listening",
    { host: "0.0.0.0", port: 3100 },
    "info",
    "2026-10-31T00:00:00.000Z",
  );
  assert.equal(line.endsWith("\n"), true, "one record per line");
  assert.equal(line.split("\n").filter((part) => part.length > 0).length, 1);
  const record = JSON.parse(line) as Record<string, unknown>;
  assert.equal(record.timestamp, "2026-10-31T00:00:00.000Z");
  assert.equal(record.level, "info");
  assert.equal(record.component, WEB_LOG_COMPONENT);
  assert.equal(record.event, "server_listening");
  assert.equal(record.port, 3100);
});

test("a request is logged as a path, never as a URL", () => {
  assert.equal(safeLogPath("/reset-password?token=TOPSECRET"), "/reset-password");
  assert.equal(safeLogPath("/articles?tag=%E6%8A%97%E8%AE%AE#comments"), "/articles");
  assert.equal(safeLogPath("https://user:password@example.example/verify-email?token=x"), "/verify-email");
  assert.equal(safeLogPath("/"), "/");
  assert.equal(safeLogPath(undefined), "/");
  assert.equal(safeLogPath(""), "/");
  assert.equal(safeLogPath("not a url at all"), "/not%20a%20url%20at%20all");
  assert.equal(safeLogPath("\\"), "/");
});

test("an unbounded path cannot flood the log drain", () => {
  const path = safeLogPath(`/${"a".repeat(4000)}`);
  assert.equal(path.length <= 124, true, `expected a bounded path, got ${path.length} characters`);
  assert.equal(path.endsWith("..."), true);
});

test("a reset token cannot reach a log line", () => {
  const token = "reset-token-supersecret-value";
  const line = formatLogLine("http_request_completed", {
    method: "GET",
    path: safeLogPath(`/reset-password?token=${token}`),
    status: 200,
    durationMs: 3,
  });
  assert.equal(line.includes(token), false);
  assert.equal(line.includes("token="), false);
});
