import { errorResponse, isRecord } from "./http.ts";

/**
 * Bounded body readers.
 *
 * A proxy cannot trust `content-length`, so each reader checks the declared
 * length first (fail fast, no body buffered) and then enforces the same ceiling
 * on the bytes actually read.
 */

export type JsonBodyResult = { ok: true; value: Record<string, unknown>; text: string } | { ok: false; response: Response };

export async function readLimitedJson(request: Request, maximumBytes: number): Promise<JsonBodyResult> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return { ok: false, response: errorResponse("UNSUPPORTED_MEDIA_TYPE", "A JSON request body is required.", 415) };
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    return { ok: false, response: errorResponse("PAYLOAD_TOO_LARGE", "The request body is too large.", 413) };
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, response: errorResponse("BAD_USER_INPUT", "The request body could not be read.", 400) };
  }
  if (new TextEncoder().encode(text).byteLength > maximumBytes) {
    return { ok: false, response: errorResponse("PAYLOAD_TOO_LARGE", "The request body is too large.", 413) };
  }
  let value: unknown;
  try {
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
): Promise<BytesBodyResult> {
  if (!stream) {
    return { ok: false, reason: "empty", response: errorResponse("BAD_USER_INPUT", emptyMessage, 400) };
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "too-large", response: errorResponse("PAYLOAD_TOO_LARGE", tooLargeMessage, 413) };
      }
      chunks.push(next.value);
    }
  } catch {
    return { ok: false, reason: "unreadable", response: errorResponse("BAD_USER_INPUT", unreadableMessage, 400) };
  } finally {
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
): Promise<BytesBodyResult> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) {
      return { ok: false, reason: "unreadable", response: errorResponse("BAD_USER_INPUT", "Invalid Content-Length.", 400) };
    }
    if (BigInt(declared) > BigInt(maximumBytes)) {
      return { ok: false, reason: "too-large", response: errorResponse("PAYLOAD_TOO_LARGE", tooLargeMessage, 413) };
    }
  }
  return readLimitedStream(request.body, maximumBytes, tooLargeMessage);
}
