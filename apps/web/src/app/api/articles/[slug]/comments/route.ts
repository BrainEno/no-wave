import { NextRequest, NextResponse } from "next/server";
import { forwardAuthoringApi, readLimitedJsonObject } from "@/lib/authoring-proxy.ts";
import { isSameOriginMutation } from "@/lib/authoring-proxy-policy.ts";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LOCALES = new Set(["zh-CN", "zh-TW", "en"]);

function requestPath(slug: string, locale: string): string {
  return "api/v1/articles/" + encodeURIComponent(slug) + "/comments?locale=" + encodeURIComponent(locale) + "&limit=50";
}

export async function GET(request: NextRequest, context: { params: Promise<{ slug: string }> }): Promise<NextResponse> {
  const { slug } = await context.params;
  const locale = request.nextUrl.searchParams.get("locale") ?? "zh-CN";
  if (!SLUG.test(slug) || !LOCALES.has(locale)) {
    return NextResponse.json({ error: { code: "BAD_USER_INPUT", message: "Invalid article slug or locale." } }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  return forwardAuthoringApi(request, requestPath(slug, locale), "GET");
}

export async function POST(request: NextRequest, context: { params: Promise<{ slug: string }> }): Promise<NextResponse> {
  if (!isSameOriginMutation(request.url, request.headers.get("origin"))) {
    return NextResponse.json({ error: { code: "ORIGIN_REJECTED", message: "The request origin was rejected." } }, { status: 403, headers: { "cache-control": "no-store" } });
  }
  const { slug } = await context.params;
  const locale = request.nextUrl.searchParams.get("locale") ?? "zh-CN";
  if (!SLUG.test(slug) || !LOCALES.has(locale)) {
    return NextResponse.json({ error: { code: "BAD_USER_INPUT", message: "Invalid article slug or locale." } }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  const body = await readLimitedJsonObject(request, 512 * 1024);
  if (!body.ok) return body.response;
  return forwardAuthoringApi(request, requestPath(slug, locale), "POST", body.text);
}
