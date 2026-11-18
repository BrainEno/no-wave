import type { UpstreamOutcome } from "./upstream-telemetry.ts";

export type CollectionSample = { mode: "parsed" | "forwarded"; items: number; largestItemBytes: number; envelopeBytes: number; peakCapturedBytes: number; complete: boolean };
const MODES = ["parsed", "forwarded"] as const;
const BYTE_BUCKETS = [0, 1024, 65536, 262144, 1048576, 2097152, 4194304, 8388608] as const;
type ByteHistogram = { count: number; sum: number; buckets: number[] };
type Series = { requests: Map<UpstreamOutcome, number>; items: number; envelope: number; eof: number; largest: ByteHistogram; capture: ByteHistogram };
function histogram(): ByteHistogram { return { count: 0, sum: 0, buckets: BYTE_BUCKETS.map(() => 0) }; }
const add = (left: number, right = 1) => Math.min(Number.MAX_SAFE_INTEGER, left + right);
function observe(values: ByteHistogram, bytes: number): void {
  values.count = add(values.count);
  values.sum = add(values.sum, bytes);
  for (let index = 0; index < BYTE_BUCKETS.length; index++) if (bytes <= BYTE_BUCKETS[index]!) values.buckets[index] = add(values.buckets[index]!);
}

/** Collection-only bounded labels; never retain samples, URLs or projected data. */
export class UpstreamCollectionTelemetry {
  private readonly series = new Map<CollectionSample["mode"], Series>(MODES.map(mode => [mode, {
    requests: new Map(), items: 0, envelope: 0, eof: 0, largest: histogram(), capture: histogram(),
  }]));

  observe(sample: CollectionSample, outcome: UpstreamOutcome): boolean {
    const row = this.series.get(sample.mode);
    if (!row || typeof sample.complete !== "boolean" ||
        ![sample.items, sample.largestItemBytes, sample.envelopeBytes, sample.peakCapturedBytes].every(value => Number.isSafeInteger(value) && value >= 0) || sample.items > 300) return false;
    row.requests.set(outcome, add(row.requests.get(outcome) ?? 0));
    row.items = add(row.items, sample.items);
    row.envelope = add(row.envelope, sample.envelopeBytes);
    if (sample.complete) row.eof = add(row.eof);
    observe(row.largest, sample.largestItemBytes);
    observe(row.capture, sample.peakCapturedBytes);
    return true;
  }

  render(outcomes: readonly UpstreamOutcome[]): string {
    const lines: string[] = [];
    const describe = (name: string, type: "counter" | "histogram", help: string) => lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    describe("web_upstream_collection_requests_total", "counter", "Collection operations by consumption mode and public outcome; physical leases are reported separately.");
    for (const [mode, row] of this.series) for (const outcome of outcomes) lines.push(`web_upstream_collection_requests_total{mode="${mode}",outcome="${outcome}"} ${row.requests.get(outcome) ?? 0}`);
    for (const [name, field, help] of [
      ["items", "items", "Complete item frames observed, including items preceding an invalid or cancelled EOF."],
      ["envelope_bytes", "envelope", "Non-item bytes observed while framing collection envelopes."],
      ["validated_eof", "eof", "Collection operations whose UTF-8, JSON and envelope reached a validated EOF."],
    ] as const) {
      describe(`web_upstream_collection_${name}_total`, "counter", help);
      for (const [mode, row] of this.series) lines.push(`web_upstream_collection_${name}_total{mode="${mode}"} ${row[field]}`);
    }
    for (const [name, field, help] of [
      ["largest_item", "largest", "Largest individual item frame per collection operation, excluding rejected excess."],
      ["peak_capture", "capture", "Peak owned byte-slab capacity per decoder, excluding adapter chunks and caller-owned projected results."],
    ] as const) {
      const metric = `web_upstream_collection_${name}_bytes`;
      describe(metric, "histogram", help);
      for (const [mode, row] of this.series) {
        const values = row[field];
        for (let index = 0; index < BYTE_BUCKETS.length; index++) lines.push(`${metric}_bucket{mode="${mode}",le="${BYTE_BUCKETS[index]}"} ${values.buckets[index]}`);
        lines.push(`${metric}_bucket{mode="${mode}",le="+Inf"} ${values.count}`,
          `${metric}_sum{mode="${mode}"} ${values.sum}`, `${metric}_count{mode="${mode}"} ${values.count}`);
      }
    }
    return lines.join("\n") + "\n";
  }
}
