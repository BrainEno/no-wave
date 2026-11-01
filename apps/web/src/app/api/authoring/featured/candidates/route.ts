import { NextRequest, NextResponse } from "next/server";
import { handleAuthoringFeaturedCandidatesRequest } from "@bot-thk/web-http";
import { apiConfig, toNextResponse } from "@/lib/authoring-proxy.ts";

/**
 * `GET /api/authoring/featured/candidates` — published works an editor may pick.
 *
 * It exists only to feed the editorial screen: the query is built in the shared
 * handler rather than relayed, so the browser cannot ask upstream for drafts or
 * for more works than a page can hold.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  return toNextResponse(await handleAuthoringFeaturedCandidatesRequest(request, apiConfig()));
}
