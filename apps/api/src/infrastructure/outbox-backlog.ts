import type { createOutboxMetrics } from "../persistence/outbox-metrics.ts";

export type OutboxSnapshot = { pendingEvents: number; deadLetterEvents: number; oldestPendingAgeMs: number };
export function validatedBacklog(value: unknown): OutboxSnapshot {
  if (!value || typeof value !== "object") throw new TypeError("Outbox backlog is unavailable.");
  const row = value as Record<string, unknown>;
  for (const key of ["pendingEvents", "deadLetterEvents", "oldestPendingAgeMs"]) {
    if (typeof row[key] !== "number" || !Number.isSafeInteger(row[key]) || row[key] < 0) {
      throw new TypeError("Outbox backlog contains an invalid count.");
    }
  }
  if (row.pendingEvents === 0 && row.oldestPendingAgeMs !== 0) throw new TypeError("An empty backlog cannot have an oldest event.");
  return { pendingEvents: row.pendingEvents as number, deadLetterEvents: row.deadLetterEvents as number,
    oldestPendingAgeMs: row.oldestPendingAgeMs as number };
}

type FailureReason = "timeout" | "read_failed" | "invalid_snapshot";
type Metrics = Pick<ReturnType<typeof createOutboxMetrics>, "recordBacklog" | "recordBacklogReadFailure">;
type Attempt = { startedAt: number; failed: boolean; timer?: ReturnType<typeof setTimeout> };

/** Optional observability must not stall notification dispatch. Keep one driver
 * query in flight even after its reporting deadline; scrapes only read cached
 * state. A late/invalid result cannot fabricate a trusted empty queue. */
export function createOutboxBacklogSampler({
  read, metrics, refreshIntervalMs, timeoutMs, onFailure = () => {},
  now = performance.now.bind(performance), wallNow = Date.now,
}: { read: () => unknown; metrics: Metrics; refreshIntervalMs: number; timeoutMs: number;
  onFailure?: (failure: { reason: FailureReason }) => void; now?: () => number; wallNow?: () => number }) {
  for (const budget of [refreshIntervalMs, timeoutMs]) {
    if (!Number.isSafeInteger(budget) || budget <= 0 || budget > 60_000) throw new RangeError("Invalid backlog sampling budget.");
  }
  const freshnessBudgetMs = Math.max(refreshIntervalMs * 2, timeoutMs * 2);
  let started = false;
  let closed = false;
  let available = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  let active: Attempt | null = null;
  let good: { snapshot: OutboxSnapshot; observedAt: number; sampledAt: number } | null = null;

  function sample(): void {
    if (closed || active !== null) return;
    const attempt: Attempt = { startedAt: now(), failed: false };
    active = attempt;
    const failed = (reason: FailureReason) => {
      if (closed || attempt.failed) return;
      attempt.failed = true;
      available = false;
      metrics.recordBacklogReadFailure();
      try { onFailure({ reason }); } catch { /* a log observer cannot break delivery */ }
    };
    attempt.timer = setTimeout(() => failed("timeout"), timeoutMs);
    attempt.timer.unref();
    void Promise.resolve().then(() => closed ? undefined : read()).then(value => {
      if (closed || attempt.failed) return;
      if (now() - attempt.startedAt > timeoutMs) { failed("timeout"); return; }
      let snapshot: OutboxSnapshot;
      try { snapshot = validatedBacklog(value); }
      catch { failed("invalid_snapshot"); return; }
      metrics.recordBacklog(snapshot);
      good = { snapshot, observedAt: now(), sampledAt: wallNow() };
      available = true;
    }).catch(() => { failed("read_failed"); }).finally(() => {
      if (attempt.timer) clearTimeout(attempt.timer);
      if (active === attempt) active = null;
    });
  }
  function start(): void {
    if (closed) throw new Error("A closed backlog sampler cannot be restarted.");
    if (started) return;
    started = true;
    sample();
    interval = setInterval(sample, refreshIntervalMs);
    interval.unref();
  }
  function close(): void {
    closed = true;
    available = false;
    if (interval) { clearInterval(interval); interval = undefined; }
    if (active?.timer) { clearTimeout(active.timer); active.timer = undefined; }
  }
  function renderMetrics(): string {
    const ageMs = good ? Math.max(0, Math.floor(now() - good.observedAt)) : null;
    const fresh = !closed && available && ageMs !== null && ageMs <= freshnessBudgetMs;
    const pendingAgeMs = good ? Math.min(Number.MAX_SAFE_INTEGER,
      good.snapshot.oldestPendingAgeMs + (good.snapshot.pendingEvents > 0 ? ageMs! : 0)) : 0;
    const gauges: [string, string, number][] = [
      ["notification_worker_backlog_available", "A timely successful backlog sample is still fresh; zero is not proof of an empty queue.", fresh ? 1 : 0],
      ["notification_worker_backlog_sample_age_seconds", "Monotonic age of the trusted backlog sample, -1 until the first success.", ageMs === null ? -1 : ageMs / 1000],
      ["notification_worker_backlog_sample_timestamp_seconds", "Wall timestamp of the trusted sample; failed or late reads do not replace it.", (good?.sampledAt ?? 0) / 1000],
      ["notification_worker_backlog_oldest_pending_age_seconds", "Oldest trusted pending age advanced between samples; consult availability before interpreting.", pendingAgeMs / 1000],
      ["notification_worker_backlog_freshness_budget_seconds", "Age after which a cached backlog sample is unavailable.", freshnessBudgetMs / 1000],
    ];
    return gauges.map(([name, help, value]) => `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}\n`).join("");
  }
  return Object.freeze({ start, close, renderMetrics });
}
