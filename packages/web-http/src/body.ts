import { errorResponse, isRecord } from "./http.ts";
import { UpstreamTimeoutError, withUpstreamDeadline, type DeadlineCheckpoint } from "./api.ts";
import { UpstreamCancelledError } from "./upstream-errors.ts";

export const DEFAULT_REQUEST_BODY_TIMEOUT_MS = 30_000;
export type RequestBodyOptions = { timeoutMs?: number };

function declaredLengthFailure(request: Request, maximumBytes: number, tooLargeMessage: string): StreamReadFailure | null {
  const declared = request.headers.get("content-length");
  if (declared === null) return null;
  if (!/^\d+$/.test(declared)) return { ok: false, reason: "unreadable", response: errorResponse("BAD_USER_INPUT", "Invalid Content-Length.", 400) };
  if (Number(declared) > maximumBytes) return { ok: false, reason: "too-large", response: errorResponse("PAYLOAD_TOO_LARGE", tooLargeMessage, 413) };
  return null;
}

async function readIncomingBody(request: Request, maximumBytes: number, tooLargeMessage: string, emptyMessage: string, unreadableMessage: string, options: RequestBodyOptions): Promise<BytesBodyResult> {
  const declared = declaredLengthFailure(request, maximumBytes, tooLargeMessage);
  if (declared) return declared;
  try {
    const body = await withUpstreamDeadline(options.timeoutMs ?? DEFAULT_REQUEST_BODY_TIMEOUT_MS,
      (signal, checkpoint) => readLimitedStream(request.body, maximumBytes, tooLargeMessage, emptyMessage, unreadableMessage, signal, checkpoint), request.signal);
    if (!body.ok) return body;
    const advertised = request.headers.get("content-length");
    if (advertised !== null && Number(advertised) !== body.bytes.byteLength) {
      return { ok: false, reason: "unreadable", response: errorResponse("BAD_USER_INPUT", "The request body length did not match Content-Length.", 400) };
    }
    return body;
  } catch (error) {
    const timeout = error instanceof UpstreamTimeoutError;
    const cancelled = error instanceof UpstreamCancelledError;
    return { ok: false, reason: "unreadable", response: errorResponse(timeout ? "REQUEST_BODY_TIMEOUT" : cancelled ? "REQUEST_CANCELLED" : "BAD_USER_INPUT",
      timeout ? "The request body did not arrive in time." : cancelled ? "The request was cancelled." : unreadableMessage, timeout ? 408 : cancelled ? 499 : 400) };
  }
}

/**
 * Bounded body readers.
 *
 * A proxy cannot trust `content-length`, so each reader checks the declared
 * length first (fail fast, no body buffered) and then enforces the same ceiling
 * on the bytes actually read.
 */

export type JsonBodyResult = { ok: true; value: Record<string, unknown>; text: string } | { ok: false; response: Response };

export async function readLimitedJson(request: Request, maximumBytes: number, options: RequestBodyOptions = {}): Promise<JsonBodyResult> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return { ok: false, response: errorResponse("UNSUPPORTED_MEDIA_TYPE", "A JSON request body is required.", 415) };
  }
  const body = await readIncomingBody(request, maximumBytes, "The request body is too large.",
    "The request body must be valid JSON.", "The request body could not be read.", options);
  if (!body.ok) return { ok: false, response: body.response };
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body.bytes);
    value = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, response: errorResponse("BAD_USER_INPUT", "The request body must be valid JSON.", 400) };
  }
  if (!isRecord(value)) {
    return { ok: false, response: errorResponse("BAD_USER_INPUT", "The request body must be a JSON object.", 400) };
  }
  return { ok: true, value, text };
}

export type BytesBodyResult = { ok: true; bytes: Uint8Array<ArrayBuffer> } | StreamReadFailure;

/**
 * A bounded read can fail in three ways, and the caller needs to know which:
 * a proxied *response* that is too large is a 502 upstream problem, while an
 * empty *request* body is a 400 client error, so the status cannot be decided
 * inside this module.
 */
export type StreamReadFailure = {
  ok: false;
  reason: "empty" | "too-large" | "unreadable";
  /** A ready-made 400/413 response for the request-body case. */
  response: Response;
};

/**
 * Read a binary stream with a hard ceiling, streaming so an oversized body is
 * abandoned instead of fully buffered.
 *
 * Kept separate from `readLimitedBytes` because a proxied **response** body is
 * just as untrusted as a request body: the media read path applies the same
 * ceiling to the bytes an upstream API sends back.
 */
export async function readLimitedStream(
  stream: ReadableStream<Uint8Array> | null,
  maximumBytes: number,
  tooLargeMessage = "The request body is too large.",
  emptyMessage = "The request body must not be empty.",
  unreadableMessage = "The request body could not be read.",
  signal?: AbortSignal,
  checkpoint: DeadlineCheckpoint = () => {},
): Promise<BytesBodyResult> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new RangeError("Invalid incoming body byte limit.");
  if (!stream) {
    return { ok: false, reason: "empty", response: errorResponse("BAD_USER_INPUT", emptyMessage, 400) };
  }

  if (signal?.aborted) throw new UpstreamCancelledError();
  const reader = stream.getReader();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => { void reader.cancel().catch(() => {}); reject(new UpstreamCancelledError()); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  let complete = false;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      checkpoint();
      const next = await Promise.race([reader.read(), aborted]);
      checkpoint();
      if (signal?.aborted) throw new UpstreamCancelledError();
      if (next.done) { complete = true; break; }
      if (!(next.value instanceof Uint8Array)) throw new TypeError("Invalid incoming byte chunk.");
      size += next.value.byteLength;
      if (size > maximumBytes) {
        void reader.cancel().catch(() => {});
        return { ok: false, reason: "too-large", response: errorResponse("PAYLOAD_TOO_LARGE", tooLargeMessage, 413) };
      }
      if (next.value.byteLength) chunks.push(next.value.slice());
    }
  } catch (error) {
    if (signal?.aborted) throw new UpstreamCancelledError();
    return { ok: false, reason: "unreadable", response: errorResponse("BAD_USER_INPUT", unreadableMessage, 400) };
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (size < 1) {
    return { ok: false, reason: "empty", response: errorResponse("BAD_USER_INPUT", emptyMessage, 400) };
  }
  // An explicitly allocated ArrayBuffer keeps the type `Uint8Array<ArrayBuffer>`,
  // which is what `BodyInit` accepts under the DOM typings used here.
  const bytes = new Uint8Array(new ArrayBuffer(size));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

/**
 * Read a binary request body with a hard ceiling.
 *
 * `content-length` is checked first so an oversized upload is rejected without
 * buffering, and then the same ceiling is enforced on the bytes actually read:
 * a client that lies about the length must not be able to overrun the process.
 */
export async function readLimitedBytes(
  request: Request,
  maximumBytes: number,
  tooLargeMessage = "The request body is too large.",
  options: RequestBodyOptions = {},
): Promise<BytesBodyResult> {
  return readIncomingBody(request, maximumBytes, tooLargeMessage, "The request body must not be empty.", "The request body could not be read.", options);
}
