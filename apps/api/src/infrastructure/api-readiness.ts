import { accessIssuerConfiguration } from "../security/authentication.ts";
import { readinessSettings } from "./service-settings.ts";
import { validatedBacklog, type OutboxSnapshot } from "./outbox-backlog.ts";

type Dependencies = { health?: () => unknown; outboxBacklog?: () => unknown };
type NotificationStatus = "ok" | "backlogged" | "unavailable";
type Sample<T> = { value: T; sampledAt: number; observedAt: number };
type Attempt<T> = { startedAt: number; promise: Promise<void>; sample: Sample<T> | null; settledAt: number | null; failed: boolean; timedOut: boolean };
export type ApiReadiness = {
  status: "ready" | "not_ready";
  service: "api";
  persistence: "ok" | "unavailable";
  auth: "ok" | "unavailable";
  notifications: {
    status: NotificationStatus;
    pendingEvents: number | null;
    deadLetterEvents: number | null;
    oldestPendingAgeMs: number | null;
    sampledAt: string | null;
  };
};


/** One in-flight read per dependency, even after a probe times out. A stalled
 * driver must not turn simultaneous load-balancer scrapes into a query storm.
 * Last-known gauges survive failures, but stale data never grants readiness. */
export function createApiReadiness({
  services, env = process.env, now = performance.now.bind(performance), wallNow = Date.now,
}: { services: Dependencies | null; env?: NodeJS.ProcessEnv; now?: () => number; wallNow?: () => number }) {
  const settings = readinessSettings(env);
  let closed = false;
  let database: Attempt<true> | null = null;
  let backlog: Attempt<OutboxSnapshot> | null = null;
  let reads = 0;
  let timeouts = 0;
  let failures = 0;
  let releaseProbes!: () => void;
  const closing = new Promise<void>(resolve => { releaseProbes = resolve; });

  function expireRead(attempt: Pick<Attempt<unknown>, "timedOut" | "failed">): void {
    if (closed || attempt.timedOut) return;
    attempt.timedOut = true;
    attempt.failed = true;
    failures += 1;
  }
  function launch<T>(previous: Attempt<T> | null, read: () => unknown, validate: (value: unknown) => T): Attempt<T> {
    const attempt: Attempt<T> = { startedAt: now(), settledAt: null, promise: Promise.resolve(),
      sample: previous?.sample ?? null, failed: true, timedOut: false };
    reads += 1;
    attempt.promise = Promise.resolve().then(() => closed ? undefined : read()).then(value => {
      if (closed) return;
      if (attempt.timedOut || now() - attempt.startedAt > settings.timeoutMs) { expireRead(attempt); return; }
      const validated = validate(value);
      attempt.sample = { value: validated, sampledAt: wallNow(), observedAt: now() };
      attempt.failed = false;
    }).catch(() => {
      if (!closed && !attempt.timedOut) {
        failures += 1;
        attempt.failed = true;
      }
    }).finally(() => { attempt.settledAt = now(); });
    return attempt;
  }

  function expired<T>(attempt: Attempt<T> | null): boolean {
    return !attempt || (attempt.settledAt !== null && now() - attempt.settledAt >= settings.cacheMs);
  }
  function healthy<T>(attempt: Attempt<T> | null): attempt is Attempt<T> & { sample: Sample<T> } {
    return !closed && attempt !== null && attempt.settledAt !== null && !attempt.failed && attempt.sample !== null;
  }
  async function collect(): Promise<void> {
    if (closed) return;
    if (expired(database)) database = launch(database, () => {
      if (!services?.health) throw new Error("Persistence is unavailable.");
      return services.health();
    }, value => {
      if (value !== true) throw new TypeError("Persistence health did not succeed.");
      return true;
    });
    if (expired(backlog)) backlog = launch(backlog, () => {
      if (!services?.outboxBacklog) throw new Error("Notifications are unavailable.");
      return services.outboxBacklog();
    }, validatedBacklog);
    const pending = [database!, backlog!].filter(attempt => attempt.settledAt === null);
    if (!pending.length) return;
    const remainingMs = Math.max(0, Math.min(...pending.map(attempt => settings.timeoutMs - (now() - attempt.startedAt))));
    const deadlineReached = () => {
      timeouts += 1;
      for (const attempt of pending) if (attempt.settledAt === null && now() - attempt.startedAt >= settings.timeoutMs) expireRead(attempt);
    };
    if (remainingMs === 0) { deadlineReached(); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(pending.map(attempt => attempt.promise)), closing,
        new Promise<void>(resolve => { timer = setTimeout(() => { deadlineReached(); resolve(); }, Math.ceil(remainingMs)); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  function notificationStatus(): ApiReadiness["notifications"] {
    const sample = backlog?.sample ?? null;
    const elapsed = sample ? Math.max(0, Math.floor(now() - sample.observedAt)) : 0;
    const oldestPendingAgeMs = sample
      ? Math.min(Number.MAX_SAFE_INTEGER, sample.value.oldestPendingAgeMs + (sample.value.pendingEvents > 0 ? elapsed : 0))
      : null;
    const status: NotificationStatus = !healthy(backlog) ? "unavailable"
      : oldestPendingAgeMs !== null && oldestPendingAgeMs > settings.maxPendingAgeMs ? "backlogged" : "ok";
    return { status, pendingEvents: sample?.value.pendingEvents ?? null,
      deadLetterEvents: sample?.value.deadLetterEvents ?? null, oldestPendingAgeMs,
      sampledAt: sample ? new Date(sample.sampledAt).toISOString() : null };
  }

  async function read(): Promise<ApiReadiness> {
    let auth: ApiReadiness["auth"] = "ok";
    try { accessIssuerConfiguration(env); } catch { auth = "unavailable"; }
    await collect();
    const persistence = healthy(database) ? "ok" : "unavailable";
    const notifications = notificationStatus();
    const ready = !closed && persistence === "ok" && auth === "ok" && notifications.status === "ok";
    return { status: ready ? "ready" : "not_ready", service: "api", persistence, auth, notifications };
  }

  async function renderMetrics(): Promise<string> {
    const status = await read();
    const sample = backlog?.sample;
    const inflightAges = [database, backlog].flatMap(attempt => attempt && attempt.settledAt === null
      ? [Math.max(0, now() - attempt.startedAt) / 1000] : []);
    const gauges: [string, string, number][] = [
      ["api_readiness_available", "All API readiness dependencies currently available.", status.status === "ready" ? 1 : 0],
      ["api_readiness_inflight_reads", "Dependency queries still owned, including timed-out queries; at most two.", inflightAges.length],
      ["api_readiness_oldest_inflight_read_seconds", "Monotonic age of the oldest owned dependency query; zero when none.", Math.max(0, ...inflightAges)],
      ["api_notification_backlog_available", "Notification backlog read succeeded; zero means unavailable, not an empty queue.", status.notifications.status === "unavailable" ? 0 : 1],
      ["api_notification_pending_events", "Last observed nonterminal events, including delayed retries and live leases.", sample?.value.pendingEvents ?? 0],
      ["api_notification_dead_letter_events", "Retained notification dead letters requiring operator investigation.", sample?.value.deadLetterEvents ?? 0],
      ["api_notification_oldest_pending_age_seconds", "Age of the oldest observed pending event, advanced between samples.", (status.notifications.oldestPendingAgeMs ?? 0) / 1000],
      ["api_notification_backlog_sample_timestamp_seconds", "Timestamp of the most recent successful notification backlog read.", (sample?.sampledAt ?? 0) / 1000],
      ["api_notification_backlog_max_age_seconds", "Pending event age above which API readiness fails.", settings.maxPendingAgeMs / 1000],
    ];
    const counters: [string, string, number][] = [
      ["api_readiness_dependency_reads_total", "Coalesced dependency reads started by operational probes.", reads],
      ["api_readiness_dependency_failures_total", "Failed or invalid dependency reads without exception details.", failures],
      ["api_readiness_probe_timeouts_total", "Probe waits bounded by the readiness deadline.", timeouts],
    ];
    const lines: string[] = [];
    for (const [name, help, value] of gauges) lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${value}`);
    for (const [name, help, value] of counters) lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`, `${name} ${value}`);
    return lines.join("\n") + "\n";
  }

  function close(): void {
    closed = true;
    releaseProbes();
  }
  return Object.freeze({ read, renderMetrics, close });
}
