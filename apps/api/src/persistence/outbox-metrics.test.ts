import assert from "node:assert/strict";
import test from "node:test";
import { createOutboxMetrics } from "./outbox-metrics.ts";

test("outbox metrics count dispatch outcomes and export cumulative batch latency buckets", () => {
  const metrics = createOutboxMetrics();
  metrics.recordBatch({ claimed: 4, delivered: 3, failed: 1 }, 18);
  metrics.recordBatch({ claimed: 0, delivered: 0, failed: 0 }, 2);
  metrics.recordBatchFailure();

  const exposition = metrics.render();
  assert.match(exposition, /api_outbox_batches_total 2/);
  assert.match(exposition, /api_outbox_events_claimed_total 4/);
  assert.match(exposition, /api_outbox_events_delivered_total 3/);
  assert.match(exposition, /api_outbox_events_failed_total 1/);
  assert.match(exposition, /api_outbox_batch_failures_total 1/);
  assert.match(exposition, /api_outbox_batch_duration_ms_bucket\{le="5"\} 1/);
  assert.match(exposition, /api_outbox_batch_duration_ms_bucket\{le="25"\} 2/);
  assert.match(exposition, /api_outbox_batch_duration_ms_count 2/);
});

test("outbox metrics expose backlog depth and age and preserve last successful sample on failures", () => {
  const metrics = createOutboxMetrics();
  metrics.recordBacklog({ pendingEvents: 12, oldestPendingAgeMs: 93000 });
  const first = metrics.render();
  assert.match(first, /api_outbox_pending_events 12/);
  assert.match(first, /api_outbox_oldest_pending_age_seconds 93\.000/);
  assert.match(first, /api_outbox_backlog_sample_timestamp_seconds [1-9][0-9]*/);

  metrics.recordBacklogReadFailure();
  metrics.recordBacklog({ pendingEvents: -1, oldestPendingAgeMs: Number.NaN });
  const second = metrics.render();
  assert.match(second, /api_outbox_pending_events 0/);
  assert.match(second, /api_outbox_oldest_pending_age_seconds 0\.000/);
  assert.match(second, /api_outbox_backlog_read_failures_total 1/);
});

test("outbox metric output has fixed labels and never includes event payloads or identifiers", () => {
  const metrics = createOutboxMetrics();
  metrics.recordBatch({ claimed: 1, delivered: 1, failed: 0 }, 10);
  metrics.recordBacklog({ pendingEvents: 1, oldestPendingAgeMs: 1 });
  const exposition = metrics.render();
  assert.doesNotMatch(exposition, /eventId|conversationId|payload|authorization|userId/);
});
