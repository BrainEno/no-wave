import { NextRequest, NextResponse } from "next/server";
import { handleAuthoringRestoreRequest } from "@bot-thk/web-http";
import { apiConfig, toNextResponse } from "@/lib/authoring-proxy.ts";

/**
 * `POST /api/authoring/articles/:id/restore` — bring a deleted work back.
 *
 * A restore is a write, so it is Origin-checked and id-shaped-checked before
 * anything is forwarded, in the shared handler, in the order a save already
 * uses. The work returns as a draft: deleting it withdrew it from the public
 * site, and republishing is the author's decision to make again.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  return toNextResponse(await handleAuthoringRestoreRequest(request, { id }, apiConfig()));
}
