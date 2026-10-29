import { NextRequest, NextResponse } from "next/server";
import { forwardAuthoringApi, readLimitedJsonObject } from "@/lib/authoring-proxy.ts";
import { isSameOriginMutation } from "@/lib/authoring-proxy-policy.ts";

export async function GET(request: NextRequest) {
  return forwardAuthoringApi(request, "api/v1/me/articles?locale=zh-CN&limit=100", "GET");
}

export async function POST(request: NextRequest) {
  if (!isSameOriginMutation(request.url, request.headers.get("origin"))) {
    return NextResponse.json({ error: { code: "ORIGIN_REJECTED", message: "The request origin was rejected." } }, { status: 403, headers: { "cache-control": "no-store" } });
  }
  const parsed = await readLimitedJsonObject(request);
  if (!parsed.ok) return parsed.response;
  return forwardAuthoringApi(request, "api/v1/articles", "POST", parsed.text);
}
