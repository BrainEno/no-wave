import type { DeadlineCheckpoint } from "./api.ts";
import type { CancellationObserver } from "./upstream-release.ts";
import { UpstreamCancelledError, UpstreamResponseError } from "./upstream-errors.ts";

export const API_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
export const AUTH_RESPONSE_MAX_BYTES = 64 * 1024;
/**
 * Streaming-only fence: a Node API JSON string (at most 2^29-24 UTF-16 code
 * units) encodes to <1.5 GiB UTF-8. Leave space above every emit-able API file,
 * including 50 bilingual maximum-size works whose Notion rich text duplicates
 * content. This does not raise a domain/upload/import limit or permit buffering
 * gigabytes; buffered reads are separately capped at API_RESPONSE_MAX_BYTES.
 */
export const EXPORT_RESPONSE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const JSON_TYPE = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/i;

export function isUpstreamJsonType(value: string | null): boolean { return value === null || JSON_TYPE.test(value); }

export type BufferedApiResponse = {
  status: number;
  statusText: string;
  headers: Headers;
  bytes: Uint8Array<ArrayBuffer>;
};

/** Cancellation must never wait for a broken stream's cancel promise. */
export function cancelUpstreamBody(response: Response, track?: CancellationObserver): void {
  cancelUpstreamRead(response.body, track);
}

export function cancelUpstreamRead(source: { cancel(): Promise<void> } | null | undefined, track?: CancellationObserver): void {
  if (!source) return;
  try {
    const receipt = source.cancel();
    track?.(receipt);
    void receipt.catch(() => {});
  } catch { /* Already locked or consumed. */ }
}

/** fetch exposes decoded bytes but retains the encoded framing headers. */
export function declaredDecodedLength(response: Response): number | null {
  const encoding = response.headers.get("content-encoding");
  if (encoding !== null && encoding.trim().toLowerCase() !== "identity") return null;
  const declared = response.headers.get("content-length");
  if (declared === null || !/^\d+$/.test(declared)) return null;
  const length = Number(declared);
  return Number.isSafeInteger(length) ? length : Number.POSITIVE_INFINITY;
}

export type DecodedByteProgress = { bytes: number };

/** Headers received after an elapsed deadline still own a body to cancel. */
export function requireTimelyResponse(response: Response, checkpoint: DeadlineCheckpoint, track: CancellationObserver): void {
  try { checkpoint(); }
  catch (error) {
    cancelUpstreamBody(response, track);
    throw error;
  }
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new UpstreamCancelledError();
}

/**
 * Limit decoded bytes, not Content-Length (fetch decompresses before reading).
 * Copy each chunk: injected transports may reuse/mutate their backing buffer.
 * No Response.clone/tee is used, so there is no unconsumed second branch.
 */
export async function bufferUpstreamResponse(response: Response, maxBytes: number, signal: AbortSignal, track?: CancellationObserver, progress?: DecodedByteProgress, checkpoint: DeadlineCheckpoint = () => {}): Promise<BufferedApiResponse> {
  if (progress) progress.bytes = 0;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > API_RESPONSE_MAX_BYTES) {
    cancelUpstreamBody(response, track);
    throw new RangeError("Invalid upstream response byte limit.");
  }
  if (signal.aborted) {
    cancelUpstreamBody(response, track);
    throw new UpstreamCancelledError();
  }
  const declared = declaredDecodedLength(response);
  if (declared !== null && declared > maxBytes) {
    cancelUpstreamBody(response, track);
    throw new UpstreamResponseError("too-large");
  }
  const result = { status: response.status, statusText: response.statusText, headers: new Headers(response.headers) };
  if (!response.body) return { ...result, bytes: new Uint8Array(0) };
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = response.body.getReader(); } catch { throw new UpstreamResponseError("unreadable"); }
  let cancelRead: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    cancelRead = () => {
      cancelUpstreamRead(reader, track);
      reject(new UpstreamCancelledError());
    };
    signal.addEventListener("abort", cancelRead, { once: true });
  });
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  try {
    throwIfCancelled(signal);
    while (true) {
      checkpoint();
      const next = await Promise.race([reader.read(), cancelled]);
      checkpoint();
      throwIfCancelled(signal);
      if (next.done) { complete = true; break; }
      if (!(next.value instanceof Uint8Array)) throw new UpstreamResponseError("unreadable");
      if (next.value.byteLength > maxBytes - size) throw new UpstreamResponseError("too-large");
      size += next.value.byteLength;
      if (next.value.byteLength) chunks.push(next.value.slice());
      if (progress) progress.bytes = size;
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { ...result, bytes };
  } catch (error) {
    if (signal.aborted) throw new UpstreamCancelledError();
    if (error instanceof UpstreamResponseError) throw error;
    throw new UpstreamResponseError("unreadable");
  } finally {
    if (cancelRead) signal.removeEventListener("abort", cancelRead);
    if (!complete) cancelUpstreamRead(reader, track);
    reader.releaseLock();
  }
}

/** Strict UTF-8 prevents silently replacing corrupted bytes in signed/exported JSON. */
export function upstreamJsonText(response: BufferedApiResponse): string {
  const contentType = response.headers.get("content-type");
  if (contentType !== null && !JSON_TYPE.test(contentType)) throw new UpstreamResponseError("invalid-content-type");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(response.bytes); }
  catch { throw new UpstreamResponseError("invalid-json"); }
}

export function upstreamJsonPayload(response: BufferedApiResponse): unknown {
  try { return JSON.parse(upstreamJsonText(response)) as unknown; }
  catch (error) {
    if (error instanceof UpstreamResponseError) throw error;
    throw new UpstreamResponseError("invalid-json");
  }
}

/** Reconstructed buffers never carry upstream framing, cookies or cache policy. */
export function bufferedResponse(response: BufferedApiResponse): Response {
  const headers = new Headers();
  for (const name of ["content-type", "retry-after", "etag"]) {
    const value = response.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set("cache-control", "no-store, max-age=0");
  const noBody = response.status === 204 || response.status === 205 || response.status === 304;
  return new Response(noBody || response.bytes.byteLength === 0 ? null : response.bytes,
    { status: response.status, statusText: response.statusText, headers });
}
