import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  MonitorFault,
  type MonitorConfig,
  type MonitorObservation,
  type MonitorSourceResult,
  type MonitorTarget,
} from "../application/operational-monitor.ts";
import { MONITOR_SCRAPE_MAX_BYTES, parseMonitorExposition } from "./monitor-exposition.ts";

function metricsContentType(value: string | undefined): boolean {
  if (!value || value.length > 256) return false;
  const [media, ...parameters] = value
    .toLowerCase()
    .split(";")
    .map((part) => part.trim());
  if (media !== "text/plain") return false;
  const seen = new Set<string>();
  for (const parameter of parameters) {
    const match = /^(version|charset)=(?:"([a-z0-9.\-]+)"|([a-z0-9.\-]+))$/.exec(parameter);
    if (!match || seen.has(match[1]!)) return false;
    seen.add(match[1]!);
    const parameterValue = match[2] ?? match[3];
    if (match[1] === "version" ? parameterValue !== "0.0.4" : parameterValue !== "utf-8") return false;
  }
  return true;
}

/** Own a native, unpooled GET until ClientRequest emits close. A reporting
 * timeout destroys the transport; it does not free capacity while a fetch/body
 * promise continues in the background. No retries, redirects or user headers. */
function scrapeTarget(
  target: MonitorTarget,
  config: MonitorConfig,
  signal: AbortSignal,
  abortReason: () => MonitorSourceResult,
): Promise<MonitorObservation> {
  return new Promise((resolve) => {
    const deadline = performance.now() + config.scrapeTimeoutMs;
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let result: MonitorObservation | null = null;
    let received = 0;
    let declared: number | null = null;
    const chunks: Buffer[] = [];
    const failure = (reason: MonitorSourceResult) => {
      if (!result) result = { targetId: target.id, observedAt: Date.now(), reason, snapshot: null };
      chunks.length = 0;
      response?.destroy();
      request?.destroy();
    };
    const cancelled = () => failure(abortReason());
    const timer = setTimeout(() => failure("timeout"), config.scrapeTimeoutMs);
    const release = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancelled);
      resolve(result ?? { targetId: target.id, observedAt: Date.now(), reason: "transport", snapshot: null });
    };
    const expired = () => {
      if (signal.aborted) {
        cancelled();
        return true;
      }
      if (performance.now() > deadline) {
        failure("timeout");
        return true;
      }
      return false;
    };
    const onResponse = (incoming: IncomingMessage) => {
      response = incoming;
      response.once("error", () => failure("transport"));
      response.once("aborted", () => failure("transport"));
      if (expired()) return;
      if (response.statusCode !== 200) {
        failure("http_status");
        return;
      }
      const encoding = response.headers["content-encoding"];
      if (
        !metricsContentType(response.headers["content-type"]) ||
        (encoding !== undefined && encoding.toLowerCase() !== "identity")
      ) {
        failure("invalid_content_type");
        return;
      }
      const cache = response.headers["cache-control"] ?? "";
      const age = response.headers.age;
      if (
        !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(cache) ||
        (age !== undefined && (!/^\d+$/.test(age) || Number(age) !== 0))
      ) {
        failure("stale_response");
        return;
      }
      const length = response.headers["content-length"];
      if (length !== undefined) {
        if (!/^(?:0|[1-9]\d*)$/.test(length)) {
          failure("transport");
          return;
        }
        declared = Number(length);
        if (!Number.isSafeInteger(declared) || declared > MONITOR_SCRAPE_MAX_BYTES) {
          failure("response_too_large");
          return;
        }
      }
      response.on("data", (chunk: Buffer) => {
        if (result || expired()) return;
        if (chunk.byteLength > MONITOR_SCRAPE_MAX_BYTES - received) {
          failure("response_too_large");
          return;
        }
        received += chunk.byteLength;
        chunks.push(chunk);
      });
      response.once("end", () => {
        if (result || expired()) return;
        if (declared !== null && declared !== received) {
          failure("transport");
          return;
        }
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, received));
          const observedAt = Date.now();
          const snapshot = parseMonitorExposition(text, target.role, observedAt, config.policy.maxGapMs);
          if (expired()) return;
          result = { targetId: target.id, observedAt, reason: "ok", snapshot };
          chunks.length = 0;
          clearTimeout(timer);
          request?.destroy();
        } catch {
          failure("invalid_metrics");
        }
      });
    };
    try {
      const url = new URL(target.metricsUrl);
      const options = {
        method: "GET",
        agent: false as const,
        headers: {
          accept: "text/plain; version=0.0.4",
          "accept-encoding": "identity",
          "cache-control": "no-cache",
          connection: "close",
        },
      };
      request =
        url.protocol === "https:"
          ? httpsRequest(url, { ...options, rejectUnauthorized: true }, onResponse)
          : httpRequest(url, options, onResponse);
      request.once("error", () => failure(signal.aborted ? abortReason() : "transport"));
      request.once("close", release);
      signal.addEventListener("abort", cancelled, { once: true });
      if (signal.aborted) cancelled();
      else request.end();
    } catch {
      failure("transport");
      if (!request) release();
    }
  });
}

export async function collectMonitorTargets(
  config: MonitorConfig,
  parent?: AbortSignal,
): Promise<MonitorObservation[]> {
  if (parent?.aborted) throw new MonitorFault("cancelled");
  const deadline = new AbortController();
  const signal = parent ? AbortSignal.any([parent, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(), config.runTimeoutMs);
  const results = new Array<MonitorObservation>(config.targets.length);
  let next = 0;
  const abortReason = (): MonitorSourceResult => (parent?.aborted ? "cancelled" : "run_timeout");
  const worker = async () => {
    while (next < config.targets.length) {
      const index = next++;
      const target = config.targets[index]!;
      results[index] = signal.aborted
        ? { targetId: target.id, observedAt: Date.now(), reason: abortReason(), snapshot: null }
        : await scrapeTarget(target, config, signal, abortReason);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(4, config.targets.length) }, worker));
    if (parent?.aborted) throw new MonitorFault("cancelled");
    return results;
  } finally {
    clearTimeout(timer);
  }
}
