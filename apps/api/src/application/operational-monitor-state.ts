import {
  MonitorFault,
  MONITOR_SOURCE_RESULTS,
  monitorFields,
  monitorRulesFor,
  monitorSeverity,
  type MonitorConfig,
  type MonitorCounterPoint,
  type MonitorEvent,
  type MonitorPhase,
  type MonitorReason,
  type MonitorRuleId,
  type MonitorRuleState,
  type MonitorState,
  type MonitorSourceResult,
  type MonitorSignal,
  type MonitorTargetState,
} from "./operational-monitor.ts";

export const MONITOR_EVENT_LIMIT = 256;
const HASH = /^[a-f0-9]{64}$/;
const INSTANCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REASONS: readonly MonitorReason[] = [
  "breached",
  "within_threshold",
  "source_unavailable",
  "telemetry_unavailable",
  "counter_warmup",
  "counter_reset",
  "insufficient_traffic",
];
function invalid(): never {
  throw new MonitorFault("state_invalid");
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}
function timestamp(value: unknown, maximum: number): number | null {
  if (value === null) return null;
  const result = integer(value);
  if (result > maximum) invalid();
  return result;
}

function ruleState(value: unknown, expected: MonitorRuleId, maximum: number): MonitorRuleState {
  const row = monitorFields(
    value,
    ["id", "phase", "pendingSince", "firingSince", "recoverySince", "lastEventAt"],
    "state_invalid",
  );
  if (row.id !== expected || !["inactive", "pending", "firing", "recovering"].includes(String(row.phase))) invalid();
  const phase = row.phase as MonitorPhase;
  const pendingSince = timestamp(row.pendingSince, maximum);
  const firingSince = timestamp(row.firingSince, maximum);
  const recoverySince = timestamp(row.recoverySince, maximum);
  const lastEventAt = timestamp(row.lastEventAt, maximum);
  if ((phase === "pending") !== (pendingSince !== null) || (phase === "recovering") !== (recoverySince !== null))
    invalid();
  if ((phase === "firing" || phase === "recovering") !== (firingSince !== null)) invalid();
  if (firingSince !== null && (lastEventAt === null || lastEventAt < firingSince)) invalid();
  if (recoverySince !== null && recoverySince < firingSince!) invalid();
  return { id: expected, phase, pendingSince, firingSince, recoverySince, lastEventAt };
}

function cachedKnownSignal(id: MonitorRuleId, signal: MonitorSignal, config: MonitorConfig): void {
  if (signal.condition === "unknown") return;
  const value = signal.value!,
    bad = signal.condition === "bad";
  switch (id) {
    case "target_unavailable":
    case "service_not_ready":
    case "database_unavailable":
    case "notification_telemetry_unavailable":
      if ((value !== 0 && value !== 1) || bad !== (value === 1)) invalid();
      break;
    case "notification_dead_letters":
      if (!Number.isSafeInteger(value) || bad !== value > 0) invalid();
      break;
    case "mail_delivery_failures":
      if (!Number.isSafeInteger(value) || bad !== value >= config.policy.mailFailures) invalid();
      break;
    case "http_5xx":
      if (value > 1 || bad !== value >= config.policy.httpErrorRatio) invalid();
      break;
    case "notification_backlog":
      if (!bad && value >= config.policy.pendingAgeSeconds) invalid();
      break;
  }
}

function lastObservation(
  value: unknown,
  expected: readonly MonitorRuleId[],
  lastSampleAt: number | null,
  maximum: number,
  config: MonitorConfig,
): MonitorTargetState["lastObservation"] {
  if (value === undefined || value === null) return null;
  const row = monitorFields(value, ["observedAt", "source", "rules"], "state_invalid");
  const observedAt = timestamp(row.observedAt, maximum);
  if (
    observedAt === null ||
    !MONITOR_SOURCE_RESULTS.includes(row.source as MonitorSourceResult) ||
    !Array.isArray(row.rules) ||
    row.rules.length !== expected.length
  )
    invalid();
  if (row.source === "ok" && observedAt !== lastSampleAt) invalid();
  const rules = row.rules.map((value, index) => {
    const signal = monitorFields(value, ["id", "condition", "reason", "value"], "state_invalid");
    const id = expected[index]!;
    if (
      signal.id !== id ||
      !["good", "bad", "unknown"].includes(String(signal.condition)) ||
      !REASONS.includes(signal.reason as MonitorReason)
    )
      invalid();
    if (
      signal.value !== null &&
      (typeof signal.value !== "number" ||
        !Number.isFinite(signal.value) ||
        signal.value < 0 ||
        signal.value > Number.MAX_SAFE_INTEGER)
    )
      invalid();
    if (signal.condition === "unknown") {
      if (signal.value !== null || signal.reason === "breached" || signal.reason === "within_threshold") invalid();
    } else if (
      signal.value === null ||
      signal.reason !== (signal.condition === "bad" ? "breached" : "within_threshold")
    )
      invalid();
    if (id === "target_unavailable") {
      if (signal.condition !== (row.source === "ok" ? "good" : "bad") || signal.value !== (row.source === "ok" ? 0 : 1))
        invalid();
    } else if (row.source !== "ok" && (signal.condition !== "unknown" || signal.reason !== "source_unavailable"))
      invalid();
    if (row.source === "ok" && signal.condition === "unknown") {
      switch (id) {
        case "http_5xx":
          if (!["counter_warmup", "counter_reset", "insufficient_traffic"].includes(String(signal.reason))) invalid();
          break;
        case "mail_delivery_failures":
          if (!["counter_warmup", "counter_reset"].includes(String(signal.reason))) invalid();
          break;
        case "notification_backlog":
        case "notification_dead_letters":
          if (signal.reason !== "telemetry_unavailable") invalid();
          break;
        default:
          invalid();
      }
    }
    const result = {
      id,
      condition: signal.condition as "good" | "bad" | "unknown",
      reason: signal.reason as MonitorReason,
      value: signal.value as number | null,
    };
    cachedKnownSignal(id, result, config);
    return result;
  });
  if (row.source === "ok") {
    const unavailable = rules.find((rule) => rule.id === "notification_telemetry_unavailable")!.condition === "bad";
    for (const rule of rules.filter(
      (rule) => rule.id === "notification_backlog" || rule.id === "notification_dead_letters",
    )) {
      if (unavailable !== (rule.condition === "unknown")) invalid();
    }
  }
  return { observedAt, source: row.source as MonitorSourceResult, rules };
}

function targetState(value: unknown, config: MonitorConfig, index: number, maximum: number): MonitorTargetState {
  const row = monitorFields(
    value,
    ["id", "instance", "lastSampleAt", "history", "rules", "lastObservation"],
    "state_invalid",
  );
  const target = config.targets[index]!;
  if (
    row.id !== target.id ||
    (row.instance !== null && (typeof row.instance !== "string" || !INSTANCE.test(row.instance)))
  )
    invalid();
  const lastSampleAt = timestamp(row.lastSampleAt, maximum);
  if ((row.instance === null) !== (lastSampleAt === null)) invalid();
  const historyLimit = Math.ceil(config.policy.windowMs / config.policy.minIntervalMs) + 2;
  if (!Array.isArray(row.history) || row.history.length > historyLimit) invalid();
  if ((target.role !== "api" && row.history.length !== 0) || (row.history.length > 0 && lastSampleAt === null))
    invalid();
  let previous: MonitorCounterPoint | null = null;
  const history: MonitorCounterPoint[] = row.history.map((value) => {
    const point = monitorFields(value, ["at", "counters"], "state_invalid");
    const at = timestamp(point.at, lastSampleAt ?? 0);
    if (at === null || (previous && at <= previous.at)) invalid();
    const counts = monitorFields(point.counters, ["requests", "errors", "mailFailures"], "state_invalid");
    const counters = {
      requests: integer(counts.requests),
      errors: integer(counts.errors),
      mailFailures: integer(counts.mailFailures),
    };
    if (counters.errors > counters.requests) invalid();
    if (
      previous &&
      (counters.requests < previous.counters.requests ||
        counters.errors < previous.counters.errors ||
        counters.mailFailures < previous.counters.mailFailures ||
        counters.errors - previous.counters.errors > counters.requests - previous.counters.requests)
    )
      invalid();
    previous = { at, counters };
    return previous;
  });
  if (history.length > 0 && history.at(-1)!.at !== lastSampleAt) invalid();
  const expectedRules = monitorRulesFor(target.role);
  if (!Array.isArray(row.rules) || row.rules.length !== expectedRules.length) invalid();
  const rules = row.rules.map((value, i) => ruleState(value, expectedRules[i]!, maximum));
  return {
    id: target.id,
    instance: row.instance as string | null,
    lastSampleAt,
    history,
    rules,
    lastObservation: lastObservation(row.lastObservation, expectedRules, lastSampleAt, maximum, config),
  };
}

function eventState(value: unknown, config: MonitorConfig, maximum: number, revision: number): MonitorEvent {
  const row = monitorFields(
    value,
    ["id", "revision", "targetId", "rule", "severity", "transition", "at", "firingSince", "reason", "value"],
    "state_invalid",
  );
  if (typeof row.id !== "string" || !HASH.test(row.id)) invalid();
  const eventRevision = integer(row.revision);
  if (eventRevision < 1 || eventRevision > revision) invalid();
  const target = config.targets.find((target) => target.id === row.targetId);
  if (!target || !monitorRulesFor(target.role).includes(row.rule as MonitorRuleId)) invalid();
  const rule = row.rule as MonitorRuleId;
  if (row.severity !== monitorSeverity(rule) || !["firing", "resolved", "reminder"].includes(String(row.transition)))
    invalid();
  const at = timestamp(row.at, maximum),
    firingSince = timestamp(row.firingSince, maximum);
  if (at === null || firingSince === null || firingSince > at || !REASONS.includes(row.reason as MonitorReason))
    invalid();
  if (
    (row.transition === "firing" && row.reason !== "breached") ||
    (row.transition === "resolved" && row.reason !== "within_threshold")
  )
    invalid();
  if (
    row.value !== null &&
    (typeof row.value !== "number" ||
      !Number.isFinite(row.value) ||
      row.value < 0 ||
      row.value > Number.MAX_SAFE_INTEGER)
  )
    invalid();
  return {
    id: row.id,
    revision: eventRevision,
    targetId: target.id,
    rule,
    severity: monitorSeverity(rule),
    transition: row.transition as MonitorEvent["transition"],
    at,
    firingSince,
    reason: row.reason as MonitorReason,
    value: row.value as number | null,
  };
}

/** The journal is operational state, not a trusted object cache. Reconstruct
 * every allowed field so disk corruption can neither acknowledge unknown events
 * nor turn stale/foreign configuration into recovery evidence. */
export function parseMonitorState(value: unknown, config: MonitorConfig): MonitorState {
  const row = monitorFields(
    value,
    [
      "version",
      "fingerprint",
      "revision",
      "lastEvaluatedAt",
      "acknowledgedThrough",
      "targets",
      "events",
      "lastConfigurationChange",
    ],
    "state_invalid",
  );
  if (row.version !== 1 || typeof row.fingerprint !== "string" || !HASH.test(row.fingerprint)) invalid();
  if (row.fingerprint !== config.fingerprint) throw new MonitorFault("state_config_mismatch");
  const revision = integer(row.revision);
  const lastEvaluatedAt = timestamp(row.lastEvaluatedAt, Number.MAX_SAFE_INTEGER);
  if ((revision === 0) !== (lastEvaluatedAt === null)) invalid();
  if (
    row.acknowledgedThrough !== null &&
    (typeof row.acknowledgedThrough !== "string" || !HASH.test(row.acknowledgedThrough))
  )
    invalid();
  if (
    !Array.isArray(row.targets) ||
    row.targets.length !== config.targets.length ||
    !Array.isArray(row.events) ||
    row.events.length > MONITOR_EVENT_LIMIT
  )
    invalid();
  const targets = row.targets.map((value, index) => targetState(value, config, index, lastEvaluatedAt ?? 0));
  const events = row.events.map((value) => eventState(value, config, lastEvaluatedAt ?? 0, revision));
  if (
    new Set(events.map((event) => event.id)).size !== events.length ||
    events.some((event) => event.id === row.acknowledgedThrough)
  )
    invalid();
  if (
    events.some(
      (event, index) => index > 0 && (event.revision < events[index - 1]!.revision || event.at < events[index - 1]!.at),
    )
  )
    invalid();
  let lastConfigurationChange: MonitorState["lastConfigurationChange"] = null;
  if (row.lastConfigurationChange !== undefined && row.lastConfigurationChange !== null) {
    const change = monitorFields(row.lastConfigurationChange, ["fromFingerprint", "at", "revision"], "state_invalid");
    if (
      typeof change.fromFingerprint !== "string" ||
      !HASH.test(change.fromFingerprint) ||
      change.fromFingerprint === config.fingerprint
    )
      invalid();
    const at = timestamp(change.at, Number.MAX_SAFE_INTEGER),
      changeRevision = integer(change.revision);
    if (
      at === null ||
      lastEvaluatedAt === null ||
      changeRevision < 2 ||
      changeRevision > revision ||
      (changeRevision === revision && at < lastEvaluatedAt)
    )
      invalid();
    if (changeRevision === revision && events.length > 0) invalid();
    if (changeRevision === revision && targets.some((target) => target.lastObservation !== null)) invalid();
    if (targets.some((target) => target.lastObservation !== null && target.lastObservation.observedAt < at)) invalid();
    lastConfigurationChange = { fromFingerprint: change.fromFingerprint, at, revision: changeRevision };
  }
  return {
    version: 1,
    fingerprint: config.fingerprint,
    revision,
    lastEvaluatedAt,
    acknowledgedThrough: row.acknowledgedThrough as string | null,
    targets,
    events,
    lastConfigurationChange,
  };
}

export function emptyMonitorState(config: MonitorConfig): MonitorState {
  return {
    version: 1,
    fingerprint: config.fingerprint,
    revision: 0,
    lastEvaluatedAt: null,
    acknowledgedThrough: null,
    lastConfigurationChange: null,
    targets: config.targets.map((target) => ({
      id: target.id,
      instance: null,
      lastSampleAt: null,
      lastObservation: null,
      history: [],
      rules: monitorRulesFor(target.role).map((id) => ({
        id,
        phase: "inactive",
        pendingSince: null,
        firingSince: null,
        recoverySince: null,
        lastEventAt: null,
      })),
    })),
    events: [],
  };
}
