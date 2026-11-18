import type { ServerResponse } from "node:http";

export type JsonCollectionSample = {
  view: "full" | "card"; outcome: "finished" | "cancelled" | "failed";
  items: number; bytes: number; chunks: number; largestChunkBytes: number;
  backpressureCount: number; backpressureMs: number; durationMs: number;
};
type Observer = (sample: JsonCollectionSample) => void;
const observers = new WeakMap<ServerResponse, Observer>();

/** Per-response instrumentation only; no mutable process-global observer. */
export function observeCollectionResponse(response: ServerResponse, observer: Observer): void {
  observers.set(response, observer);
}
export function takeCollectionResponseObserver(response: ServerResponse): Observer | undefined {
  const observer = observers.get(response);
  observers.delete(response);
  return observer;
}

const VIEWS = ["full", "card"] as const;
const OUTCOMES = ["finished", "cancelled", "failed"] as const;
const SECONDS = [0.001, 0.01, 0.1, 1, 5, 10, 30, 120] as const;
type Histogram = { count: number; sum: number; buckets: number[] };
type Counters = { responses: Record<JsonCollectionSample["outcome"], number>; items: number; bytes: number; chunks: number; pressure: number; wait: number; duration: Histogram; largest: number };
const increment = (left: number, by = 1) => Math.min(Number.MAX_SAFE_INTEGER, left + by);
const nonnegativeInteger = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** Fixed cardinality; not route, URL, actor, credentials or exception labels. */
export class HttpCollectionObservability {
  private readonly series = new Map<JsonCollectionSample["view"], Counters>(VIEWS.map(view => [view, {
    responses: { finished: 0, cancelled: 0, failed: 0 }, items: 0, bytes: 0, chunks: 0, pressure: 0, wait: 0, largest: 0,
    duration: { count: 0, sum: 0, buckets: SECONDS.map(() => 0) },
  }]));
  private invalid = 0;

  observe = (sample: JsonCollectionSample): void => {
    const row = this.series.get(sample.view);
    if (!row || !(OUTCOMES as readonly string[]).includes(sample.outcome) ||
        ![sample.items, sample.bytes, sample.chunks, sample.largestChunkBytes, sample.backpressureCount].every(nonnegativeInteger) ||
        ![sample.durationMs, sample.backpressureMs].every(value => Number.isFinite(value) && value >= 0) ||
        sample.largestChunkBytes > 64 * 1024 || sample.backpressureCount > sample.chunks || sample.backpressureMs > sample.durationMs) {
      this.invalid = increment(this.invalid);
      return;
    }
    row.responses[sample.outcome] = increment(row.responses[sample.outcome]);
    row.items = increment(row.items, sample.items);
    row.bytes = increment(row.bytes, sample.bytes);
    row.chunks = increment(row.chunks, sample.chunks);
    row.pressure = increment(row.pressure, sample.backpressureCount);
    row.wait = increment(row.wait, sample.backpressureMs / 1000);
    row.largest = Math.max(row.largest, sample.largestChunkBytes);
    const duration = sample.durationMs / 1000;
    row.duration.count = increment(row.duration.count);
    row.duration.sum = increment(row.duration.sum, duration);
    for (let index = 0; index < SECONDS.length; index++) if (duration <= SECONDS[index]!) row.duration.buckets[index] = increment(row.duration.buckets[index]!);
  };

  render(): string {
    const lines: string[] = [];
    const describe = (metric: string, type: "counter" | "gauge" | "histogram", help: string) => lines.push(`# HELP ${metric} ${help}`, `# TYPE ${metric} ${type}`);
    describe("api_http_collection_responses_total", "counter", "Collection writers ending in socket finish, downstream close or encoding/socket failure.");
    for (const [view, row] of this.series) for (const outcome of OUTCOMES) lines.push(`api_http_collection_responses_total{view="${view}",outcome="${outcome}"} ${row.responses[outcome]}`);
    for (const [name, field, help] of [
      ["items", "items", "Items fully written before the writer ended; not proof the peer consumed them."],
      ["json_bytes", "bytes", "JSON bytes accepted by the native writer before finish or failure, excluding HTTP headers."],
      ["chunks", "chunks", "Bounded JSON chunks accepted by the native writer."],
      ["backpressure", "pressure", "Writes that crossed the native socket high-water mark."],
      ["drain_wait_seconds", "wait", "Seconds spent waiting for drain or downstream close, not database acquisition."],
    ] as const) {
      describe(`api_http_collection_${name}_total`, "counter", help);
      for (const [view, row] of this.series) lines.push(`api_http_collection_${name}_total{view="${view}"} ${row[field]}`);
    }
    describe("api_http_collection_largest_chunk_bytes", "gauge", "Largest JSON chunk ever emitted by this process; not whole-page resident memory.");
    for (const [view, row] of this.series) lines.push(`api_http_collection_largest_chunk_bytes{view="${view}"} ${row.largest}`);
    const metric = "api_http_collection_write_duration_seconds";
    describe(metric, "histogram", "Time from writer start to finish/close/failure, including socket backpressure.");
    for (const [view, row] of this.series) {
      for (let index = 0; index < SECONDS.length; index++) lines.push(`${metric}_bucket{view="${view}",le="${SECONDS[index]}"} ${row.duration.buckets[index]}`);
      lines.push(`${metric}_bucket{view="${view}",le="+Inf"} ${row.duration.count}`, `${metric}_sum{view="${view}"} ${row.duration.sum}`, `${metric}_count{view="${view}"} ${row.duration.count}`);
    }
    describe("api_http_collection_invalid_samples_total", "counter", "Malformed collection observations discarded without affecting responses.");
    lines.push(`api_http_collection_invalid_samples_total ${this.invalid}`);
    return lines.join("\n") + "\n";
  }
}
