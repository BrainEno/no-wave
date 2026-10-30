import { NextRequest, NextResponse } from "next/server";
import { handleAuthoringArticleRequest } from "@bot-thk/web-http";
import { apiConfig, toNextResponse } from "@/lib/authoring-proxy.ts";

/**
 * `PUT /api/authoring/articles/:id` — Phase 4b.
 * `DELETE /api/authoring/articles/:id` — deleting a work.
 *
 * Save or publish an existing work, or delete it. The shared handler checks the
 * Origin before it validates the id, so a cross-origin caller cannot use the
 * status code to probe which ids exist.
 */
export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  return toNextResponse(await handleAuthoringArticleRequest(request, { id }, apiConfig()));
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  return toNextResponse(await handleAuthoringArticleRequest(request, { id }, apiConfig()));
}
