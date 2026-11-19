import { parseMonitorState } from "./operational-monitor-state.ts";
import {
  MonitorFault,
  monitorExitCode,
  type MonitorConfig,
  type MonitorFreshness,
  type MonitorStatusReport,
} from "./operational-monitor.ts";

/** A read-only freshness verdict for a scheduler/watchdog, not a network probe.
 * A previous green report expires. Staleness never clears a latched incident or
 * an undelivered recovery receipt, and this function cannot create/ack events. */
export function monitorStatus(config: MonitorConfig, value: unknown, now: number): MonitorStatusReport {
  const state = parseMonitorState(value, config);
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    now < (state.lastEvaluatedAt ?? 0) ||
    now < (state.lastConfigurationChange?.at ?? 0)
  )
    throw new MonitorFault("clock_rollback");
  const evaluatedAge = state.lastEvaluatedAt === null ? null : now - state.lastEvaluatedAt;
  const targets: MonitorStatusReport["targets"] = config.targets.map((target, index) => {
    const persisted = state.targets[index]!,
      observed = persisted.lastObservation;
    const age = observed === null ? null : now - observed.observedAt;
    let freshness: MonitorFreshness;
    if (observed === null)
      freshness = state.lastConfigurationChange === null ? "not_observed" : "configuration_changed";
    else if (evaluatedAge === null || evaluatedAge > config.policy.maxGapMs || age! > config.policy.maxGapMs)
      freshness = "stale";
    else freshness = "fresh";
    const rules = persisted.rules.map((rule, ruleIndex): MonitorStatusReport["targets"][number]["rules"][number] => {
      if (freshness === "fresh") return { ...observed!.rules[ruleIndex]!, phase: rule.phase };
      return {
        id: rule.id,
        phase: rule.phase,
        condition: "unknown",
        reason: freshness === "stale" ? "monitor_stale" : freshness,
        value: null,
      };
    });
    return {
      id: target.id,
      role: target.role,
      freshness,
      lastSource: observed?.source ?? null,
      lastObservedAt: observed?.observedAt ?? null,
      lastSampleAt: persisted.lastSampleAt,
      observationAgeMs: age,
      rules,
    };
  });
  const exitCode = monitorExitCode(targets, state.events.length);
  return {
    version: 1,
    event: "monitor_status",
    reportedAt: now,
    lastEvaluatedAt: state.lastEvaluatedAt,
    revision: state.revision,
    health: exitCode === 0 ? "observed_healthy" : exitCode === 1 ? "attention" : "unknown",
    unacknowledged: state.events.length,
    exitCode,
    targets,
  };
}
