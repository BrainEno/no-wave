import { NextRequest, NextResponse } from "next/server";
import { handleNotificationsReadAllRequest } from "@bot-thk/web-http";
import { apiConfig, toNextResponse } from "@/lib/authoring-proxy.ts";

/**
 * `POST /api/authoring/notifications/read-all` — mark every notice read.
 *
 * A write, so the Origin check and the no-store policy are the shared handler's
 * job, in the order every other mutation here uses.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  return toNextResponse(await handleNotificationsReadAllRequest(request, apiConfig()));
}
