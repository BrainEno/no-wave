import { MonitorFault, type MonitorRole, type MonitorSnapshot } from "../application/operational-monitor.ts";

export const MONITOR_SCRAPE_MAX_BYTES = 4 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Sample = { labels: Record<string, string>; value: number };
type Family = { type: "counter" | "gauge" | null; samples: Sample[]; identities: Set<string> };
const API_FAMILIES = {
  api_process_instance_info: "gauge",
  api_http_requests_total: "counter",
  api_identity_mail_deliveries_total: "counter",
  api_readiness_available: "gauge",
  api_persistence_available: "gauge",
  api_notification_backlog_available: "gauge",
  api_notification_pending_events: "gauge",
  api_notification_dead_letter_events: "gauge",
  api_notification_oldest_pending_age_seconds: "gauge",
  api_notification_backlog_sample_timestamp_seconds: "gauge",
} as const;
const WORKER_FAMILIES = {
  notification_worker_process_instance_info: "gauge",
  notification_worker_ready: "gauge",
  api_outbox_pending_events: "gauge",
  api_outbox_dead_letter_events: "gauge",
  notification_worker_backlog_available: "gauge",
  notification_worker_backlog_sample_age_seconds: "gauge",
  notification_worker_backlog_sample_timestamp_seconds: "gauge",
  notification_worker_backlog_oldest_pending_age_seconds: "gauge",
  notification_worker_backlog_freshness_budget_seconds: "gauge",
} as const;
function invalid(): never {
  throw new MonitorFault("invalid_metrics");
}

/** A small bounded Prometheus 0.0.4 reader for the shipped exporter contract.
 * Unknown families (including histograms) are discarded, never retained as
 * labels or diagnostics. Known families reject ambiguity rather than sum it. */
function sampleLine(text: string, offset: number): Sample {
  const labels: Record<string, string> = Object.create(null) as Record<string, string>;
  const spaces = () => {
    while (text[offset] === " " || text[offset] === "\t") offset++;
  };
  if (text[offset] === "{") {
    offset++;
    spaces();
    while (text[offset] !== "}") {
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(offset))?.[0];
      if (!name || name.length > 64 || Object.hasOwn(labels, name) || Object.keys(labels).length >= 8) invalid();
      offset += name.length;
      spaces();
      if (text[offset++] !== "=") invalid();
      spaces();
      if (text[offset++] !== '"') invalid();
      let value = "";
      let closed = false;
      while (offset < text.length) {
        const character = text[offset++];
        if (character === '"') {
          closed = true;
          break;
        }
        if (character === "\\") {
          const escaped = text[offset++];
          if (escaped === "n") value += "\n";
          else if (escaped === "\\" || escaped === '"') value += escaped;
          else invalid();
        } else value += character;
        if (value.length > 256) invalid();
      }
      if (!closed) invalid();
      labels[name] = value;
      spaces();
      if (text[offset] !== ",") break;
      offset++;
      spaces();
      if (text[offset] === "}") invalid();
    }
    if (text[offset++] !== "}") invalid();
  }
  if (text[offset] !== " " && text[offset] !== "\t") invalid();
  const numeric = text.slice(offset).trim();
  if (numeric.length > 64 || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(numeric)) invalid();
  const value = Number(numeric);
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) invalid();
  return { labels, value };
}

function readFamilies(text: string, role: MonitorRole): Map<string, Family> {
  if (
    typeof text !== "string" ||
    Buffer.byteLength(text) > MONITOR_SCRAPE_MAX_BYTES ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)
  )
    invalid();
  const expected: Readonly<Record<string, "counter" | "gauge">> = role === "api" ? API_FAMILIES : WORKER_FAMILIES;
  const families = new Map<string, Family>(
    Object.keys(expected).map((name) => [name, { type: null, samples: [], identities: new Set<string>() }]),
  );
  const lines = text.split("\n");
  if (lines.length > 65_536) invalid();
  let count = 0;
  for (let line of lines) {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.length > 8192) invalid();
    if (!line.trim()) continue;
    if (line.startsWith("#")) {
      const type = /^# TYPE ([A-Za-z_:][A-Za-z0-9_:]*) (\w+)\s*$/.exec(line);
      if (type && families.has(type[1]!)) {
        const family = families.get(type[1]!)!;
        if (family.type !== null || type[2] !== expected[type[1]!]) invalid();
        family.type = type[2] as "counter" | "gauge";
      }
      continue;
    }
    const name = /^[A-Za-z_:][A-Za-z0-9_:]*/.exec(line)?.[0];
    if (!name) invalid();
    const family = families.get(name);
    if (!family) continue;
    if (++count > 4096) invalid();
    const sample = sampleLine(line, name.length);
    const identity = JSON.stringify(Object.entries(sample.labels).sort(([a], [b]) => a.localeCompare(b, "en")));
    if (family.identities.has(identity)) invalid();
    family.identities.add(identity);
    family.samples.push(sample);
  }
  for (const [name, family] of families) if (family.type !== expected[name]) invalid();
  return families;
}

function labelsExactly(sample: Sample, labels: readonly string[]): void {
  const keys = Object.keys(sample.labels);
  if (keys.length !== labels.length || keys.some((key) => !labels.includes(key))) invalid();
}
function scalar(families: Map<string, Family>, name: string): number {
  const family = families.get(name);
  if (!family || family.samples.length !== 1) invalid();
  const sample = family.samples[0]!;
  labelsExactly(sample, []);
  return sample.value;
}
function nonnegative(value: number): number {
  if (value < 0) invalid();
  return value;
}
function countValue(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}
function boolValue(value: number): boolean {
  if (value !== 0 && value !== 1) invalid();
  return value === 1;
}
function exporterInstance(families: Map<string, Family>, name: string): string {
  const samples = families.get(name)?.samples;
  if (!samples || samples.length !== 1) invalid();
  const sample = samples[0]!;
  labelsExactly(sample, ["instance"]);
  if (sample.value !== 1 || !UUID.test(sample.labels.instance!)) invalid();
  return sample.labels.instance!;
}
function backlog(
  pending: number,
  deadLetters: number,
  oldestAgeSeconds: number,
): NonNullable<MonitorSnapshot["backlog"]> {
  countValue(pending);
  countValue(deadLetters);
  nonnegative(oldestAgeSeconds);
  if (pending === 0 && oldestAgeSeconds !== 0) invalid();
  return { pending, deadLetters, oldestAgeSeconds };
}
function freshTimestamp(timestampSeconds: number, now: number, maxAgeMs: number): boolean {
  nonnegative(timestampSeconds);
  const sampledAt = timestampSeconds * 1000;
  if (!Number.isFinite(sampledAt) || sampledAt > Number.MAX_SAFE_INTEGER) invalid();
  return sampledAt > 0 && sampledAt <= now + 30_000 && now - sampledAt <= maxAgeMs;
}

function apiSnapshot(families: Map<string, Family>, now: number, maxAgeMs: number): MonitorSnapshot {
  const instance = exporterInstance(families, "api_process_instance_info");
  const ready = boolValue(scalar(families, "api_readiness_available"));
  const databaseAvailable = boolValue(scalar(families, "api_persistence_available"));
  const available = boolValue(scalar(families, "api_notification_backlog_available"));
  const observedBacklog = backlog(
    scalar(families, "api_notification_pending_events"),
    scalar(families, "api_notification_dead_letter_events"),
    scalar(families, "api_notification_oldest_pending_age_seconds"),
  );
  const fresh = freshTimestamp(scalar(families, "api_notification_backlog_sample_timestamp_seconds"), now, maxAgeMs);
  const http = { requests: 0, errors: 0 };
  for (const sample of families.get("api_http_requests_total")!.samples) {
    labelsExactly(sample, ["method", "route", "status"]);
    const { method, route, status } = sample.labels;
    if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "OTHER"].includes(method!)) invalid();
    if (
      !/^[1-5]\d{2}$/.test(status!) ||
      route!.length > 64 ||
      !/^(?:[a-z][a-z0-9]*(?:\.[a-z0-9-]+)*|\/(?:health|ready|metrics|not_found|api\/v1\/\*))$/.test(route!)
    )
      invalid();
    countValue(sample.value);
    if (["/health", "/ready", "/metrics", "health"].includes(route!)) continue;
    http.requests = countValue(http.requests + sample.value);
    if (Number(status) >= 500) http.errors = countValue(http.errors + sample.value);
  }
  let mailFailures = 0;
  for (const sample of families.get("api_identity_mail_deliveries_total")!.samples) {
    labelsExactly(sample, ["purpose", "outcome"]);
    if (
      !["password_reset", "email_verification", "other"].includes(sample.labels.purpose!) ||
      !["sent", "failed", "skipped"].includes(sample.labels.outcome!)
    )
      invalid();
    countValue(sample.value);
    if (sample.labels.outcome === "failed") mailFailures = countValue(mailFailures + sample.value);
  }
  return {
    instance,
    ready,
    databaseAvailable,
    backlog: available && fresh ? observedBacklog : null,
    http,
    mailFailures,
  };
}

function workerSnapshot(families: Map<string, Family>, now: number, maxAgeMs: number): MonitorSnapshot {
  const instance = exporterInstance(families, "notification_worker_process_instance_info");
  const ready = boolValue(scalar(families, "notification_worker_ready"));
  const available = boolValue(scalar(families, "notification_worker_backlog_available"));
  const age = scalar(families, "notification_worker_backlog_sample_age_seconds");
  const budget = nonnegative(scalar(families, "notification_worker_backlog_freshness_budget_seconds"));
  if (age < -1 || budget === 0 || budget > 120) invalid();
  const fresh = freshTimestamp(scalar(families, "notification_worker_backlog_sample_timestamp_seconds"), now, maxAgeMs);
  const observedBacklog = backlog(
    scalar(families, "api_outbox_pending_events"),
    scalar(families, "api_outbox_dead_letter_events"),
    scalar(families, "notification_worker_backlog_oldest_pending_age_seconds"),
  );
  return {
    instance,
    ready,
    databaseAvailable: null,
    backlog: available && fresh && age >= 0 && age <= budget && age * 1000 <= maxAgeMs ? observedBacklog : null,
    http: null,
    mailFailures: null,
  };
}

export function parseMonitorExposition(
  text: string,
  role: MonitorRole,
  now: number,
  maxAgeMs: number,
): MonitorSnapshot {
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(maxAgeMs) ||
    maxAgeMs < 1 ||
    (role !== "api" && role !== "notification-worker")
  )
    invalid();
  const families = readFamilies(text, role);
  return role === "api" ? apiSnapshot(families, now, maxAgeMs) : workerSnapshot(families, now, maxAgeMs);
}
