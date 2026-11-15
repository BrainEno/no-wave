type BatchResult = { claimed: number; delivered: number; failed: number; deadLettered: number };
type Phase = "starting" | "idle" | "delivering" | "stopping" | "stopped";
type Reason = "starting" | "healthy" | "batch_failed" | "batch_overdue" | "stale" | "stopping" | "stopped";
export type WorkerReadiness = {
  status: "ready" | "not_ready";
  service: "notification-worker";
  phase: Phase;
  reason: Reason;
  lastSuccessAt: string | null;
  lastSuccessAgeMs: number | null;
  batchAgeMs: number | null;
  consecutiveFailures: number;
  completedBatches: number;
  lastBatch: BatchResult | null;
};

/** Progress comes from completed durable batches, not from a timer that can
 * keep ticking while delivery is wedged. Monotonic ages survive clock changes. */
export function createWorkerReadiness({
  pollIntervalMs, leaseSeconds, now = performance.now.bind(performance), wallNow = Date.now,
}: { pollIntervalMs: number; leaseSeconds: number; now?: () => number; wallNow?: () => number }) {
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 60_000) throw new RangeError("Invalid worker poll interval.");
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3600) throw new RangeError("Invalid worker lease duration.");
  const idleBudgetMs = Math.max(1000, pollIntervalMs * 3);
  const batchBudgetMs = Math.max(idleBudgetMs, leaseSeconds * 1000);
  let phase: Phase = "starting";
  let startedBatchAt: number | null = null;
  let lastSuccessAt: number | null = null;
  let lastSuccessWallAt: number | null = null;
  let consecutiveFailures = 0;
  let completedBatches = 0;
  let lastBatch: BatchResult | null = null;

  function beginBatch(): void {
    if (phase === "stopping" || phase === "stopped") throw new Error("A stopping worker cannot claim a new batch.");
    if (startedBatchAt !== null) throw new Error("Worker batches must not overlap.");
    startedBatchAt = now();
    phase = "delivering";
  }
  function finishBatch(result: BatchResult): void {
    if (startedBatchAt === null) throw new Error("A worker batch must start before it can complete.");
    for (const value of Object.values(result)) if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Invalid worker batch counts.");
    if (result.delivered + result.failed !== result.claimed || result.deadLettered > result.failed) throw new RangeError("Inconsistent worker batch outcome.");
    completedBatches += 1;
    lastSuccessAt = now();
    lastSuccessWallAt = wallNow();
    lastBatch = { claimed: result.claimed, delivered: result.delivered, failed: result.failed, deadLettered: result.deadLettered };
    startedBatchAt = null;
    consecutiveFailures = 0;
    if (phase !== "stopping" && phase !== "stopped") phase = "idle";
  }
  function failBatch(): void {
    if (startedBatchAt === null) throw new Error("A failed worker batch must have started.");
    consecutiveFailures += 1;
    startedBatchAt = null;
    if (phase !== "stopping" && phase !== "stopped") phase = "idle";
  }
  function stopping(): void {
    if (phase !== "stopped") phase = "stopping";
  }
  function stopped(): void {
    phase = "stopped";
    startedBatchAt = null;
  }
  function snapshot(): WorkerReadiness {
    const current = now();
    const lastSuccessAgeMs = lastSuccessAt === null ? null : Math.max(0, Math.round(current - lastSuccessAt));
    const batchAgeMs = startedBatchAt === null ? null : Math.max(0, Math.round(current - startedBatchAt));
    let reason: Reason;
    if (phase === "stopping" || phase === "stopped") reason = phase;
    else if (batchAgeMs !== null && batchAgeMs > batchBudgetMs) reason = "batch_overdue";
    else if (consecutiveFailures > 0) reason = "batch_failed";
    else if (lastSuccessAt === null) reason = "starting";
    else if (batchAgeMs === null && lastSuccessAgeMs !== null && lastSuccessAgeMs > idleBudgetMs) reason = "stale";
    else reason = "healthy";
    return { status: reason === "healthy" ? "ready" : "not_ready", service: "notification-worker", phase, reason,
      lastSuccessAt: lastSuccessWallAt === null ? null : new Date(lastSuccessWallAt).toISOString(), lastSuccessAgeMs,
      batchAgeMs, consecutiveFailures, completedBatches, lastBatch: lastBatch ? { ...lastBatch } : null };
  }
  function renderMetrics(): string {
    const value = snapshot();
    const gauges: [string, string, number][] = [
      ["notification_worker_ready", "One only when durable batch progress is healthy and the worker is accepting work.", value.status === "ready" ? 1 : 0],
      ["notification_worker_last_success_timestamp_seconds", "Last successful durable batch completion; zero until first success.", (lastSuccessWallAt ?? 0) / 1000],
      ["notification_worker_last_success_age_seconds", "Monotonic age of last successful completion; -1 before first success.", value.lastSuccessAgeMs === null ? -1 : value.lastSuccessAgeMs / 1000],
      ["notification_worker_inflight_batch_age_seconds", "Monotonic duration of the active batch, zero while idle.", (value.batchAgeMs ?? 0) / 1000],
      ["notification_worker_consecutive_batch_failures", "Consecutive batch-level failures since last successful durable batch.", consecutiveFailures],
      ["notification_worker_batch_budget_seconds", "Maximum active batch duration before readiness fails.", batchBudgetMs / 1000],
      ["notification_worker_idle_budget_seconds", "Maximum idle completion gap before readiness fails.", idleBudgetMs / 1000],
    ];
    const lines: string[] = [];
    for (const [name, help, number] of gauges) lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${number}`);
    lines.push("# HELP notification_worker_phase Current bounded worker lifecycle phase.", "# TYPE notification_worker_phase gauge");
    for (const candidate of ["starting", "idle", "delivering", "stopping", "stopped"] as const) {
      lines.push(`notification_worker_phase{phase="${candidate}"} ${phase === candidate ? 1 : 0}`);
    }
    return lines.join("\n") + "\n";
  }
  return Object.freeze({ beginBatch, finishBatch, failBatch, stopping, stopped, snapshot, renderMetrics });
}
