import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { BackgroundFailure } from "../application/background-tasks.ts";

const HISTOGRAM_BUCKETS_MS = Object.freeze([5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]);
const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
const SAFE_OPERATION = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

type LogLevel = "info" | "warn" | "error";
type LogRecord = {
  timestamp: string;
  level: LogLevel;
  component: "api";
  event: string;
  [key: string]: string | number | boolean | null;
};
type Histogram = { count: number; sum: number; buckets: number[] };
type RequestMetric = { method: string; route: string; status: string; count: number; duration: Histogram };
type PersistenceMetric = { operation: string; outcome: string; count: number; duration: Histogram };
type MailMetric = { purpose: string; outcome: string; count: number; duration: Histogram };
type BackgroundFailureMetric = { task: string; count: number };

/**
 * Account-mail purposes, as a closed set.
 *
 * A metric label is attacker-influenced the moment it is copied from a request,
 * so a purpose is only ever one of these two strings — anything else collapses
 * to `other` rather than becoming an unbounded cardinality.
 */
const MAIL_PURPOSES = Object.freeze(["password_reset", "email_verification"]);
const MAIL_OUTCOMES = Object.freeze(["sent", "failed", "skipped"]);

/**
 * Background tasks, as a closed set — same rule as `MAIL_PURPOSES`.
 *
 * `errorName` is deliberately *not* a label: error classes are open-ended (every
 * driver and every runtime version contributes its own), and the counter exists
 * to answer "is the cleanup working", which one label answers. The class travels
 * in the log line next to it.
 */
const BACKGROUND_TASKS = Object.freeze(["identity-prune", "tombstone-purge", "tombstone-notifications"]);

function newHistogram(): Histogram {
  return { count: 0, sum: 0, buckets: HISTOGRAM_BUCKETS_MS.map(() => 0) };
}

function observe(histogram: Histogram, durationMs: number): void {
  const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  histogram.count += 1;
  histogram.sum += duration;
  HISTOGRAM_BUCKETS_MS.forEach((upperBound, index) => {
    if (duration <= upperBound) histogram.buckets[index] += 1;
  });
}

function safeMethod(method: string | undefined): string {
  switch (method) {
    case "GET":
    case "HEAD":
    case "POST":
    case "PUT":
    case "PATCH":
    case "DELETE":
    case "OPTIONS":
      return method;
    default:
      return "OTHER";
  }
}

/**
 * Route ids a handler may label itself with (`articles.item`, `imports.notion`).
 *
 * The initial label is derived from the URL and collapses every versioned path
 * into `/api/v1/*`, which is right for an *unmatched* request — there is no route
 * id to name — and useless for a matched one: a flood of one endpoint reads as a
 * flood of "the API", and the histogram cannot say which endpoint is slow. A
 * matched route therefore relabels itself with its id from the route table, which
 * is a closed set: no path, no id, no query value ever enters the label.
 */
const ROUTE_ID_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z0-9-]+)*$/;

/** Labels that a deployment probes on a timer rather than a person's request. */
const PROBE_ROUTES = Object.freeze(["/health", "/ready", "health"]);

/**
 * A client in a loop is a fact, and a terminal full of it is not a diagnosis.
 *
 * `FLOOD_THRESHOLD` requests on one route inside one second is far more than any
 * page makes and is what a retry loop, a tab stuck on reload or a monitor with no
 * interval looks like. One warning per route per `FLOOD_QUIET_MS` says so once:
 * "250 requests in 1 s on `health`" is the sentence the operator needed, and the
 * individual lines — suppressed for probes, still written for everything else —
 * are noise around it. The label counter is bounded by the route table, so the
 * bookkeeping cannot grow with traffic.
 */
const FLOOD_WINDOW_MS = 1_000;
const FLOOD_THRESHOLD = 200;
const FLOOD_QUIET_MS = 30_000;

function safeRoute(request: IncomingMessage): string {
  let pathname = "/";
  try {
    pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  } catch {
    return "/not_found";
  }
  if (pathname === "/health") return "/health";
  if (pathname === "/ready") return "/ready";
  if (pathname === "/metrics") return "/metrics";
  if (pathname === "/api/v1" || pathname.startsWith("/api/v1/")) return "/api/v1/*";
  return "/not_found";
}

function traceIdFor(request: IncomingMessage): string {
  const traceparent = request.headers.traceparent;
  if (typeof traceparent === "string") {
    const match = TRACEPARENT_PATTERN.exec(traceparent);
    if (match && !/^0+$/.test(match[1])) return match[1].toLowerCase();
  }
  return randomBytes(16).toString("hex");
}

/** Emit only explicitly assembled fields; request headers, URLs and bodies are never logged. */
export function writeStructuredLog(entry: Omit<LogRecord, "timestamp" | "component"> & Partial<Pick<LogRecord, "timestamp" | "component">>): void {
  const record: LogRecord = {
    timestamp: entry.timestamp ?? new Date().toISOString(),
    level: entry.level,
    component: "api",
    event: entry.event,
    ...entry,
  } as LogRecord;
  const line = JSON.stringify(record) + "\n";
  try {
    if (record.level === "warn" || record.level === "error") process.stderr.write(line);
    else process.stdout.write(line);
  } catch {
    // Logging must never turn an otherwise successful request into a failure.
  }
}

/**
 * Request metrics use bounded route/method/status labels. They intentionally
 * omit path IDs, query values, identity, remote address, and all request data.
 */
export function createHttpObservability({
  logger = writeStructuredLog,
}: {
  logger?: (record: LogRecord) => void;
} = {}) {
  const requests = new Map<string, RequestMetric>();
  const authFailures = new Map<string, { method: string; status: string; count: number }>();
  const persistence = new Map<string, PersistenceMetric>();
  const mail = new Map<string, MailMetric>();
  const backgroundFailures = new Map<string, BackgroundFailureMetric>();
  let activeRequests = 0;

  function log(record: Omit<LogRecord, "timestamp" | "component">): void {
    try {
      logger({ timestamp: new Date().toISOString(), component: "api", ...record } as LogRecord);
    } catch {
      // Observability callbacks are best effort and must not affect request semantics.
    }
  }

  function observePersistenceOperation({
    operation,
    durationMs,
    success,
  }: {
    operation: string;
    durationMs: number;
    success: boolean;
  }): void {
    const label = SAFE_OPERATION.test(operation) ? operation : "other";
    const outcome = success ? "success" : "error";
    const key = label + "\u0000" + outcome;
    let metric = persistence.get(key);
    if (!metric) {
      metric = { operation: label, outcome, count: 0, duration: newHistogram() };
      persistence.set(key, metric);
    }
    metric.count += 1;
    observe(metric.duration, durationMs);
  }

  /**
   * Record the outcome of one account-mail delivery attempt.
   *
   * Recovery fails silently without this: the request answers `202` whether or
   * not the mail went out, because the token is already stored and the user can
   * simply ask again. That is the right answer for the caller and the wrong
   * answer for the operator — a relay that has been down since Tuesday is
   * invisible from the HTTP status code, and users do not report "the mail never
   * came", they just leave.
   *
   * The counter is what an alert rules on; the log line is what a human reads
   * afterwards. Both come from this one call, so they cannot disagree.
   */
  function observeMailDelivery({ purpose, outcome, durationMs, code, message }: {
    purpose: string;
    outcome: string;
    durationMs: number;
    code?: string;
    message?: string;
  }): void {
    const safePurpose = MAIL_PURPOSES.includes(purpose) ? purpose : "other";
    const safeOutcome = MAIL_OUTCOMES.includes(outcome) ? outcome : "failed";
    const key = safePurpose + "\u0000" + safeOutcome;
    let metric = mail.get(key);
    if (!metric) {
      metric = { purpose: safePurpose, outcome: safeOutcome, count: 0, duration: newHistogram() };
      mail.set(key, metric);
    }
    metric.count += 1;
    observe(metric.duration, durationMs);

    if (safeOutcome === "sent") {
      log({ level: "info", event: "identity_mail_delivered", purpose: safePurpose, durationMs: Math.round(durationMs) });
      return;
    }
    // A skipped delivery is not a failed one, and a log line that says
    // "could not be delivered" for a feature that is simply off sends whoever
    // greps it looking for a broken relay.
    const skipped = safeOutcome === "skipped";
    log({
      level: skipped ? "info" : "error",
      event: skipped ? "identity_mail_skipped" : "identity_mail_failed",
      purpose: safePurpose,
      // The address is deliberately absent: a mailbox in a failure log is a
      // mailing list, and this line is the one people grep.
      code: code && SAFE_OPERATION.test(code) ? code : skipped ? "MAIL_SKIPPED" : "MAIL_FAILED",
      message: typeof message === "string" && message.length > 0
        ? message.slice(0, 240)
        : skipped ? "No mail was sent because account mail is switched off." : "The mail could not be delivered.",
    });
  }

  /**
   * Record one background task that failed (audit F-22).
   *
   * The cleanup sweeps and the deletion notices are work no request is waiting
   * for, so their failures cannot surface in an HTTP status. A sweep that has
   * been failing since Tuesday looks exactly like a database with nothing to
   * clean. The counter is what an alert rules on; the log line, with the error
   * class and no driver text, is what a human reads afterwards.
   */
  function observeBackgroundFailure({ task, errorName, failed }: BackgroundFailure): void {
    const safeTask = BACKGROUND_TASKS.includes(task) ? task : "other";
    const metric = backgroundFailures.get(safeTask) ?? { task: safeTask, count: 0 };
    metric.count += 1;
    backgroundFailures.set(safeTask, metric);

    log({
      level: "warn",
      event: "background_task_failed",
      task: safeTask,
      errorName: SAFE_OPERATION.test(errorName) ? errorName : "Error",
      ...(typeof failed === "number" && Number.isInteger(failed) && failed > 0 ? { failed } : {}),
    });
  }

  /** Per-route request rate, for the flood notice only. */
  const floodWindows = new Map<string, { windowStart: number; count: number; warnedAt: number }>();

  /**
   * Count one completed request and, when a route is being hammered, say so once.
   *
   * Deliberately not a rate limiter: nothing is refused here. The API answered
   * every one of those requests correctly — the problem is the caller, and the
   * one line this writes is enough to find it.
   */
  function noteRequestRate(route: string, now: number): void {
    const entry = floodWindows.get(route);
    if (!entry || now - entry.windowStart >= FLOOD_WINDOW_MS) {
      floodWindows.set(route, { windowStart: now, count: 1, warnedAt: entry?.warnedAt ?? 0 });
      return;
    }
    entry.count += 1;
    if (entry.count < FLOOD_THRESHOLD || now - entry.warnedAt < FLOOD_QUIET_MS) return;
    entry.warnedAt = now;
    log({
      level: "warn",
      event: "http_request_flood",
      route,
      requestsPerSecond: entry.count,
      message: "One client is requesting this route in a loop; the API is answering, the caller is the problem.",
    });
  }

  function beginRequest(request: IncomingMessage, response: ServerResponse) {
    const requestId = randomUUID();
    const traceId = traceIdFor(request);
    const method = safeMethod(request.method);
    let route = safeRoute(request);
    // Whether this is a versioned API request, decided before a route can rename
    // itself: the authentication-failure counter is about the API's `401`s, and it
    // must not stop counting just because the label became `me.profile`.
    const apiRequest = route === "/api/v1/*";
    let labelled = false;
    response.setHeader("x-request-id", requestId);
    activeRequests += 1;
    let finished = false;

    return Object.freeze({
      requestId,
      traceId,
      method,
      /**
       * Name the endpoint that matched, once.
       *
       * Called by the transport after route resolution, when the route id is
       * finally known. Only the first assignment wins and only a shape from the
       * route table is accepted, so neither a handler nor a URL can invent a
       * label — an unbounded label is how a metrics backend falls over.
       */
      assignRoute(routeId: string) {
        if (labelled || finished) return;
        if (typeof routeId !== "string" || routeId.length === 0 || routeId.length > 64) return;
        if (!ROUTE_ID_PATTERN.test(routeId)) return;
        route = routeId;
        labelled = true;
      },
      get route() { return route; },
      finish({
        statusCode,
        durationMs,
        errorName,
      }: {
        statusCode: number;
        durationMs: number;
        errorName?: string;
      }) {
        if (finished) return;
        finished = true;
        activeRequests = Math.max(0, activeRequests - 1);
        const status = String(Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599 ? statusCode : 500);
        const key = method + "\u0000" + route + "\u0000" + status;
        let metric = requests.get(key);
        if (!metric) {
          metric = { method, route, status, count: 0, duration: newHistogram() };
          requests.set(key, metric);
        }
        metric.count += 1;
        observe(metric.duration, durationMs);
        if (apiRequest && (status === "401" || status === "403")) {
          const authKey = method + "\u0000" + status;
          const authMetric = authFailures.get(authKey) ?? { method, status, count: 0 };
          authMetric.count += 1;
          authFailures.set(authKey, authMetric);
        }

        noteRequestRate(route, Date.now());
        const numericStatus = Number(status);
        const level: LogLevel = errorName || numericStatus >= 500
          ? "error"
          : numericStatus >= 400 ? "warn" : "info";
        // A successful liveness or readiness probe is a timer, not a reader. It
        // stays in the metrics — the count and the latency are the point — but it
        // does not get a log line: a host probing every second would otherwise
        // be the loudest thing in the terminal, and a misconfigured client probing
        // in a loop buries every line that matters. A *failing* probe is logged,
        // because that is the one an operator has to see.
        if (level === "info" && PROBE_ROUTES.includes(route)) return;
        log({
          level,
          event: "http_request_completed",
          requestId,
          traceId,
          method,
          route,
          statusCode: numericStatus,
          durationMs: Number.isFinite(durationMs) ? Math.round(Math.max(0, durationMs) * 1000) / 1000 : 0,
          ...(errorName ? { errorName: /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(errorName) ? errorName : "Error" } : {}),
        });
      },
    });
  }

  function renderMetrics(): string {
    const lines = [
      "# HELP api_http_requests_total Completed HTTP requests.",
      "# TYPE api_http_requests_total counter",
    ];
    for (const metric of [...requests.values()].sort((a, b) =>
      a.method.localeCompare(b.method) || a.route.localeCompare(b.route) || a.status.localeCompare(b.status))) {
      lines.push(`api_http_requests_total{method="${metric.method}",route="${metric.route}",status="${metric.status}"} ${metric.count}`);
    }

    lines.push(
      "# HELP api_http_request_duration_ms HTTP request duration in milliseconds.",
      "# TYPE api_http_request_duration_ms histogram",
    );
    for (const metric of [...requests.values()].sort((a, b) =>
      a.method.localeCompare(b.method) || a.route.localeCompare(b.route) || a.status.localeCompare(b.status))) {
      HISTOGRAM_BUCKETS_MS.forEach((bound, index) => {
        lines.push(`api_http_request_duration_ms_bucket{method="${metric.method}",route="${metric.route}",status="${metric.status}",le="${bound}"} ${metric.duration.buckets[index]}`);
      });
      lines.push(`api_http_request_duration_ms_bucket{method="${metric.method}",route="${metric.route}",status="${metric.status}",le="+Inf"} ${metric.duration.count}`);
      lines.push(`api_http_request_duration_ms_sum{method="${metric.method}",route="${metric.route}",status="${metric.status}"} ${metric.duration.sum.toFixed(3)}`);
      lines.push(`api_http_request_duration_ms_count{method="${metric.method}",route="${metric.route}",status="${metric.status}"} ${metric.duration.count}`);
    }

    lines.push(
      "# HELP api_http_active_requests Current active HTTP requests.",
      "# TYPE api_http_active_requests gauge",
      `api_http_active_requests ${activeRequests}`,
      "# HELP api_http_auth_failures_total API requests rejected with HTTP 401 or 403.",
      "# TYPE api_http_auth_failures_total counter",
    );
    for (const metric of [...authFailures.values()].sort((a, b) =>
      a.method.localeCompare(b.method) || a.status.localeCompare(b.status))) {
      lines.push(`api_http_auth_failures_total{method="${metric.method}",status="${metric.status}"} ${metric.count}`);
    }

    lines.push(
      "# HELP api_persistence_operations_total Completed persistence port operations.",
      "# TYPE api_persistence_operations_total counter",
    );
    for (const metric of [...persistence.values()].sort((a, b) =>
      a.operation.localeCompare(b.operation) || a.outcome.localeCompare(b.outcome))) {
      lines.push(`api_persistence_operations_total{operation="${metric.operation}",outcome="${metric.outcome}"} ${metric.count}`);
    }

    lines.push(
      "# HELP api_persistence_operation_duration_ms Persistence port operation duration in milliseconds.",
      "# TYPE api_persistence_operation_duration_ms histogram",
    );
    for (const metric of [...persistence.values()].sort((a, b) =>
      a.operation.localeCompare(b.operation) || a.outcome.localeCompare(b.outcome))) {
      HISTOGRAM_BUCKETS_MS.forEach((bound, index) => {
        lines.push(`api_persistence_operation_duration_ms_bucket{operation="${metric.operation}",outcome="${metric.outcome}",le="${bound}"} ${metric.duration.buckets[index]}`);
      });
      lines.push(`api_persistence_operation_duration_ms_bucket{operation="${metric.operation}",outcome="${metric.outcome}",le="+Inf"} ${metric.duration.count}`);
      lines.push(`api_persistence_operation_duration_ms_sum{operation="${metric.operation}",outcome="${metric.outcome}"} ${metric.duration.sum.toFixed(3)}`);
      lines.push(`api_persistence_operation_duration_ms_count{operation="${metric.operation}",outcome="${metric.outcome}"} ${metric.duration.count}`);
    }

    lines.push(
      "# HELP api_background_task_failures_total Background cleanup and notice tasks that failed.",
      "# TYPE api_background_task_failures_total counter",
    );
    for (const metric of [...backgroundFailures.values()].sort((a, b) => a.task.localeCompare(b.task))) {
      lines.push(`api_background_task_failures_total{task="${metric.task}"} ${metric.count}`);
    }

    lines.push(
      "# HELP api_identity_mail_deliveries_total Account-mail delivery attempts by purpose and outcome.",
      "# TYPE api_identity_mail_deliveries_total counter",
    );
    for (const metric of [...mail.values()].sort((a, b) =>
      a.purpose.localeCompare(b.purpose) || a.outcome.localeCompare(b.outcome))) {
      lines.push(`api_identity_mail_deliveries_total{purpose="${metric.purpose}",outcome="${metric.outcome}"} ${metric.count}`);
    }

    lines.push(
      "# HELP api_identity_mail_delivery_duration_ms Account-mail delivery duration in milliseconds.",
      "# TYPE api_identity_mail_delivery_duration_ms histogram",
    );
    for (const metric of [...mail.values()].sort((a, b) =>
      a.purpose.localeCompare(b.purpose) || a.outcome.localeCompare(b.outcome))) {
      HISTOGRAM_BUCKETS_MS.forEach((bound, index) => {
        lines.push(`api_identity_mail_delivery_duration_ms_bucket{purpose="${metric.purpose}",outcome="${metric.outcome}",le="${bound}"} ${metric.duration.buckets[index]}`);
      });
      lines.push(`api_identity_mail_delivery_duration_ms_bucket{purpose="${metric.purpose}",outcome="${metric.outcome}",le="+Inf"} ${metric.duration.count}`);
      lines.push(`api_identity_mail_delivery_duration_ms_sum{purpose="${metric.purpose}",outcome="${metric.outcome}"} ${metric.duration.sum.toFixed(3)}`);
      lines.push(`api_identity_mail_delivery_duration_ms_count{purpose="${metric.purpose}",outcome="${metric.outcome}"} ${metric.duration.count}`);
    }
    return lines.join("\n") + "\n";
  }

  return Object.freeze({ beginRequest, observePersistenceOperation, observeMailDelivery, observeBackgroundFailure, renderMetrics });
}
