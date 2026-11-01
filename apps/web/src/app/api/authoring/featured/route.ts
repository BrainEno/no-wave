import { NextRequest, NextResponse } from "next/server";
import { handleAuthoringFeaturedRequest } from "@bot-thk/web-http";
import { apiConfig, toNextResponse } from "@/lib/authoring-proxy.ts";

/**
 * `GET`/`PUT /api/authoring/featured` — the front page's picked shelf.
 *
 * The read is public; the write is the editors' rearrangement and is refused
 * upstream unless the caller has the role. Both halves live in the shared
 * handler, so the React Router prototype serves the same shelf from the same
 * code: the token stays in an `HttpOnly` cookie the browser cannot present, and
 * the write is checked against our own origin before it goes anywhere.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  return toNextResponse(await handleAuthoringFeaturedRequest(request, apiConfig()));
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  return toNextResponse(await handleAuthoringFeaturedRequest(request, apiConfig()));
}
