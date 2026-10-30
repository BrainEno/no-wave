import { NextRequest, NextResponse } from "next/server";
import { handleNotificationsRequest } from "@bot-thk/web-http";
import { apiConfig, toNextResponse } from "@/lib/authoring-proxy.ts";

/**
 * `GET /api/authoring/notifications` — the signed-in reader's inbox.
 *
 * The notice a commenter gets when a work they commented on is deleted is only
 * a message if somebody can read it, and this is where it becomes readable.
 * Everything that matters about the contract — the method, the no-store policy,
 * the cookie-attached forwarding and the refresh-and-retry — lives in the
 * shared handler, so the React Router prototype serves the same inbox from the
 * same code.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  return toNextResponse(await handleNotificationsRequest(request, apiConfig()));
}
