import { NextRequest, NextResponse } from "next/server";
import { handleArticleCommentsRequest } from "@bot-thk/web-http";
import { apiConfig } from "@/lib/authoring-proxy.ts";

/**
 * Article comments (`GET`/`POST`) — Phase 4a.
 *
 * The behaviour — slug/locale validation, the exact-Origin check on mutations,
 * the bounded body, cookie-attached forwarding — lives in the framework-neutral
 * handler, so the React Router prototype serves this endpoint from the same code
 * instead of a second copy. This file does only what the App Router requires:
 * read the slug from the route params and convert the standard `Response`.
 */
function toNextResponse(response: Response): NextResponse {
  const next = new NextResponse(response.status === 204 || response.status === 304 ? null : response.body, {
    status: response.status,
  });
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") next.headers.set(name, value);
  });
  for (const cookie of response.headers.getSetCookie()) next.headers.append("set-cookie", cookie);
  return next;
}

async function handle(request: NextRequest, slug: string): Promise<NextResponse> {
  const locale = request.nextUrl.searchParams.get("locale");
  return toNextResponse(
    await handleArticleCommentsRequest(request, { slug, locale }, apiConfig()),
  );
}

export async function GET(request: NextRequest, context: { params: Promise<{ slug: string }> }): Promise<NextResponse> {
  const { slug } = await context.params;
  return handle(request, slug);
}

export async function POST(request: NextRequest, context: { params: Promise<{ slug: string }> }): Promise<NextResponse> {
  const { slug } = await context.params;
  return handle(request, slug);
}
