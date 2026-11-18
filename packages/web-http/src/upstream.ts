import { resolveUpstreamTimeoutMs, withUpstreamDeadline, type ApiProxyConfig, type FetchImpl } from "./api.ts";
import { UpstreamAdmission, type AdmissionLimits, type AdmissionSnapshot, type UpstreamLane, type UpstreamLease } from "./upstream-admission.ts";
import { UpstreamBusyError, UpstreamCancelledError, UpstreamResponseError } from "./upstream-errors.ts";
import { API_RESPONSE_MAX_BYTES, AUTH_RESPONSE_MAX_BYTES, EXPORT_RESPONSE_MAX_BYTES, bufferUpstreamResponse,
  cancelUpstreamBody, requireTimelyResponse, isUpstreamJsonType, upstreamJsonPayload, type BufferedApiResponse } from "./upstream-response.ts";
import { UpstreamRelease } from "./upstream-release.ts";
import { UpstreamBodyStream } from "./upstream-stream.ts";
import { CollectionJsonDecoder, type CollectionLimits } from "./collection-json.ts";
import { CollectionStreamGate } from "./collection-stream-gate.ts";
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
export type UpstreamCollectionOptions = CollectionLimits & { kind?: "content" | "api"; timeoutMs?: number | string | null; signal?: AbortSignal; preflight?: boolean };
export type ParsedCollectionResponse = { status: number; headers: Headers; payload: Record<string, unknown> | null };

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

  /** Consume incrementally under the data lease; only projected items survive. */
  async readCollection<T = unknown>(url: string, init: RequestInit = {}, options: UpstreamCollectionOptions = {}, project?: (item: unknown, index: number) => T): Promise<ParsedCollectionResponse> {
    let mappingFailure: { error: unknown } | undefined;
    const map = (item: unknown, index: number) => {
      try { return project ? project(item, index) : item as T; }
      catch (error) { mappingFailure = { error }; throw new UpstreamResponseError("invalid-json"); }
    };
    try {
      const { response, payload } = await this.collectionStream(url, init, { kind: "content", ...options }, true, map);
      if (!response.ok) {
        await response.body?.cancel();
        return { status: response.status, headers: response.headers, payload: null };
      }
      const reader = response.body?.getReader();
      if (reader) {
        try { while (!(await reader.read()).done) { /* The decoder owns each bounded item, not this drain. */ } }
        finally { reader.releaseLock(); }
      }
      return { status: response.status, headers: response.headers, payload: payload() };
    } catch (error) {
      if (mappingFailure) throw mappingFailure.error;
      throw error;
    }
  }

  /** A collection is not a bulk export: it competes in the ordinary data lane. */
  async openCollection(url: string, init: RequestInit = {}, options: UpstreamCollectionOptions = {}): Promise<Response> {
    return (await this.collectionStream(url, init, options, false)).response;
  }

  private async collectionStream<T>(url: string, init: RequestInit, options: UpstreamCollectionOptions, retainItems: boolean, project?: (item: unknown, index: number) => T): Promise<{ response: Response; payload: () => Record<string, unknown> | null }> {
    const kind = options.kind ?? "api";
    if (kind !== "api" && kind !== "content") throw new RangeError("Invalid upstream collection category.");
    const timeoutMs = resolveUpstreamTimeoutMs(options.timeoutMs);
    let checkpoint = () => {};
    const decoder = new CollectionJsonDecoder({ ...options, retainItems, requireDataArray: !retainItems, project, checkpoint: () => checkpoint() });
    let expose!: (value: { response: Response; payload: () => Record<string, unknown> | null }) => void;
    let refuse!: (error: unknown) => void;
    const headersReady = new Promise<{ response: Response; payload: () => Record<string, unknown> | null }>((resolve, reject) => { expose = resolve; refuse = reject; });
    const callerSignal = AbortSignal.any([this.shutdown.signal, options.signal, init.signal].filter((value): value is AbortSignal => value !== undefined && value !== null));
    const startedAt = performance.now();
    const progress = { bytes: 0 };
    let download: UpstreamBodyStream | undefined;
    let physicalLease: UpstreamLease | undefined;
    let permit: CircuitPermit | undefined;
    let outcome: UpstreamOutcome = "network";
    let status: number | undefined;
    const lifecycle = withUpstreamDeadline(timeoutMs, async (signal, check) => {
      checkpoint = check;
      if (this.stopping) throw new UpstreamBusyError("closing");
      const lease = await this.admission.acquire("data", signal);
      physicalLease = lease;
      const release = new UpstreamRelease(rejected => { permit?.release(); lease.release(rejected); }, lease.cancelling);
      try {
        checkpoint();
        permit = this.circuit.enter("data");
        const source = await this.fetchImpl(url, { ...init, redirect: "error", cache: "no-store", signal });
        requireTimelyResponse(source, checkpoint, release.track);
        status = source.status;
        const headers = new Headers({ "cache-control": "no-store, max-age=0" });
        for (const name of ["content-type", "retry-after"]) {
          const value = source.headers.get(name);
          if (value !== null) headers.set(name, value);
        }
        if (source.ok && ![204, 205].includes(status)) {
          if (!isUpstreamJsonType(source.headers.get("content-type"))) {
            cancelUpstreamBody(source, release.track);
            throw new UpstreamResponseError("invalid-content-type");
          }
          download = new UpstreamBodyStream(source, decoder.maxBytes, signal, decoder, release.track, checkpoint);
          // Preflight may observe a body failure before the final await below;
          // attach a rejection observer immediately, without swallowing that await.
          void download.finished.catch(() => {});
          const body = !retainItems && options.preflight
            ? await new CollectionStreamGate(download.body, () => decoder.hasDataArray(), signal, checkpoint).prepare()
            : download.body;
          checkpoint();
          expose({ response: new Response(body, { status, headers }), payload: () => decoder.payload() });
          await download.finished;
        } else {
          // A 401 triggers rotation from its status alone. Never wait on a
          // corrupt, huge or stalled optional diagnostic before coordinating it.
          let bytes = new Uint8Array(0);
          if (status === 401 || status >= 500 || kind === "content" || [204, 205, 304].includes(status)) {
            cancelUpstreamBody(source, release.track);
          } else {
            const buffered = await bufferUpstreamResponse(source, API_RESPONSE_MAX_BYTES, signal, release.track, progress, checkpoint);
            upstreamJsonPayload(buffered);
            bytes = buffered.bytes;
          }
          checkpoint();
          expose({ response: new Response(bytes.byteLength ? bytes : null, { status, headers }), payload: () => null });
        }
        checkpoint();
        outcome = status >= 400 ? "http_error" : "ok";
        permit.report(status >= 500 ? "failure" : "healthy");
      } catch (error) {
        permit?.report(signal.aborted ? signal.reason instanceof UpstreamTimeoutError ? "failure" : "neutral" : error instanceof UpstreamCancelledError || error instanceof UpstreamBusyError ? "neutral" : "failure");
        throw error;
      } finally { release.finish(); }
    }, callerSignal);
    void lifecycle.catch(error => {
      const failure = this.stopping && !physicalLease && !options.signal?.aborted && !init.signal?.aborted ? new UpstreamBusyError("closing") : error;
      permit?.report(failure instanceof UpstreamTimeoutError || failure instanceof UpstreamResponseError ? "failure" : "neutral");
      outcome = upstreamOutcome(failure);
      refuse(failure);
    }).finally(() => {
      physicalLease?.detach();
      observeUpstream(this.observer, { kind, outcome, durationMs: Math.max(0, performance.now() - startedAt),
        bytes: download?.bytes() ?? progress.bytes, ...(status === undefined ? {} : { status }),
        collection: { mode: retainItems ? "parsed" : "forwarded", ...decoder.snapshot() } });
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
