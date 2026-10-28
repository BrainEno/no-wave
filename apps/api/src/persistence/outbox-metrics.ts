const HISTOGRAM_BUCKETS_MS = Object.freeze([5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]);

export function createOutboxMetrics() {
  let batches = 0;
  let claimed = 0;
  let delivered = 0;
  let failed = 0;
  let batchFailures = 0;
  let backlogReadFailures = 0;
  let pendingEvents = 0;
  let oldestPendingAgeMs = 0;
  let backlogSampledAt = 0;
  const batchDuration = { count: 0, sum: 0, buckets: HISTOGRAM_BUCKETS_MS.map(() => 0) };

  function observeBatchDuration(durationMs) {
    const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
    batchDuration.count += 1;
    batchDuration.sum += duration;
    HISTOGRAM_BUCKETS_MS.forEach((bound, index) => {
      if (duration <= bound) batchDuration.buckets[index] += 1;
    });
  }

  function recordBatch({ claimed: claimedCount = 0, delivered: deliveredCount = 0, failed: failedCount = 0 }, durationMs) {
    batches += 1;
    claimed += Math.max(0, Number.isFinite(claimedCount) ? claimedCount : 0);
    delivered += Math.max(0, Number.isFinite(deliveredCount) ? deliveredCount : 0);
    failed += Math.max(0, Number.isFinite(failedCount) ? failedCount : 0);
    observeBatchDuration(durationMs);
  }

  function recordBacklog({ pendingEvents: pending, oldestPendingAgeMs: oldestAge }) {
    pendingEvents = Number.isSafeInteger(pending) && pending >= 0 ? pending : 0;
    oldestPendingAgeMs = Number.isFinite(oldestAge) ? Math.max(0, oldestAge) : 0;
    backlogSampledAt = Date.now();
  }

  function recordBatchFailure() { batchFailures += 1; }
  function recordBacklogReadFailure() { backlogReadFailures += 1; }

  function render() {
    const lines = [
      "# HELP api_outbox_batches_total Outbox worker batches attempted.",
      "# TYPE api_outbox_batches_total counter",
      `api_outbox_batches_total ${batches}`,
      "# HELP api_outbox_events_claimed_total Outbox events claimed for delivery.",
      "# TYPE api_outbox_events_claimed_total counter",
      `api_outbox_events_claimed_total ${claimed}`,
      "# HELP api_outbox_events_delivered_total Outbox events successfully marked delivered.",
      "# TYPE api_outbox_events_delivered_total counter",
      `api_outbox_events_delivered_total ${delivered}`,
      "# HELP api_outbox_events_failed_total Outbox event deliveries that scheduled a retry.",
      "# TYPE api_outbox_events_failed_total counter",
      `api_outbox_events_failed_total ${failed}`,
      "# HELP api_outbox_batch_failures_total Unexpected outbox batch or database failures.",
      "# TYPE api_outbox_batch_failures_total counter",
      `api_outbox_batch_failures_total ${batchFailures}`,
      "# HELP api_outbox_backlog_read_failures_total Failed attempts to refresh the outbox backlog snapshot.",
      "# TYPE api_outbox_backlog_read_failures_total counter",
      `api_outbox_backlog_read_failures_total ${backlogReadFailures}`,
      "# HELP api_outbox_pending_events Undelivered outbox rows at the most recent successful sample.",
      "# TYPE api_outbox_pending_events gauge",
      `api_outbox_pending_events ${pendingEvents}`,
      "# HELP api_outbox_oldest_pending_age_seconds Age of the oldest undelivered event at the most recent successful sample.",
      "# TYPE api_outbox_oldest_pending_age_seconds gauge",
      `api_outbox_oldest_pending_age_seconds ${(oldestPendingAgeMs / 1000).toFixed(3)}`,
      "# HELP api_outbox_backlog_sample_timestamp_seconds Unix timestamp of the most recent successful backlog sample.",
      "# TYPE api_outbox_backlog_sample_timestamp_seconds gauge",
      `api_outbox_backlog_sample_timestamp_seconds ${backlogSampledAt / 1000}`,
      "# HELP api_outbox_batch_duration_ms Outbox batch dispatch duration in milliseconds.",
      "# TYPE api_outbox_batch_duration_ms histogram",
    ];
    let cumulative = 0;
    HISTOGRAM_BUCKETS_MS.forEach((bound, index) => {
      cumulative += batchDuration.buckets[index];
      lines.push(`api_outbox_batch_duration_ms_bucket{le="${bound}"} ${cumulative}`);
    });
    lines.push(
      `api_outbox_batch_duration_ms_bucket{le="+Inf"} ${batchDuration.count}`,
      `api_outbox_batch_duration_ms_sum ${batchDuration.sum.toFixed(3)}`,
      `api_outbox_batch_duration_ms_count ${batchDuration.count}`,
    );
    return lines.join("\n") + "\n";
  }

  return Object.freeze({ recordBatch, recordBacklog, recordBatchFailure, recordBacklogReadFailure, render });
}
