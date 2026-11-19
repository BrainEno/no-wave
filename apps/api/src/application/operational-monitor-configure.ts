import { emptyMonitorState, parseMonitorState } from "./operational-monitor-state.ts";
import {
  MonitorFault,
  type MonitorConfig,
  type MonitorRuleId,
  type MonitorRuleState,
  type MonitorState,
  type MonitorTarget,
} from "./operational-monitor.ts";

type ConfigurationResult = {
  changed: boolean;
  state: MonitorState;
  added: string[];
  removed: string[];
  sourcesReset: string[];
  rulesReset: { targetId: string; rule: MonitorRuleId }[];
};
function sameSource(previous: MonitorTarget, next: MonitorTarget): boolean {
  return previous.role === next.role && previous.metricsUrl === next.metricsUrl;
}
function changedRule(previous: MonitorConfig, next: MonitorConfig, id: MonitorRuleId): boolean {
  const before = previous.rules[id],
    after = next.rules[id];
  if (before.forMs !== after.forMs || before.resolveMs !== after.resolveMs || before.repeatMs !== after.repeatMs)
    return true;
  if (previous.policy.maxGapMs !== next.policy.maxGapMs || previous.policy.minIntervalMs !== next.policy.minIntervalMs)
    return true;
  switch (id) {
    case "http_5xx":
      return (
        previous.policy.windowMs !== next.policy.windowMs ||
        previous.policy.httpMinRequests !== next.policy.httpMinRequests ||
        previous.policy.httpErrorRatio !== next.policy.httpErrorRatio
      );
    case "mail_delivery_failures":
      return (
        previous.policy.windowMs !== next.policy.windowMs || previous.policy.mailFailures !== next.policy.mailFailures
      );
    case "notification_backlog":
      return (
        previous.policy.pendingAgeSeconds !== next.policy.pendingAgeSeconds ||
        previous.policy.pendingEvents !== next.policy.pendingEvents
      );
    default:
      return false;
  }
}
function restartContinuity(rule: MonitorRuleState): void {
  rule.pendingSince = null;
  rule.recoverySince = null;
  if (rule.phase === "pending") rule.phase = "inactive";
  else if (rule.phase === "recovering") rule.phase = "firing";
}

/** Configuration is an explicit journal transaction, never a new observation.
 * Requiring all receipts to be delivered first avoids migrating or losing an
 * old contract's event queue. A live incident cannot disappear via target edits. */
export function reconfigureMonitor(
  previousConfig: MonitorConfig,
  nextConfig: MonitorConfig,
  value: unknown,
  now: number,
): ConfigurationResult {
  const previous = parseMonitorState(value, previousConfig);
  const output: ConfigurationResult = {
    changed: false,
    state: previous,
    added: [],
    removed: [],
    sourcesReset: [],
    rulesReset: [],
  };
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    now < (previous.lastEvaluatedAt ?? 0) ||
    now < (previous.lastConfigurationChange?.at ?? 0)
  )
    throw new MonitorFault("clock_rollback");
  if (previousConfig.fingerprint === nextConfig.fingerprint) return output;
  if (previous.lastEvaluatedAt === null) throw new MonitorFault("state_missing");
  if (previous.events.length > 0) throw new MonitorFault("config_pending_events");
  if (previous.revision >= Number.MAX_SAFE_INTEGER) throw new MonitorFault("state_full");
  for (const oldTarget of previousConfig.targets) {
    const nextTarget = nextConfig.targets.find((target) => target.id === oldTarget.id);
    const oldState = previous.targets.find((target) => target.id === oldTarget.id)!;
    const replaced = !nextTarget || !sameSource(oldTarget, nextTarget);
    if (replaced && oldState.rules.some((rule) => rule.phase !== "inactive"))
      throw new MonitorFault("config_active_targets");
    if (!nextTarget) output.removed.push(oldTarget.id);
  }
  const next = emptyMonitorState(nextConfig);
  next.revision = previous.revision + 1;
  next.lastEvaluatedAt = previous.lastEvaluatedAt;
  next.acknowledgedThrough = previous.acknowledgedThrough;
  next.lastConfigurationChange = { fromFingerprint: previousConfig.fingerprint, at: now, revision: next.revision };
  const resetCounters =
    previousConfig.policy.windowMs !== nextConfig.policy.windowMs ||
    previousConfig.policy.minIntervalMs !== nextConfig.policy.minIntervalMs ||
    previousConfig.policy.maxGapMs !== nextConfig.policy.maxGapMs;
  for (let index = 0; index < nextConfig.targets.length; index++) {
    const target = nextConfig.targets[index]!;
    const oldTarget = previousConfig.targets.find((row) => row.id === target.id);
    if (!oldTarget) {
      output.added.push(target.id);
      continue;
    }
    if (!sameSource(oldTarget, target)) {
      output.sourcesReset.push(target.id);
      continue;
    }
    const preserved = previous.targets.find((row) => row.id === target.id)!;
    // Cached verdicts belong to the old policy, even when counters remain useful.
    preserved.lastObservation = null;
    if (resetCounters) preserved.history = preserved.history.slice(-1);
    for (const rule of preserved.rules) {
      if (!changedRule(previousConfig, nextConfig, rule.id)) continue;
      restartContinuity(rule);
      output.rulesReset.push({ targetId: target.id, rule: rule.id });
    }
    next.targets[index] = preserved;
  }
  output.changed = true;
  output.state = parseMonitorState(next, nextConfig);
  return output;
}
