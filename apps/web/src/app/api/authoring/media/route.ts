import { NextRequest, NextResponse } from "next/server";
import { forwardAuthoringApi } from "@/lib/authoring-proxy.ts";
import { isSameOriginMutation } from "@/lib/authoring-proxy-policy.ts";

export const runtime = "nodejs";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const NO_STORE = { "cache-control": "no-store, max-age=0" };

type BodyReadResult =
  | { ok: true; bytes: Uint8Array<ArrayBuffer> }
  | { ok: false; response: NextResponse };

async function readBoundedImageBody(request: NextRequest): Promise<BodyReadResult> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) {
      return { ok: false, response: NextResponse.json({ error: { code: "BAD_USER_INPUT", message: "Invalid Content-Length." } }, { status: 400, headers: NO_STORE }) };
    }
    if (BigInt(declaredLength) > BigInt(MAX_IMAGE_BYTES)) {
      return { ok: false, response: NextResponse.json({ error: { code: "PAYLOAD_TOO_LARGE", message: "The image request body exceeds 8 MiB." } }, { status: 413, headers: NO_STORE }) };
    }
  }
  if (!request.body) {
    return { ok: false, response: NextResponse.json({ error: { code: "BAD_USER_INPUT", message: "The image body must not be empty." } }, { status: 400, headers: NO_STORE }) };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_IMAGE_BYTES) {
        await reader.cancel().catch(() => {});
        return { ok: false, response: NextResponse.json({ error: { code: "PAYLOAD_TOO_LARGE", message: "The image request body exceeds 8 MiB." } }, { status: 413, headers: NO_STORE }) };
      }
      chunks.push(next.value);
    }
  } catch {
    return { ok: false, response: NextResponse.json({ error: { code: "BAD_USER_INPUT", message: "The image request body could not be read." } }, { status: 400, headers: NO_STORE }) };
  } finally {
    reader.releaseLock();
  }
  if (size < 1) {
    return { ok: false, response: NextResponse.json({ error: { code: "BAD_USER_INPUT", message: "The image body must not be empty." } }, { status: 400, headers: NO_STORE }) };
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOriginMutation(request.url, request.headers.get("origin"), request.headers.get("host"))) {
    return NextResponse.json({ error: { code: "ORIGIN_REJECTED", message: "The request origin was rejected." } }, { status: 403, headers: NO_STORE });
  }
  const contentType = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!ALLOWED_TYPES.has(contentType)) {
    return NextResponse.json({ error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Only JPEG, PNG and WebP images are accepted." } }, { status: 415, headers: NO_STORE });
  }
  const body = await readBoundedImageBody(request);
  if (!body.ok) return body.response;
  return forwardAuthoringApi(request, "api/v1/me/media", "POST", body.bytes, contentType);
}
