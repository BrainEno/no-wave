import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

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

  function beginRequest(request: IncomingMessage, response: ServerResponse) {
    const requestId = randomUUID();
    const traceId = traceIdFor(request);
    const method = safeMethod(request.method);
    const route = safeRoute(request);
    response.setHeader("x-request-id", requestId);
    activeRequests += 1;
    let finished = false;

    return Object.freeze({
      requestId,
      traceId,
      method,
      route,
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
        if (route === "/api/v1/*" && (status === "401" || status === "403")) {
          const authKey = method + "\u0000" + status;
          const authMetric = authFailures.get(authKey) ?? { method, status, count: 0 };
          authMetric.count += 1;
          authFailures.set(authKey, authMetric);
        }

        const numericStatus = Number(status);
        const level: LogLevel = errorName || numericStatus >= 500
          ? "error"
          : numericStatus >= 400 ? "warn" : "info";
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
    return lines.join("\n") + "\n";
  }

  return Object.freeze({ beginRequest, observePersistenceOperation, renderMetrics });
}
