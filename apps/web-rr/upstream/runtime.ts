import { UpstreamTelemetry, UpstreamTransport, type FetchImpl } from "@no-wave/web-http";
import { withUpstreamTransport } from "@no-wave/web-http/upstream-runtime";
import { resolveWebUpstreamSettings } from "./settings.ts";

/** Shared across all requests, including SSR reads and the reserved auth lane. */
export function createWebUpstreamRuntime(env: Readonly<Record<string, string | undefined>>, fetchImpl?: FetchImpl) {
  const telemetry = new UpstreamTelemetry();
  const transport = new UpstreamTransport({ admission: resolveWebUpstreamSettings(env), fetchImpl, observer: sample => telemetry.observe(sample) });
  return {
    transport,
    run<Value>(work: () => Value): Value { return withUpstreamTransport(transport, work); },
    metrics(): string { return telemetry.render(transport.snapshot(), transport.circuitSnapshot()); },
    close(timeoutMs?: number): Promise<boolean> { return transport.close(timeoutMs); },
  };
}
