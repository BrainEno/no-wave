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
  metrics.recordBacklog({ pendingEvents: 12, deadLetterEvents: 4, oldestPendingAgeMs: 93000 });
  const first = metrics.render();
  assert.match(first, /api_outbox_pending_events 12/);
  assert.match(first, /api_outbox_dead_letter_events 4/);
  assert.match(first, /api_outbox_oldest_pending_age_seconds 93\.000/);
  assert.match(first, /api_outbox_backlog_sample_timestamp_seconds [1-9][0-9]*/);

  metrics.recordBacklogReadFailure();
  const second = metrics.render();
  assert.match(second, /api_outbox_pending_events 12/);
  assert.match(second, /api_outbox_dead_letter_events 4/);
  assert.match(second, /api_outbox_oldest_pending_age_seconds 93\.000/);
  assert.match(second, /api_outbox_backlog_read_failures_total 1/);
});

test("outbox metric output has fixed labels and never includes event payloads or identifiers", () => {
  const metrics = createOutboxMetrics();
  metrics.recordBatch({ claimed: 1, delivered: 1, failed: 0 }, 10);
  metrics.recordBacklog({ pendingEvents: 1, deadLetterEvents: 0, oldestPendingAgeMs: 1 });
  const exposition = metrics.render();
  assert.doesNotMatch(exposition, /eventId|conversationId|payload|authorization|userId/);
});


test("outbox backlog metrics sanitize invalid counts independently and retain zero as a real sample", () => {
  const metrics = createOutboxMetrics();
  metrics.recordBacklog({ pendingEvents: 3, deadLetterEvents: 7, oldestPendingAgeMs: 12000 });
  metrics.recordBacklog({ pendingEvents: NaN, deadLetterEvents: -1, oldestPendingAgeMs: Infinity });
  assert.match(metrics.render(), /^api_outbox_pending_events 0$/m);
  assert.match(metrics.render(), /^api_outbox_dead_letter_events 0$/m);
  assert.match(metrics.render(), /^api_outbox_oldest_pending_age_seconds 0\.000$/m);
  metrics.recordBacklog({ pendingEvents: 1, deadLetterEvents: 2.5, oldestPendingAgeMs: -10 });
  assert.match(metrics.render(), /^api_outbox_pending_events 1$/m);
  assert.match(metrics.render(), /^api_outbox_dead_letter_events 0$/m);
  assert.doesNotMatch(metrics.render(), /NaN|Infinity|event_id|event_key/);
});
