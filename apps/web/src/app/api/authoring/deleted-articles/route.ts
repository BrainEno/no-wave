import { NextRequest, NextResponse } from "next/server";
import { handleAuthoringDeletedArticlesRequest } from "@bot-thk/web-http";
import { apiConfig, toNextResponse } from "@/lib/authoring-proxy.ts";

/**
 * `GET /api/authoring/deleted-articles` — the desk's recycle bin.
 *
 * The author's own deleted works, each with the moment it was deleted and the
 * moment the sweep will make that permanent. Everything that matters about the
 * contract — the method, the no-store policy, the cookie-attached forwarding and
 * the refresh-and-retry — lives in the shared handler, so the React Router
 * prototype serves the same recycle bin from the same code.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  return toNextResponse(await handleAuthoringDeletedArticlesRequest(request, apiConfig()));
}
