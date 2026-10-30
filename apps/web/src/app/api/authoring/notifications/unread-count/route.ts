import { NextRequest, NextResponse } from "next/server";
import { handleNotificationsUnreadCountRequest } from "@bot-thk/web-http";
import { apiConfig, toNextResponse } from "@/lib/authoring-proxy.ts";

/** `GET /api/authoring/notifications/unread-count` — how many notices are still unread. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  return toNextResponse(await handleNotificationsUnreadCountRequest(request, apiConfig()));
}
