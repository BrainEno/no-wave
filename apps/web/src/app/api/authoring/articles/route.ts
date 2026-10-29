import { NextRequest, NextResponse } from "next/server";
import { handleAuthoringArticlesRequest } from "@bot-thk/web-http";
import { apiConfig, toNextResponse } from "@/lib/authoring-proxy.ts";

/**
 * `GET`/`POST /api/authoring/articles` — Phase 4b.
 *
 * The author's list, and a new work. The Origin check, the bounded body, the
 * cookie-attached forwarding and the refresh-and-retry all live in the shared
 * handler, so the React Router prototype serves the writing desk from the same
 * code instead of a second copy.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  return toNextResponse(await handleAuthoringArticlesRequest(request, apiConfig()));
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return toNextResponse(await handleAuthoringArticlesRequest(request, apiConfig()));
}
