import assert from "node:assert/strict";
import test from "node:test";
import { UpstreamTransport } from "../src/upstream.ts";
import { UpstreamTelemetry } from "../src/upstream-telemetry.ts";

 test("real collection parsing/forwarding publishes bounded resource diagnostics without path, body or account labels", async () => {
  const telemetry = new UpstreamTelemetry();
  const text = JSON.stringify({ data: [{ title: "private-title-canary", content: "浪".repeat(100_000) }, { content: "small" }], meta: { offset: 2 } });
  const transport = new UpstreamTransport({ observer: sample => telemetry.observe(sample), fetchImpl: async () => new Response(text, { headers: { "content-type": "application/json" } }) });
  const parsed = await transport.readCollection("https://private-api.test/articles?actor=private-user", {}, {}, () => "projected");
  assert.deepEqual(parsed.payload?.data, ["projected", "projected"]);
  const streamed = await transport.openCollection("https://private-api.test/another");
  assert.equal(await streamed.text(), text);
  await new Promise<void>(resolve => setImmediate(resolve));
  const metrics = telemetry.render(transport.snapshot(), transport.circuitSnapshot());
  assert.match(metrics, /web_upstream_collection_requests_total\{mode="parsed",outcome="ok"\} 1/);
  assert.match(metrics, /web_upstream_collection_items_total\{mode="parsed"\} 2/);
  assert.match(metrics, /web_upstream_collection_validated_eof_total\{mode="forwarded"\} 1/);
  assert.match(metrics, /web_upstream_collection_peak_capture_bytes_bucket\{mode="forwarded",le="65536"\} 1/);
  assert.doesNotMatch(metrics, /private-api|private-user|private-title|actor=|浪/);
  assert.equal(await transport.close(), true);
});
