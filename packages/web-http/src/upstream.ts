import { resolveUpstreamTimeoutMs, withUpstreamDeadline, type ApiProxyConfig, type FetchImpl } from "./api.ts";
import { UpstreamAdmission, type AdmissionLimits, type AdmissionSnapshot, type UpstreamLane, type UpstreamLease } from "./upstream-admission.ts";
import { UpstreamBusyError, UpstreamCancelledError, UpstreamResponseError } from "./upstream-errors.ts";
import { API_RESPONSE_MAX_BYTES, AUTH_RESPONSE_MAX_BYTES, EXPORT_RESPONSE_MAX_BYTES, bufferUpstreamResponse,
  cancelUpstreamBody, requireTimelyResponse, isUpstreamJsonType, upstreamJsonPayload, type BufferedApiResponse } from "./upstream-response.ts";
import { UpstreamRelease } from "./upstream-release.ts";
import { UpstreamBodyStream } from "./upstream-stream.ts";
import { UpstreamCircuit, type CircuitOptions, type CircuitPermit } from "./upstream-circuit.ts";
import { UpstreamTimeoutError } from "./api.ts";
import { UPSTREAM_KINDS, observeUpstream, upstreamOutcome, type UpstreamKind, type UpstreamObserver, type UpstreamOutcome } from "./upstream-telemetry.ts";

export type UpstreamRequestOptions = {
  kind?: UpstreamKind;
  timeoutMs?: number | string | null;
  maxBytes?: number;
  signal?: AbortSignal;
  responseType?: "json" | "json-success" | "bytes";
};
export type UpstreamTransportOptions = { fetchImpl?: FetchImpl; admission?: AdmissionLimits; observer?: UpstreamObserver; circuit?: CircuitOptions };

function laneFor(kind: UpstreamKind): UpstreamLane {
  return kind === "auth" ? "auth" : kind === "export" ? "bulk" : "data";
}
function limitFor(kind: UpstreamKind): number {
  return kind === "auth" ? AUTH_RESPONSE_MAX_BYTES : API_RESPONSE_MAX_BYTES;
}

/**
 * One process-local transport, no response/session cache and no retry policy.
 * A lease belongs to the physical operation, not its deadline race: a broken
 * fetch that ignores abort cannot release a slot and launch an unbounded storm.
 */
export class UpstreamTransport {
  private readonly fetchImpl: FetchImpl;
  private readonly admission: UpstreamAdmission;
  private readonly observer?: UpstreamObserver;
  private readonly circuit: UpstreamCircuit;
  private readonly shutdown = new AbortController();
  private stopping = false;
  private closing: Promise<boolean> | undefined;

  constructor(options: UpstreamTransportOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.admission = new UpstreamAdmission(options.admission);
    this.observer = options.observer;
    this.circuit = new UpstreamCircuit(options.circuit);
  }

  async request(url: string, init: RequestInit = {}, options: UpstreamRequestOptions = {}): Promise<BufferedApiResponse> {
    const kind = options.kind ?? "api";
    if (!(UPSTREAM_KINDS as readonly string[]).includes(kind)) throw new RangeError("Invalid upstream request category.");
    if (kind === "export") throw new RangeError("Bulk downloads must use openStream instead of buffering.");
    const timeoutMs = resolveUpstreamTimeoutMs(options.timeoutMs);
    const maxBytes = options.maxBytes ?? limitFor(kind);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > limitFor(kind)) throw new RangeError("Invalid upstream response byte limit.");
    const signals = [this.shutdown.signal, options.signal, init.signal].filter((value): value is AbortSignal => value !== null && value !== undefined);
    const callerSignal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
    const startedAt = performance.now();
    let outcome: UpstreamOutcome = "network";
    const progress = { bytes: 0 };
    let status: number | undefined;
    let admitted = false;
    let physicalLease: UpstreamLease | undefined;
    let permit: CircuitPermit | undefined;
    try {
      if (this.stopping) throw new UpstreamBusyError("closing");
      return await withUpstreamDeadline(timeoutMs, async (signal, checkpoint) => {
        const lease = await this.admission.acquire(laneFor(kind), signal);
        admitted = true;
        physicalLease = lease;
        const release = new UpstreamRelease(rejected => { permit?.release(); lease.release(rejected); }, lease.cancelling);
        try {
          checkpoint();
          permit = this.circuit.enter(laneFor(kind));
          const response = await this.fetchImpl(url, { ...init, redirect: "error", cache: "no-store", signal });
          requireTimelyResponse(response, checkpoint, release.track);
          status = response.status;
          const skipMediaBody = (kind === "media" && response.status === 304) || (["media", "content", "crawl"].includes(kind) && !response.ok);
          if (skipMediaBody) cancelUpstreamBody(response, release.track);
          // A 401 is authoritative for rotation even without a usable error body.
          const validateJson = options.responseType === "json" && response.status !== 401 || options.responseType === "json-success" && response.ok;
          if (!skipMediaBody && validateJson && response.status < 500 && ![204, 205, 304].includes(response.status) &&
              !isUpstreamJsonType(response.headers.get("content-type"))) {
            cancelUpstreamBody(response, release.track);
            throw new UpstreamResponseError("invalid-content-type");
          }
          const buffered = skipMediaBody
            ? { status: response.status, statusText: response.statusText, headers: new Headers(response.headers), bytes: new Uint8Array(0) }
            : await bufferUpstreamResponse(response, maxBytes, signal, release.track, progress, checkpoint);
          // Server errors are mapped without reading/interpreting their text.
          // 204/205/304 have no body by HTTP definition, not malformed JSON.
          if (validateJson && !skipMediaBody && buffered.status < 500 && ![204, 205, 304].includes(buffered.status)) upstreamJsonPayload(buffered);
          checkpoint();
          outcome = status >= 400 ? "http_error" : "ok";
          permit.report(status >= 500 ? "failure" : "healthy");
          return buffered;
        } catch (error) {
          permit?.report(signal.aborted ? signal.reason instanceof UpstreamTimeoutError ? "failure" : "neutral" : error instanceof UpstreamBusyError ? "neutral" : "failure");
          throw error;
        } finally {
          release.finish();
        }
      }, callerSignal);
    } catch (error) {
      const failure = this.stopping && !admitted && !options.signal?.aborted && !init.signal?.aborted
        ? new UpstreamBusyError("closing") : error;
      permit?.report(failure instanceof UpstreamTimeoutError || failure instanceof UpstreamResponseError ? "failure" : "neutral");
      outcome = upstreamOutcome(failure);
      throw failure;
    } finally {
      physicalLease?.detach();
      observeUpstream(this.observer, { kind, outcome, durationMs: Math.max(0, performance.now() - startedAt), bytes: progress.bytes, ...(status === undefined ? {} : { status }) });
    }
  }

  /**
   * A bulk attachment is streamed with backpressure, not buffered as a giant
   * string. The owned operation/timer outlives these headers and is observed
   * until EOF, browser cancellation, a byte violation or the absolute deadline.
   */
  async openStream(url: string, init: RequestInit = {}, options: UpstreamRequestOptions = {}): Promise<Response> {
    const kind = options.kind ?? "export";
    if (kind !== "export") return Promise.reject(new RangeError("Streaming requires the isolated bulk lane."));
    const timeoutMs = resolveUpstreamTimeoutMs(options.timeoutMs);
    const maxBytes = options.maxBytes ?? EXPORT_RESPONSE_MAX_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > EXPORT_RESPONSE_MAX_BYTES) return Promise.reject(new RangeError("Invalid upstream response byte limit."));
    let expose!: (response: Response) => void;
    let refuse!: (error: unknown) => void;
    const headersReady = new Promise<Response>((resolve, reject) => { expose = resolve; refuse = reject; });
    const signals = [this.shutdown.signal, options.signal, init.signal].filter((value): value is AbortSignal => value !== null && value !== undefined);
    const callerSignal = AbortSignal.any(signals);
    const streamingStartedAt = performance.now();
    let download: UpstreamBodyStream | undefined;
    let streamOutcome: UpstreamOutcome = "network";
    let responseStatus: number | undefined;
    let bulkAdmitted = false;
    let bulkPhysicalLease: UpstreamLease | undefined;
    let bulkPermit: CircuitPermit | undefined;
    const lifecycle = withUpstreamDeadline(timeoutMs, async (signal, checkpoint) => {
      if (this.stopping) throw new UpstreamBusyError("closing");
      const bulkLease = await this.admission.acquire("bulk", signal);
      bulkAdmitted = true;
      bulkPhysicalLease = bulkLease;
      const bulkRelease = new UpstreamRelease(rejected => { bulkPermit?.release(); bulkLease.release(rejected); }, bulkLease.cancelling);
      try {
        checkpoint();
        bulkPermit = this.circuit.enter("bulk");
        const upstream = await this.fetchImpl(url, { ...init, redirect: "error", cache: "no-store", signal });
        requireTimelyResponse(upstream, checkpoint, bulkRelease.track);
        if (upstream.ok && !isUpstreamJsonType(upstream.headers.get("content-type"))) {
          cancelUpstreamBody(upstream, bulkRelease.track);
          throw new UpstreamResponseError("invalid-content-type");
        }
        responseStatus = upstream.status;
        // Errors are not bulk files; even an untrusted 401 cannot force a
        // hundreds-of-megabytes read before one coordinated refresh attempt.
        download = new UpstreamBodyStream(upstream, upstream.ok ? maxBytes : Math.min(maxBytes, AUTH_RESPONSE_MAX_BYTES), signal, upstream.ok && ![204, 205].includes(upstream.status), bulkRelease.track, checkpoint);
        const headers = new Headers({ "cache-control": "no-store, max-age=0" });
        for (const name of ["content-type", "retry-after"]) {
          const value = upstream.headers.get(name);
          if (value !== null) headers.set(name, value);
        }
        const bodyless = [204, 205, 304].includes(upstream.status);
        expose(new Response(bodyless ? null : download.body, { status: upstream.status, headers }));
        await download.finished;
        streamOutcome = upstream.status >= 400 ? "http_error" : "ok";
        bulkPermit.report(upstream.status >= 500 ? "failure" : "healthy");
      } catch (error) {
        bulkPermit?.report(signal.aborted ? signal.reason instanceof UpstreamTimeoutError ? "failure" : "neutral" : error instanceof UpstreamCancelledError ? "neutral" : "failure");
        throw error;
      } finally {
        bulkRelease.finish();
      }
    }, callerSignal);
    void lifecycle.catch(error => {
      const failure = this.stopping && !bulkAdmitted && !options.signal?.aborted && !init.signal?.aborted ? new UpstreamBusyError("closing") : error;
      bulkPermit?.report(failure instanceof UpstreamTimeoutError ? "failure" : "neutral");
      streamOutcome = upstreamOutcome(failure);
      refuse(failure);
    }).finally(() => {
      bulkPhysicalLease?.detach();
      observeUpstream(this.observer, { kind, outcome: streamOutcome,
        durationMs: Math.max(0, performance.now() - streamingStartedAt), bytes: download?.bytes() ?? 0,
        ...(responseStatus === undefined ? {} : { status: responseStatus }) });
    });
    return headersReady;
  }

  snapshot(): AdmissionSnapshot {
    return this.admission.snapshot();
  }

  circuitSnapshot() {
    return this.circuit.snapshot();
  }

  /** First close owns one finite drain budget. New and queued work fail closed. */
  close(timeoutMs = 1000): Promise<boolean> {
    if (this.closing) return this.closing;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) return Promise.reject(new RangeError("Invalid upstream drain budget."));
    this.stopping = true;
    this.admission.stop();
    this.shutdown.abort();
    this.closing = this.admission.waitForIdle(timeoutMs);
    return this.closing;
  }
}

const transports = new WeakMap<FetchImpl, UpstreamTransport>();
/** Explicit transport scopes admission across SSR, BFF and media; injected fetches stay isolated. */
export function upstreamTransportFor(config: Pick<ApiProxyConfig, "fetchImpl" | "upstreamTransport"> = {}): UpstreamTransport {
  if (config.upstreamTransport) {
    if (config.fetchImpl) throw new RangeError("Supply an upstream transport or a fetch override, not both.");
    return config.upstreamTransport;
  }
  const fetchImpl = config.fetchImpl ?? fetch;
  let transport = transports.get(fetchImpl);
  if (!transport) {
    transport = new UpstreamTransport({ fetchImpl });
    transports.set(fetchImpl, transport);
  }
  return transport;
}
