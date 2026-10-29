import { NextRequest, NextResponse } from "next/server";
import { handleAuthoringArticleRequest } from "@bot-thk/web-http";
import { apiConfig, toNextResponse } from "@/lib/authoring-proxy.ts";

/**
 * `PUT /api/authoring/articles/:id` — Phase 4b.
 *
 * Save or publish an existing work. The shared handler checks the Origin before
 * it validates the id, so a cross-origin caller cannot use the status code to
 * probe which ids exist.
 */
export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  return toNextResponse(await handleAuthoringArticleRequest(request, { id }, apiConfig()));
}
