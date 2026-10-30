import { NextRequest, NextResponse } from "next/server";
import { handleNotificationReadRequest } from "@bot-thk/web-http";
import { apiConfig, toNextResponse } from "@/lib/authoring-proxy.ts";

/**
 * `PUT /api/authoring/notifications/:id/read` — mark one notice read.
 *
 * The id is validated inside the shared handler, after the Origin check, so a
 * cross-origin caller cannot use the status code to probe which ids exist.
 */
export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  return toNextResponse(await handleNotificationReadRequest(request, { id }, apiConfig()));
}
