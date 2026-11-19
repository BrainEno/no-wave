import { createHash } from "node:crypto";
import {
  MONITOR_RULES,
  MonitorFault,
  monitorFields,
  type MonitorConfig,
  type MonitorPolicy,
  type MonitorRuleId,
  type MonitorTarget,
  type MonitorTiming,
} from "../application/operational-monitor.ts";

const POLICY_DEFAULTS: MonitorPolicy = {
  windowMs: 300_000,
  minIntervalMs: 1000,
  maxGapMs: 90_000,
  httpMinRequests: 20,
  httpErrorRatio: 0.05,
  pendingAgeSeconds: 120,
  pendingEvents: 1000,
  mailFailures: 1,
};
const POLICY_RANGES: Record<keyof MonitorPolicy, readonly [number, number]> = {
  windowMs: [1000, 900_000],
  minIntervalMs: [1000, 60_000],
  maxGapMs: [1000, 900_000],
  httpMinRequests: [1, 1_000_000_000],
  httpErrorRatio: [0.000001, 1],
  pendingAgeSeconds: [1, 86400],
  pendingEvents: [1, 1_000_000_000],
  mailFailures: [1, 1_000_000_000],
};

function setting(value: unknown, fallback: number, min: number, max: number, integer = true): number {
  const result = value === undefined ? fallback : value;
  if (
    typeof result !== "number" ||
    !Number.isFinite(result) ||
    result < min ||
    result > max ||
    (integer && !Number.isSafeInteger(result))
  ) {
    throw new MonitorFault("config_invalid");
  }
  return result;
}

function metricsUrl(value: unknown, allowInsecure: boolean): string {
  if (typeof value !== "string" || value.length > 2048 || /[\s\\\x00-\x1f\x7f]/.test(value))
    throw new MonitorFault("config_invalid");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MonitorFault("config_invalid");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/metrics"
  ) {
    throw new MonitorFault("config_invalid");
  }
  // Plain HTTP outside the explicit local loopback needs an operator decision.
  // This is a private monitoring client, not an Internet URL supplied by a user.
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol === "http:" && !loopback && !allowInsecure) throw new MonitorFault("config_invalid");
  return url.href;
}

export function parseMonitorConfig(value: unknown): MonitorConfig {
  const row = monitorFields(
    value,
    ["version", "allowInsecureHttp", "targets", "scrapeTimeoutMs", "runTimeoutMs", "policy", "rules"],
    "config_invalid",
  );
  if (row.version !== 1 || (row.allowInsecureHttp !== undefined && typeof row.allowInsecureHttp !== "boolean"))
    throw new MonitorFault("config_invalid");
  const allowInsecureHttp = row.allowInsecureHttp === true;
  if (!Array.isArray(row.targets) || row.targets.length < 1 || row.targets.length > 16)
    throw new MonitorFault("config_invalid");
  const targets: MonitorTarget[] = row.targets
    .map((value): MonitorTarget => {
      const target = monitorFields(value, ["id", "role", "metricsUrl"], "config_invalid");
      if (typeof target.id !== "string" || !/^[a-z][a-z0-9-]{0,47}$/.test(target.id))
        throw new MonitorFault("config_invalid");
      if (target.role !== "api" && target.role !== "notification-worker") throw new MonitorFault("config_invalid");
      return { id: target.id, role: target.role, metricsUrl: metricsUrl(target.metricsUrl, allowInsecureHttp) };
    })
    .sort((a, b) => a.id.localeCompare(b.id, "en"));
  if (
    new Set(targets.map((target) => target.id)).size !== targets.length ||
    new Set(targets.map((target) => target.metricsUrl)).size !== targets.length
  ) {
    throw new MonitorFault("config_invalid");
  }
  const overrides = monitorFields(
    row.policy === undefined ? {} : row.policy,
    Object.keys(POLICY_DEFAULTS),
    "config_invalid",
  );
  const policy = { ...POLICY_DEFAULTS };
  for (const key of Object.keys(POLICY_DEFAULTS) as (keyof MonitorPolicy)[]) {
    const [min, max] = POLICY_RANGES[key];
    policy[key] = setting(overrides[key], POLICY_DEFAULTS[key], min, max, key !== "httpErrorRatio");
  }
  if (policy.maxGapMs < policy.minIntervalMs || policy.windowMs < policy.minIntervalMs)
    throw new MonitorFault("config_invalid");
  const scrapeTimeoutMs = setting(row.scrapeTimeoutMs, 2000, 50, 10_000);
  const runTimeoutMs = setting(row.runTimeoutMs, 10_000, 50, 60_000);
  if (runTimeoutMs < scrapeTimeoutMs) throw new MonitorFault("config_invalid");
  const ruleOverrides = monitorFields(row.rules === undefined ? {} : row.rules, MONITOR_RULES, "config_invalid");
  const rules = {} as Record<MonitorRuleId, MonitorTiming>;
  for (const id of MONITOR_RULES) {
    const rule = monitorFields(
      ruleOverrides[id] === undefined ? {} : ruleOverrides[id],
      ["forMs", "resolveMs", "repeatMs"],
      "config_invalid",
    );
    const immediate = id === "notification_dead_letters" || id === "mail_delivery_failures";
    rules[id] = {
      forMs: setting(rule.forMs, immediate ? 0 : 60_000, 0, 900_000),
      resolveMs: setting(rule.resolveMs, 30_000, 0, 900_000),
      repeatMs: setting(rule.repeatMs, 3_600_000, 30_000, 86_400_000),
    };
  }
  const canonical = { version: 1 as const, allowInsecureHttp, targets, scrapeTimeoutMs, runTimeoutMs, policy, rules };
  const fingerprint = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  return { ...canonical, fingerprint };
}
