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

export type BytesBodyResult = { ok: true; bytes: Uint8Array } | { ok: false; response: Response };

/**
 * Read a binary body with a hard ceiling, streaming so an oversized upload is
 * abandoned instead of fully buffered.
 */
export async function readLimitedBytes(
  request: Request,
  maximumBytes: number,
  tooLargeMessage = "The request body is too large.",
): Promise<BytesBodyResult> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) {
      return { ok: false, response: errorResponse("BAD_USER_INPUT", "Invalid Content-Length.", 400) };
    }
    if (BigInt(declared) > BigInt(maximumBytes)) {
      return { ok: false, response: errorResponse("PAYLOAD_TOO_LARGE", tooLargeMessage, 413) };
    }
  }
  if (!request.body) {
    return { ok: false, response: errorResponse("BAD_USER_INPUT", "The request body must not be empty.", 400) };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, response: errorResponse("PAYLOAD_TOO_LARGE", tooLargeMessage, 413) };
      }
      chunks.push(next.value);
    }
  } catch {
    return { ok: false, response: errorResponse("BAD_USER_INPUT", "The request body could not be read.", 400) };
  } finally {
    reader.releaseLock();
  }
  if (size < 1) {
    return { ok: false, response: errorResponse("BAD_USER_INPUT", "The request body must not be empty.", 400) };
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}
