import { createHash } from "node:crypto";
import {
  MONITOR_SOURCE_RESULTS,
  MonitorFault,
  monitorFields,
  monitorSeverity,
  monitorExitCode,
  type MonitorConfig,
  type MonitorCounterPoint,
  type MonitorEvent,
  type MonitorObservation,
  type MonitorReason,
  type MonitorReport,
  type MonitorRuleId,
  type MonitorRuleState,
  type MonitorSignal,
  type MonitorSnapshot,
  type MonitorState,
  type MonitorTarget,
  type MonitorTargetState,
} from "./operational-monitor.ts";
import { emptyMonitorState, MONITOR_EVENT_LIMIT, parseMonitorState } from "./operational-monitor-state.ts";

const INSTANCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function invalid(): never {
  throw new MonitorFault("invalid_metrics");
}
function nonnegative(value: unknown, integer = false): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER ||
    (integer && !Number.isSafeInteger(value))
  )
    invalid();
  return value;
}
function snapshotValue(value: unknown, target: MonitorTarget): MonitorSnapshot {
  const row = monitorFields(
    value,
    ["instance", "ready", "databaseAvailable", "backlog", "http", "mailFailures"],
    "invalid_metrics",
  );
  if (typeof row.instance !== "string" || !INSTANCE.test(row.instance) || typeof row.ready !== "boolean") invalid();
  if (target.role === "api" ? typeof row.databaseAvailable !== "boolean" : row.databaseAvailable !== null) invalid();
  let backlog: MonitorSnapshot["backlog"] = null;
  if (row.backlog !== null) {
    const observed = monitorFields(row.backlog, ["pending", "deadLetters", "oldestAgeSeconds"], "invalid_metrics");
    backlog = {
      pending: nonnegative(observed.pending, true),
      deadLetters: nonnegative(observed.deadLetters, true),
      oldestAgeSeconds: nonnegative(observed.oldestAgeSeconds),
    };
    if (backlog.pending === 0 && backlog.oldestAgeSeconds !== 0) invalid();
  }
  let http: MonitorSnapshot["http"] = null;
  let mailFailures: number | null = null;
  if (target.role === "api") {
    const counts = monitorFields(row.http, ["requests", "errors"], "invalid_metrics");
    http = { requests: nonnegative(counts.requests, true), errors: nonnegative(counts.errors, true) };
    if (http.errors > http.requests) invalid();
    mailFailures = nonnegative(row.mailFailures, true);
  } else if (row.http !== null || row.mailFailures !== null) invalid();
  return {
    instance: row.instance,
    ready: row.ready,
    databaseAvailable: row.databaseAvailable as boolean | null,
    backlog,
    http,
    mailFailures,
  };
}

function observationValue(
  value: unknown,
  target: MonitorTarget,
  now: number,
  config: MonitorConfig,
): MonitorObservation {
  const row = monitorFields(value, ["targetId", "observedAt", "reason", "snapshot"], "invalid_metrics");
  if (row.targetId !== target.id || !MONITOR_SOURCE_RESULTS.includes(row.reason as MonitorObservation["reason"]))
    invalid();
  const observedAt = nonnegative(row.observedAt, true);
  if (observedAt > now) throw new MonitorFault("clock_rollback");
  if (row.reason !== "ok") {
    if (row.snapshot !== null) invalid();
    return { targetId: target.id, observedAt, reason: row.reason as MonitorObservation["reason"], snapshot: null };
  }
  const snapshot = snapshotValue(row.snapshot, target);
  if (now - observedAt > config.policy.maxGapMs)
    return { targetId: target.id, observedAt, reason: "stale_response", snapshot: null };
  return { targetId: target.id, observedAt, reason: "ok", snapshot };
}

export function assertMonitorEvaluationTime(config: MonitorConfig, previous: MonitorState, now: number): void {
  if (!Number.isSafeInteger(now) || now < 0 || now < (previous.lastConfigurationChange?.at ?? 0))
    throw new MonitorFault("clock_rollback");
  if (previous.lastEvaluatedAt === null) return;
  if (now < previous.lastEvaluatedAt) throw new MonitorFault("clock_rollback");
  if (now - previous.lastEvaluatedAt < config.policy.minIntervalMs) throw new MonitorFault("sample_too_soon");
  if (previous.revision >= Number.MAX_SAFE_INTEGER) throw new MonitorFault("state_full");
}

type Window = { start: MonitorCounterPoint; end: MonitorCounterPoint };
function updateHistory(
  target: MonitorTargetState,
  observation: MonitorObservation,
  config: MonitorConfig,
): { window: Window | null; reason: MonitorReason; interrupted: boolean } {
  const snapshot = observation.snapshot;
  if (!snapshot) return { window: null, reason: "source_unavailable", interrupted: false };
  const changed = target.instance !== null && target.instance !== snapshot.instance;
  const gap = target.lastSampleAt !== null && observation.observedAt - target.lastSampleAt > config.policy.maxGapMs;
  if (target.lastSampleAt !== null && observation.observedAt <= target.lastSampleAt) invalid();
  target.instance = snapshot.instance;
  target.lastSampleAt = observation.observedAt;
  if (!snapshot.http) {
    target.history = [];
    return { window: null, reason: "counter_warmup", interrupted: changed || gap };
  }
  const counters = { ...snapshot.http, mailFailures: snapshot.mailFailures! };
  const previous = target.history.at(-1);
  const reset =
    !!previous &&
    (counters.requests < previous.counters.requests ||
      counters.errors < previous.counters.errors ||
      counters.mailFailures < previous.counters.mailFailures ||
      counters.errors - previous.counters.errors > counters.requests - previous.counters.requests);
  if (changed || gap || reset) target.history = [];
  target.history.push({ at: observation.observedAt, counters });
  const cutoff = observation.observedAt - config.policy.windowMs;
  let anchor = -1;
  for (let index = 0; index < target.history.length; index++) if (target.history[index]!.at <= cutoff) anchor = index;
  if (anchor > 0) target.history = target.history.slice(anchor);
  const limit = Math.ceil(config.policy.windowMs / config.policy.minIntervalMs) + 2;
  if (target.history.length > limit) target.history = target.history.slice(-limit);
  const start = target.history[0]!;
  const window = start.at <= cutoff ? { start, end: target.history.at(-1)! } : null;
  return {
    window,
    reason: changed || reset ? "counter_reset" : "counter_warmup",
    interrupted: changed || gap || reset,
  };
}

function known(breached: boolean, value: number): MonitorSignal {
  return { condition: breached ? "bad" : "good", reason: breached ? "breached" : "within_threshold", value };
}
function unknown(reason: MonitorReason): MonitorSignal {
  return { condition: "unknown", reason, value: null };
}
function signalFor(
  id: MonitorRuleId,
  observation: MonitorObservation,
  config: MonitorConfig,
  window: Window | null,
  windowReason: MonitorReason,
): MonitorSignal {
  const snapshot = observation.snapshot;
  if (id === "target_unavailable") return known(snapshot === null, snapshot === null ? 1 : 0);
  if (!snapshot) return unknown("source_unavailable");
  switch (id) {
    case "service_not_ready":
      return known(!snapshot.ready, snapshot.ready ? 0 : 1);
    case "database_unavailable":
      return known(!snapshot.databaseAvailable, snapshot.databaseAvailable ? 0 : 1);
    case "notification_telemetry_unavailable":
      return known(snapshot.backlog === null, snapshot.backlog === null ? 1 : 0);
    case "notification_backlog": {
      if (!snapshot.backlog) return unknown("telemetry_unavailable");
      const { pending, oldestAgeSeconds } = snapshot.backlog;
      return known(
        pending >= config.policy.pendingEvents || (pending > 0 && oldestAgeSeconds >= config.policy.pendingAgeSeconds),
        oldestAgeSeconds,
      );
    }
    case "notification_dead_letters":
      return snapshot.backlog
        ? known(snapshot.backlog.deadLetters > 0, snapshot.backlog.deadLetters)
        : unknown("telemetry_unavailable");
    case "http_5xx": {
      if (!window) return unknown(windowReason);
      const requests = window.end.counters.requests - window.start.counters.requests;
      const errors = window.end.counters.errors - window.start.counters.errors;
      if (requests < config.policy.httpMinRequests) return unknown("insufficient_traffic");
      const ratio = errors / requests;
      return known(ratio >= config.policy.httpErrorRatio, ratio);
    }
    case "mail_delivery_failures": {
      if (!window) return unknown(windowReason);
      const failures = window.end.counters.mailFailures - window.start.counters.mailFailures;
      return known(failures >= config.policy.mailFailures, failures);
    }
  }
}

/** Unknown, missing and interrupted intervals never prove recovery. An already
 * firing condition remains latched until a full observed healthy duration. */
function transitionRule(
  rule: MonitorRuleState,
  signal: MonitorSignal,
  now: number,
  config: MonitorConfig,
  interrupted: boolean,
): MonitorEvent["transition"] | null {
  const timing = config.rules[rule.id];
  if (interrupted || signal.condition === "unknown") {
    rule.pendingSince = null;
    rule.recoverySince = null;
    if (rule.phase === "pending") rule.phase = "inactive";
    else if (rule.phase === "recovering") rule.phase = "firing";
  }
  if (signal.condition === "bad") {
    rule.recoverySince = null;
    if (rule.phase === "inactive") {
      rule.phase = "pending";
      rule.pendingSince = now;
    } else if (rule.phase === "recovering") rule.phase = "firing";
    if (rule.phase === "pending" && now - rule.pendingSince! >= timing.forMs) {
      rule.phase = "firing";
      rule.pendingSince = null;
      rule.firingSince = now;
      rule.lastEventAt = now;
      return "firing";
    }
  } else if (signal.condition === "good") {
    rule.pendingSince = null;
    if (rule.phase === "pending") rule.phase = "inactive";
    if (rule.phase === "firing") {
      rule.phase = "recovering";
      rule.recoverySince = now;
    }
    if (rule.phase === "recovering" && now - rule.recoverySince! >= timing.resolveMs) {
      rule.phase = "inactive";
      rule.recoverySince = null;
      rule.lastEventAt = now;
      return "resolved";
    }
  }
  if (rule.phase === "firing" && rule.lastEventAt !== null && now - rule.lastEventAt >= timing.repeatMs) {
    rule.lastEventAt = now;
    return "reminder";
  }
  return null;
}

export function evaluateMonitor(
  config: MonitorConfig,
  previousValue: unknown | null,
  values: readonly MonitorObservation[],
  now: number,
): { state: MonitorState; report: MonitorReport } {
  const state = previousValue === null ? emptyMonitorState(config) : parseMonitorState(previousValue, config);
  assertMonitorEvaluationTime(config, state, now);
  if (
    !Array.isArray(values) ||
    values.length !== config.targets.length ||
    new Set(values.map((value) => value?.targetId)).size !== values.length
  )
    invalid();
  const observations = config.targets.map((target, index) => {
    const value = values.find((value) => value?.targetId === target.id);
    const observation = observationValue(value, target, now, config);
    const persisted = state.targets[index]!;
    const previousAt = persisted.lastObservation?.observedAt ?? persisted.lastSampleAt;
    if (previousAt !== null && observation.observedAt <= previousAt) invalid();
    return observation;
  });
  const longGap = state.lastEvaluatedAt !== null && now - state.lastEvaluatedAt > config.policy.maxGapMs;
  state.revision++;
  state.lastEvaluatedAt = now;
  const reports: MonitorReport["targets"] = [];
  for (let index = 0; index < config.targets.length; index++) {
    const target = config.targets[index]!,
      targetState = state.targets[index]!,
      observation = observations[index]!;
    const { window, reason, interrupted } = updateHistory(targetState, observation, config);
    const rules = targetState.rules.map((rule) => {
      const signal = signalFor(rule.id, observation, config, window, reason);
      const event = transitionRule(rule, signal, now, config, longGap || interrupted);
      if (event) {
        const id = createHash("sha256")
          .update(JSON.stringify([config.fingerprint, state.revision, target.id, rule.id, event, now]))
          .digest("hex");
        state.events.push({
          id,
          revision: state.revision,
          targetId: target.id,
          rule: rule.id,
          severity: monitorSeverity(rule.id),
          transition: event,
          at: now,
          firingSince: rule.firingSince!,
          reason: signal.reason,
          value: signal.value,
        });
        if (event === "resolved") rule.firingSince = null;
      }
      return { id: rule.id, phase: rule.phase, ...signal };
    });
    targetState.lastObservation = {
      observedAt: observation.observedAt,
      source: observation.reason,
      rules: rules.map(({ id, condition, reason, value }) => ({ id, condition, reason, value })),
    };
    reports.push({ id: target.id, role: target.role, source: observation.reason, rules });
  }
  if (state.events.length > MONITOR_EVENT_LIMIT) throw new MonitorFault("state_full");
  const exitCode = monitorExitCode(reports, state.events.length);
  const validated = parseMonitorState(state, config);
  return {
    state: validated,
    report: {
      version: 1,
      event: "monitor_check",
      evaluatedAt: now,
      revision: state.revision,
      targets: reports,
      events: validated.events,
      unacknowledged: validated.events.length,
      exitCode,
    },
  };
}

/** A retry of the most recent acknowledgement is idempotent. Neither a guessed
 * id nor a later event can cause an implicit acknowledgement of earlier output. */
export function acknowledgeMonitorEvents(
  config: MonitorConfig,
  value: unknown,
  through: string,
): { state: MonitorState; acknowledged: number } {
  const state = parseMonitorState(value, config);
  if (through === state.acknowledgedThrough) return { state, acknowledged: 0 };
  const index = state.events.findIndex((event) => event.id === through);
  if (index < 0) throw new MonitorFault("event_not_found");
  if (state.revision >= Number.MAX_SAFE_INTEGER) throw new MonitorFault("state_full");
  state.events = state.events.slice(index + 1);
  state.acknowledgedThrough = through;
  state.revision++;
  return { state, acknowledged: index + 1 };
}
