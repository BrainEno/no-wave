import { NextRequest, NextResponse } from "next/server";
import { forwardAuthoringApi, readLimitedJsonObject } from "@/lib/authoring-proxy.ts";
import { isSameOriginMutation } from "@/lib/authoring-proxy-policy.ts";

const ARTICLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!isSameOriginMutation(request.url, request.headers.get("origin"))) {
    return NextResponse.json({ error: { code: "ORIGIN_REJECTED", message: "The request origin was rejected." } }, { status: 403, headers: { "cache-control": "no-store" } });
  }
  const { id } = await context.params;
  if (!ARTICLE_ID.test(id)) {
    return NextResponse.json({ error: { code: "BAD_USER_INPUT", message: "Invalid article ID." } }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  const parsed = await readLimitedJsonObject(request);
  if (!parsed.ok) return parsed.response;
  return forwardAuthoringApi(request, `api/v1/articles/${encodeURIComponent(id)}`, "PUT", parsed.text);
}
