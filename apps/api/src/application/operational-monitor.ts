export const MONITOR_RULES = [
  "target_unavailable",
  "service_not_ready",
  "database_unavailable",
  "notification_telemetry_unavailable",
  "notification_backlog",
  "notification_dead_letters",
  "http_5xx",
  "mail_delivery_failures",
] as const;
export type MonitorRuleId = (typeof MONITOR_RULES)[number];
export type MonitorRole = "api" | "notification-worker";
export type MonitorTarget = { id: string; role: MonitorRole; metricsUrl: string };
export type MonitorTiming = { forMs: number; resolveMs: number; repeatMs: number };
export type MonitorPolicy = {
  windowMs: number;
  minIntervalMs: number;
  maxGapMs: number;
  httpMinRequests: number;
  httpErrorRatio: number;
  pendingAgeSeconds: number;
  pendingEvents: number;
  mailFailures: number;
};
export type MonitorConfig = {
  version: 1;
  allowInsecureHttp: boolean;
  targets: MonitorTarget[];
  scrapeTimeoutMs: number;
  runTimeoutMs: number;
  policy: MonitorPolicy;
  rules: Record<MonitorRuleId, MonitorTiming>;
  fingerprint: string;
};
export type MonitorSnapshot = {
  instance: string;
  ready: boolean;
  databaseAvailable: boolean | null;
  backlog: { pending: number; deadLetters: number; oldestAgeSeconds: number } | null;
  http: { requests: number; errors: number } | null;
  mailFailures: number | null;
};
export const MONITOR_SOURCE_RESULTS = [
  "ok",
  "timeout",
  "run_timeout",
  "cancelled",
  "transport",
  "http_status",
  "invalid_content_type",
  "response_too_large",
  "invalid_metrics",
  "stale_response",
] as const;
export type MonitorSourceResult = (typeof MONITOR_SOURCE_RESULTS)[number];
export type MonitorObservation = {
  targetId: string;
  observedAt: number;
  reason: MonitorSourceResult;
  snapshot: MonitorSnapshot | null;
};
export type MonitorCounters = { requests: number; errors: number; mailFailures: number };
export type MonitorCounterPoint = { at: number; counters: MonitorCounters };
export type MonitorPhase = "inactive" | "pending" | "firing" | "recovering";
export type MonitorRuleState = {
  id: MonitorRuleId;
  phase: MonitorPhase;
  pendingSince: number | null;
  firingSince: number | null;
  recoverySince: number | null;
  lastEventAt: number | null;
};
export type MonitorTargetState = {
  id: string;
  instance: string | null;
  lastSampleAt: number | null;
  history: MonitorCounterPoint[];
  rules: MonitorRuleState[];
  lastObservation: {
    observedAt: number;
    source: MonitorSourceResult;
    rules: (MonitorSignal & { id: MonitorRuleId })[];
  } | null;
};
export type MonitorReason =
  | "breached"
  | "within_threshold"
  | "source_unavailable"
  | "telemetry_unavailable"
  | "counter_warmup"
  | "counter_reset"
  | "insufficient_traffic";
export type MonitorSignal = { condition: "bad" | "good" | "unknown"; reason: MonitorReason; value: number | null };
export type MonitorEvent = {
  id: string;
  revision: number;
  targetId: string;
  rule: MonitorRuleId;
  severity: "warning" | "critical";
  transition: "firing" | "resolved" | "reminder";
  at: number;
  firingSince: number;
  reason: MonitorReason;
  value: number | null;
};
export type MonitorState = {
  version: 1;
  fingerprint: string;
  revision: number;
  lastEvaluatedAt: number | null;
  acknowledgedThrough: string | null;
  targets: MonitorTargetState[];
  events: MonitorEvent[];
  lastConfigurationChange: { fromFingerprint: string; at: number; revision: number } | null;
};
export type MonitorRuleReport = MonitorSignal & { id: MonitorRuleId; phase: MonitorPhase };
export type MonitorReport = {
  version: 1;
  event: "monitor_check";
  evaluatedAt: number;
  revision: number;
  targets: { id: string; role: MonitorRole; source: MonitorSourceResult; rules: MonitorRuleReport[] }[];
  events: MonitorEvent[];
  unacknowledged: number;
  exitCode: 0 | 1 | 3;
};
export type MonitorFreshness = "fresh" | "stale" | "not_observed" | "configuration_changed";
export type MonitorStatusReport = {
  version: 1;
  event: "monitor_status";
  reportedAt: number;
  lastEvaluatedAt: number | null;
  revision: number;
  health: "observed_healthy" | "attention" | "unknown";
  unacknowledged: number;
  exitCode: 0 | 1 | 3;
  targets: {
    id: string;
    role: MonitorRole;
    freshness: MonitorFreshness;
    lastSource: MonitorSourceResult | null;
    lastObservedAt: number | null;
    lastSampleAt: number | null;
    observationAgeMs: number | null;
    rules: (Omit<MonitorRuleReport, "reason"> & {
      reason: MonitorReason | "monitor_stale" | "not_observed" | "configuration_changed";
    })[];
  }[];
};
export type MonitorFaultCode =
  | "config_invalid"
  | "invalid_metrics"
  | "state_invalid"
  | "state_config_mismatch"
  | "state_locked"
  | "state_io"
  | "state_full"
  | "clock_rollback"
  | "sample_too_soon"
  | "cancelled"
  | "arguments_invalid"
  | "event_not_found"
  | "state_missing"
  | "output_failed"
  | "config_pending_events"
  | "config_active_targets";
export class MonitorFault extends Error {
  readonly code: MonitorFaultCode;
  constructor(code: MonitorFaultCode) {
    super(code);
    this.name = "MonitorFault";
    this.code = code;
  }
}

/** Closed JSON objects, not a permissive generic isRecord policy. Unknown keys
 * cannot silently become an unvalidated destination, state field or secret. */
export function monitorFields(
  value: unknown,
  allowed: readonly string[],
  code: MonitorFaultCode,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MonitorFault(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new MonitorFault(code);
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new MonitorFault(code);
  return value as Record<string, unknown>;
}

export function monitorRulesFor(role: MonitorRole): MonitorRuleId[] {
  return MONITOR_RULES.filter(
    (id) => role === "api" || !["database_unavailable", "http_5xx", "mail_delivery_failures"].includes(id),
  );
}

export function monitorSeverity(rule: MonitorRuleId): MonitorEvent["severity"] {
  return ["target_unavailable", "service_not_ready", "database_unavailable", "notification_dead_letters"].includes(rule)
    ? "critical"
    : "warning";
}

export function monitorExitCode(
  targets: readonly { rules: readonly { phase: MonitorPhase; condition: MonitorSignal["condition"] }[] }[],
  unacknowledged: number,
): 0 | 1 | 3 {
  const active = targets.some((target) => target.rules.some((rule) => rule.phase !== "inactive"));
  const uncertain = targets.some((target) => target.rules.some((rule) => rule.condition === "unknown"));
  return active || unacknowledged > 0 ? 1 : uncertain ? 3 : 0;
}
