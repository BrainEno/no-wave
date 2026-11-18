import { performance } from "node:perf_hooks";
import { executeNextNotionJob, type NotionJobService, type NotionJobImageCopier } from "./notion-job-service.ts";
import type { NotionImportDeps } from "./notion-import.ts";
import type { NotionJobsPersistencePort, NotionJobState, NotionJobBacklog } from "./notion-durable-jobs.ts";

export type NotionJobDrainResult = {
  claimed: number; succeeded: number; failed: number; interrupted: number; cancelled: number; unavailable: number;
  stopReason: "empty" | "job-limit" | "deadline" | "aborted"; backlog: NotionJobBacklog; durationMs: number;
};

/** Finite, sequential and physically drained: an aborted promise is not a free worker slot. */
export async function runNotionJobDrain({ jobs, store, deps, copyImage, maxJobs = 1, deadlineMs = 300_000, signal }: {
  jobs: NotionJobService; store: NotionJobsPersistencePort; deps: NotionImportDeps; copyImage?: NotionJobImageCopier;
  maxJobs?: number; deadlineMs?: number; signal?: AbortSignal;
}): Promise<NotionJobDrainResult> {
  if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 10 || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1000 || deadlineMs > 900_000) {
    throw new RangeError("Invalid Notion import drain bounds.");
  }
  const started = performance.now();
  const executionDeadlineAt = Date.now() + deadlineMs;
  const deadline = new AbortController();
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(), deadlineMs);
  timer.unref();
  let claimed = 0, succeeded = 0, failed = 0, interrupted = 0, cancelled = 0, unavailable = 0;
  let stopReason: NotionJobDrainResult["stopReason"] = "job-limit";
  function outcome(state: NotionJobState | "unavailable"): void {
    if (state === "succeeded") succeeded += 1;
    else if (state === "failed") failed += 1;
    else if (state === "cancelled") cancelled += 1;
    else if (state === "interrupted" || state === "expired") interrupted += 1;
    else unavailable += 1;
  }
  try {
    await store.sweepNotionImportJobs();
    while (claimed < maxJobs) {
      // The timer cannot run during a long synchronous SQLite operation, so also use monotonic time.
      if (performance.now() - started >= deadlineMs) deadline.abort();
      if (combined.aborted) {
        stopReason = signal?.aborted ? "aborted" : "deadline";
        break;
      }
      const processed = await executeNextNotionJob({ jobs, store, deps, copyImage, signal: combined, executionDeadlineAt, onOutcome: outcome });
      if (!processed) { stopReason = combined.aborted ? signal?.aborted ? "aborted" : "deadline" : "empty"; break; }
      claimed += 1;
    }
    if (performance.now() - started >= deadlineMs) deadline.abort();
    if (combined.aborted) stopReason = signal?.aborted ? "aborted" : "deadline";
    // No active job/heartbeat can survive this await. Maintenance does not resurrect leases.
    await store.sweepNotionImportJobs();
    const backlog = await store.notionImportJobBacklog();
    return { claimed, succeeded, failed, interrupted, cancelled, unavailable, stopReason, backlog,
      durationMs: Math.max(0, Math.round(performance.now() - started)) };
  } finally { clearTimeout(timer); }
}
