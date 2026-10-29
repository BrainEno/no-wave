import { NextRequest, NextResponse } from "next/server";
import { resolveApiBaseUrl } from "@/lib/api-content.ts";

export const runtime = "nodejs";
const NO_STORE = { "cache-control": "no-store, max-age=0" };
const MEDIA_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function apiUrl(base: string, id: string): string {
  return new URL("api/v1/media/" + encodeURIComponent(id), base.replace(/\/+$/, "") + "/").toString();
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await context.params;
  if (!MEDIA_ID.test(id)) {
    return NextResponse.json({ error: { code: "NOT_FOUND", message: "The requested media asset was not found." } }, { status: 404, headers: NO_STORE });
  }
  let base: string | undefined;
  try { base = resolveApiBaseUrl(); } catch { base = undefined; }
  if (!base) {
    return NextResponse.json({ error: { code: "SERVICE_UNAVAILABLE", message: "The API service is not configured." } }, { status: 503, headers: NO_STORE });
  }

  const headers = new Headers({ accept: "image/webp" });
  const incomingEtag = request.headers.get("if-none-match");
  if (incomingEtag && /^"[0-9a-f]{64}"$/i.test(incomingEtag.trim())) headers.set("if-none-match", incomingEtag.trim());
  let upstream: Response;
  try {
    upstream = await fetch(apiUrl(base, id), { method: "GET", headers, cache: "no-store" });
  } catch {
    return NextResponse.json({ error: { code: "SERVICE_UNAVAILABLE", message: "The media service could not be reached." } }, { status: 502, headers: NO_STORE });
  }

  if (upstream.status === 304) {
    return new NextResponse(null, {
      status: 304,
      headers: {
        "cache-control": "public, max-age=31536000, immutable",
        ...(upstream.headers.get("etag") ? { etag: upstream.headers.get("etag")! } : {}),
      },
    });
  }
  if (!upstream.ok) {
    if (upstream.status === 404) {
      return NextResponse.json({ error: { code: "NOT_FOUND", message: "The requested media asset was not found." } }, { status: 404, headers: NO_STORE });
    }
    return NextResponse.json({ error: { code: "MEDIA_STORAGE_UNAVAILABLE", message: "The media service is temporarily unavailable." } }, { status: 503, headers: NO_STORE });
  }
  const declaredSize = Number(upstream.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > 8 * 1024 * 1024) {
    return NextResponse.json({ error: { code: "MEDIA_STORAGE_UNAVAILABLE", message: "The media object exceeded the response limit." } }, { status: 502, headers: NO_STORE });
  }
  const body = await upstream.arrayBuffer();
  if (body.byteLength < 1 || body.byteLength > 8 * 1024 * 1024) {
    return NextResponse.json({ error: { code: "MEDIA_STORAGE_UNAVAILABLE", message: "The media object exceeded the response limit." } }, { status: 502, headers: NO_STORE });
  }
  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": upstream.headers.get("content-type") === "image/webp" ? "image/webp" : "application/octet-stream",
      "content-length": String(body.byteLength),
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      ...(upstream.headers.get("etag") ? { etag: upstream.headers.get("etag")! } : {}),
    },
  });
}
