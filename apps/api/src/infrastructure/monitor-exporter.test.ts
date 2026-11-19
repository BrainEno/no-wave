import assert from "node:assert/strict";
import test from "node:test";
import { createHttpObservability } from "./http-observability.ts";
import { createApiReadiness } from "./api-readiness.ts";
import { createOutboxMetrics } from "../persistence/outbox-metrics.ts";

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

test("API metrics identify one exporter lifetime without exposing process environment", () => {
  const first = createHttpObservability({ logger() {} });
  const second = createHttpObservability({ logger() {} });
  const pattern = new RegExp(`^api_process_instance_info\\{instance="(${UUID})"\\} 1$`, "m");
  const initial = first.renderMetrics().match(pattern)?.[1];
  assert.ok(initial, "missing lifetime identity must not make a reset counter look continuous");
  assert.equal(first.renderMetrics().match(pattern)?.[1], initial);
  assert.notEqual(second.renderMetrics().match(pattern)?.[1], initial);
});

test("worker metrics identify each independently restarted exporter", () => {
  const first = createOutboxMetrics();
  const second = createOutboxMetrics();
  const pattern = new RegExp(`^notification_worker_process_instance_info\\{instance="(${UUID})"\\} 1$`, "m");
  const initial = first.render().match(pattern)?.[1];
  assert.ok(initial);
  assert.equal(first.render().match(pattern)?.[1], initial);
  assert.notEqual(second.render().match(pattern)?.[1], initial);
});

test("a reachable metrics endpoint distinguishes database failure from notification failure", async t => {
  let healthy = false;
  const readiness = createApiReadiness({
    env: { AUTH_JWT_SECRET: "test-monitor-issuer-material-not-a-real-secret", AUTH_JWT_ISSUER: "monitor-test", AUTH_JWT_AUDIENCE: "monitor-test", API_READINESS_CACHE_MS: "0" },
    services: { health: () => healthy, outboxBacklog: () => ({ pendingEvents: 0, deadLetterEvents: 0, oldestPendingAgeMs: 0 }) },
  });
  t.after(() => readiness.close());
  assert.match(await readiness.renderMetrics(), /^api_persistence_available 0$/m);
  healthy = true;
  assert.match(await readiness.renderMetrics(), /^api_persistence_available 1$/m);
});
