import type { RefreshObservation, CoordinationFailureCode } from "./errors.ts";
import type { RefreshStorageSnapshot, RefreshStoreRuntimeSnapshot } from "./postgres-store.ts";

const EVENTS = ["requested", "claimed", "shared", "completed", "uncertain", "rejected", "sweep-failed"] as const;
const REASONS: readonly CoordinationFailureCode[] = ["closed", "capacity", "circuit-open", "deadline", "database", "policy", "invalid-result", "uncertain"];
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;

/** Process counters and cached aggregate DB gauges; no generation identifiers. */
export class RefreshTelemetry {
  private readonly events = new Map<string, number>(EVENTS.map(event => [event, 0]));
  private readonly reasons = new Map<string, number>(REASONS.map(reason => [reason, 0]));
  private storage: RefreshStorageSnapshot | null = null;
  private storageAvailable = false;

  observe(sample: RefreshObservation): void {
    if (this.events.has(sample.event)) this.events.set(sample.event, Math.min(MAX_COUNTER, this.events.get(sample.event)! + 1));
    if (sample.reason && this.reasons.has(sample.reason)) this.reasons.set(sample.reason, Math.min(MAX_COUNTER, this.reasons.get(sample.reason)! + 1));
  }

  sampled(snapshot: RefreshStorageSnapshot): void {
    this.storage = { ...snapshot };
    this.storageAvailable = true;
  }

  sampleFailed(): void { this.storageAvailable = false; }

  render(process: { mode: "memory" | "postgres"; ready: boolean; pending: number; callbacks: number; waiters?: number; waitingKeys?: number; database?: RefreshStoreRuntimeSnapshot }): string {
    const lines = [
      "# HELP web_refresh_coordination_events_total Process-local refresh coordination events; sum across replicas.",
      "# TYPE web_refresh_coordination_events_total counter",
    ];
    for (const [event, count] of this.events) lines.push(`web_refresh_coordination_events_total{event="${event}"} ${count}`);
    lines.push("# HELP web_refresh_coordination_failures_total Fixed failure classifications, never driver messages.", "# TYPE web_refresh_coordination_failures_total counter");
    for (const [reason, count] of this.reasons) lines.push(`web_refresh_coordination_failures_total{reason="${reason}"} ${count}`);
    const gauge = (name: string, help: string, value: number) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${Number.isFinite(value) && value >= 0 ? value : 0}`);
    };
    gauge("web_refresh_coordination_ready", "Refresh topology and cached coordination dependency are ready.", Number(process.ready));
    gauge("web_refresh_coordination_shared", "PostgreSQL coordination is configured rather than single-process memory.", Number(process.mode === "postgres"));
    gauge("web_refresh_coordination_pending_calls", "Process-local generation resolutions still owned.", process.pending);
    gauge("web_refresh_coordination_active_callbacks", "Actual rotation callbacks including late timed-out callbacks.", process.callbacks);
    gauge("web_refresh_coordination_request_waiters", "Admitted request waiters; cancellation releases only this caller.", process.waiters ?? 0);
    gauge("web_refresh_coordination_waiting_keys", "Distinct generations with admitted request waiters.", process.waitingKeys ?? 0);
    const database = process.database;
    gauge("web_refresh_coordination_database_active_operations", "Real driver work, including timed-out callers still running.", database?.active ?? 0);
    gauge("web_refresh_coordination_database_queued_operations", "Database work admitted to the bounded queue.", database?.queued ?? 0);
    gauge("web_refresh_coordination_database_consecutive_failures", "Current database circuit failure count, not a cumulative counter.", database?.failures ?? 0);
    gauge("web_refresh_coordination_database_retry_after_seconds", "Monotonic remaining open-circuit backoff.", (database?.retryAfterMs ?? 0) / 1000);
    lines.push("# HELP web_refresh_coordination_database_circuit Process-local circuit state; disabled in memory mode.", "# TYPE web_refresh_coordination_database_circuit gauge");
    for (const state of ["disabled", "closed", "open", "half-open", "stopped"] as const) {
      lines.push(`web_refresh_coordination_database_circuit{state="${state}"} ${Number(state === (database?.circuit ?? "disabled"))}`);
    }
    gauge("web_refresh_coordination_notification_subscriptions", "Subscribed generation hashes; hashes are never labels.", database?.notificationKeys ?? 0);
    gauge("web_refresh_coordination_notification_waiters", "Current bounded notification waiters.", database?.notificationWaiters ?? 0);
    lines.push("# HELP web_refresh_coordination_notification_ignored_total Process-local rate-suppressed wake hints.", "# TYPE web_refresh_coordination_notification_ignored_total counter",
      `web_refresh_coordination_notification_ignored_total ${database?.notificationIgnored ?? 0}`);
    gauge("web_refresh_coordination_storage_available", "Latest aggregate storage sample succeeded; zero is not an empty store.", Number(this.storageAvailable));
    if (this.storage) {
      // Cluster gauges are repeated by each replica. Operators must use max,
      // not sum; only the process-local counters above should be summed.
      for (const [state, count] of [["pending", this.storage.pending], ["resolved", this.storage.resolved], ["uncertain", this.storage.uncertain]] as const) {
        lines.push(`web_refresh_coordination_stored_generations{state="${state}"} ${count}`);
      }
      gauge("web_refresh_coordination_expired_generations", "Expired rows awaiting the bounded background sweep.", this.storage.expired);
      gauge("web_refresh_coordination_overdue_owners", "Pending owners past their deadline; never automatically stolen.", this.storage.overdue);
      gauge("web_refresh_coordination_oldest_pending_age_seconds", "Age of the oldest pending claim at the storage sample.", this.storage.oldestPendingAgeSeconds);
      gauge("web_refresh_coordination_oldest_uncertain_age_seconds", "Age of the oldest uncertain claim at the storage sample.", this.storage.oldestUncertainAgeSeconds);
      gauge("web_refresh_coordination_storage_sample_timestamp_seconds", "Database-clock timestamp of the last successful storage sample.", this.storage.capturedAtSeconds);
    }
    return lines.join("\n") + "\n";
  }
}
