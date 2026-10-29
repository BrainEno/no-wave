import { NextRequest, NextResponse } from "next/server";
import { handleAuthoringSessionRequest } from "@bot-thk/web-http";
import { apiConfig, toNextResponse } from "@/lib/authoring-proxy.ts";

/**
 * `GET /api/authoring/session` — Phase 4b.
 *
 * Who is signed in, if anyone. A 401 is an answer rather than an error: the
 * writing desk renders its "sign in first" panel from it. The behaviour is the
 * framework-neutral handler's; this file resolves the API origin and converts
 * the response, and nothing else.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  return toNextResponse(await handleAuthoringSessionRequest(request, apiConfig()));
}
