import { UpstreamTimeoutError } from "./api.ts";
import { ADMISSION_WAIT_BUCKETS_MS, type AdmissionSnapshot } from "./upstream-admission.ts";
import type { CircuitSnapshot } from "./upstream-circuit.ts";
import { UpstreamBusyError, UpstreamCancelledError, UpstreamResponseError } from "./upstream-errors.ts";

export const UPSTREAM_KINDS = ["api", "auth", "media", "content", "crawl", "export"] as const;
export const UPSTREAM_OUTCOMES = ["ok", "http_error", "timeout", "cancelled", "too_large", "invalid_response", "network", "capacity", "queue_timeout", "closing", "circuit_open"] as const;
export type UpstreamKind = (typeof UPSTREAM_KINDS)[number];
export type UpstreamOutcome = (typeof UPSTREAM_OUTCOMES)[number];
export type UpstreamSample = { kind: UpstreamKind; outcome: UpstreamOutcome; durationMs: number; bytes: number; status?: number };
export type UpstreamObserver = (sample: UpstreamSample) => void;
const BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 120] as const;
type Counters = { outcomes: Record<UpstreamOutcome, number>; statuses: number[]; bytes: number; duration: number; count: number; buckets: number[] };

export function upstreamOutcome(error: unknown): UpstreamOutcome {
  if (error instanceof UpstreamTimeoutError) return "timeout";
  if (error instanceof UpstreamCancelledError) return "cancelled";
  if (error instanceof UpstreamResponseError) return error.reason === "too-large" ? "too_large" : "invalid_response";
  if (error instanceof UpstreamBusyError) return error.reason === "queue-timeout" ? "queue_timeout" : error.reason === "circuit-open" ? "circuit_open" : error.reason;
  return "network";
}

/** Observer failures never invalidate a write or cause a second rotation. */
export function observeUpstream(observer: UpstreamObserver | undefined, sample: UpstreamSample): void {
  try { observer?.(sample); } catch { /* Operational telemetry is best effort. */ }
}

function counters(): Counters {
  return { outcomes: Object.fromEntries(UPSTREAM_OUTCOMES.map(name => [name, 0])) as Record<UpstreamOutcome, number>,
    statuses: [0, 0, 0, 0, 0, 0], bytes: 0, duration: 0, count: 0, buckets: BUCKETS.map(() => 0) };
}
function increment(current: number, by = 1): number {
  return Math.min(Number.MAX_SAFE_INTEGER, current + by);
}

/** Fixed cardinality only: no URL/path/account/exception/message is a label. */
export class UpstreamTelemetry {
  private readonly series = new Map<UpstreamKind, Counters>(UPSTREAM_KINDS.map(kind => [kind, counters()]));
  private invalidSamples = 0;

  observe(sample: UpstreamSample): void {
    const values = this.series.get(sample.kind);
    if (!values || !(UPSTREAM_OUTCOMES as readonly string[]).includes(sample.outcome) ||
        !Number.isFinite(sample.durationMs) || sample.durationMs < 0 || !Number.isSafeInteger(sample.bytes) || sample.bytes < 0 ||
        (sample.status !== undefined && (!Number.isInteger(sample.status) || sample.status < 200 || sample.status > 599))) {
      this.invalidSamples = increment(this.invalidSamples);
      return;
    }
    const seconds = sample.durationMs / 1000;
    values.outcomes[sample.outcome] = increment(values.outcomes[sample.outcome]);
    values.count = increment(values.count);
    values.duration = increment(values.duration, seconds);
    values.bytes = increment(values.bytes, sample.bytes);
    if (sample.status !== undefined) {
      const index = Math.floor(sample.status / 100);
      values.statuses[index] = increment(values.statuses[index]!);
    }
    for (let index = 0; index < BUCKETS.length; index++) {
      if (seconds <= BUCKETS[index]!) values.buckets[index] = increment(values.buckets[index]!);
    }
  }

  render(snapshot: AdmissionSnapshot, circuits?: CircuitSnapshot): string {
    const lines: string[] = [];
    const describe = (name: string, type: "counter" | "gauge" | "histogram", help: string) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    };
    describe("web_upstream_requests_total", "counter", "Completed upstream operations including rejected admissions.");
    for (const [kind, values] of this.series) {
      for (const outcome of UPSTREAM_OUTCOMES) lines.push(`web_upstream_requests_total{kind="${kind}",outcome="${outcome}"} ${values.outcomes[outcome]}`);
    }
    describe("web_upstream_response_bytes_total", "counter", "Decoded response bytes buffered or forwarded before completion; rejected chunks are not included.");
    for (const [kind, values] of this.series) lines.push(`web_upstream_response_bytes_total{kind="${kind}"} ${values.bytes}`);
    describe("web_upstream_http_responses_total", "counter", "Observed upstream responses by status class.");
    for (const [kind, values] of this.series) {
      for (let status = 2; status <= 5; status++) lines.push(`web_upstream_http_responses_total{kind="${kind}",class="${status}xx"} ${values.statuses[status]}`);
    }
    describe("web_upstream_duration_seconds", "histogram", "Admission plus connection and response consumption duration.");
    for (const [kind, values] of this.series) {
      for (const [index, bound] of BUCKETS.entries()) {
        lines.push(`web_upstream_duration_seconds_bucket{kind="${kind}",le="${bound}"} ${values.buckets[index]}`);
      }
      lines.push(`web_upstream_duration_seconds_bucket{kind="${kind}",le="+Inf"} ${values.count}`,
        `web_upstream_duration_seconds_sum{kind="${kind}"} ${values.duration}`,
        `web_upstream_duration_seconds_count{kind="${kind}"} ${values.count}`);
    }
    for (const [field, help] of [["active", "Upstream slots owned until the underlying operation actually ends."],
      ["queued", "Operations waiting for an upstream slot."], ["concurrency", "Maximum active upstream operations."],
      ["capacity", "Maximum queued upstream operations."]] as const) {
      describe(`web_upstream_${field}`, "gauge", help);
      for (const lane of ["data", "auth", "bulk"] as const) {
        const value = snapshot[lane][field];
        lines.push(`web_upstream_${field}{lane="${lane}"} ${Number.isSafeInteger(value) && value >= 0 ? value : 0}`);
      }
    }
    describe("web_upstream_admission_wait_seconds", "histogram", "Time until a slot was granted or refused, including cancellation and queue expiry.");
    for (const lane of ["data", "auth", "bulk"] as const) {
      const wait = snapshot[lane].wait;
      for (const [index, bound] of ADMISSION_WAIT_BUCKETS_MS.entries()) {
        lines.push(`web_upstream_admission_wait_seconds_bucket{lane="${lane}",le="${bound / 1000}"} ${wait.buckets[index]}`);
      }
      lines.push(`web_upstream_admission_wait_seconds_bucket{lane="${lane}",le="+Inf"} ${wait.count}`,
        `web_upstream_admission_wait_seconds_sum{lane="${lane}"} ${wait.totalMs / 1000}`,
        `web_upstream_admission_wait_seconds_count{lane="${lane}"} ${wait.count}`);
    }
    for (const [field, help] of [["detached", "Physical operations whose public lifecycle has finished."],
      ["cancelling", "Physical operations still owning capacity after source cancellation was requested."]] as const) {
      describe(`web_upstream_${field}`, "gauge", help);
      for (const lane of ["data", "auth", "bulk"] as const) {
        const count = snapshot[lane][field];
        lines.push(`web_upstream_${field}{lane="${lane}"} ${Number.isSafeInteger(count) && count >= 0 ? count : 0}`);
      }
    }
    for (const [metric, field] of [["active", "oldestActiveMs"], ["detached", "oldestDetachedMs"], ["cancelling", "oldestCancellingMs"]] as const) {
      describe(`web_upstream_oldest_${metric}_seconds`, "gauge", "Oldest physical ownership age in this lifecycle phase.");
      for (const lane of ["data", "auth", "bulk"] as const) {
        const age = snapshot[lane][field];
        lines.push(`web_upstream_oldest_${metric}_seconds{lane="${lane}"} ${Number.isFinite(age) && age >= 0 ? age / 1000 : 0}`);
      }
    }
    describe("web_upstream_cancel_acknowledgements_total", "counter", "Source cancellation results counted once per physical operation.");
    describe("web_upstream_cancel_ack_seconds_total", "counter", "Total physical ownership time after requesting source cancellation.");
    for (const lane of ["data", "auth", "bulk"] as const) {
      const acknowledgements = snapshot[lane].cancellation;
      for (const result of ["acknowledged", "rejected"] as const) {
        lines.push(`web_upstream_cancel_acknowledgements_total{lane="${lane}",result="${result}"} ${acknowledgements[result]}`);
      }
      lines.push(`web_upstream_cancel_ack_seconds_total{lane="${lane}"} ${acknowledgements.totalMs / 1000}`);
    }
    if (circuits) {
      describe("web_upstream_circuit_state", "gauge", "One-hot fixed-lane circuit state; scrapes never trigger probes.");
      for (const lane of ["data", "auth", "bulk"] as const) {
        for (const state of ["closed", "open", "half-open"] as const) {
          lines.push(`web_upstream_circuit_state{lane="${lane}",state="${state}"} ${circuits[lane].state === state ? 1 : 0}`);
        }
      }
      describe("web_upstream_circuit_failures", "gauge", "Consecutive failures in the current circuit generation.");
      for (const lane of ["data", "auth", "bulk"] as const) lines.push(`web_upstream_circuit_failures{lane="${lane}"} ${circuits[lane].failures}`);
      describe("web_upstream_circuit_retry_after_seconds", "gauge", "Remaining cooldown; zero is not permission to bypass an occupied probe.");
      for (const lane of ["data", "auth", "bulk"] as const) lines.push(`web_upstream_circuit_retry_after_seconds{lane="${lane}"} ${circuits[lane].retryAfterMs / 1000}`);
    }
    describe("web_upstream_invalid_samples_total", "counter", "Discarded malformed observer samples.");
    lines.push(`web_upstream_invalid_samples_total ${this.invalidSamples}`);
    return lines.join("\n") + "\n";
  }
}
