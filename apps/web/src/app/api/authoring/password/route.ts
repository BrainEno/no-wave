import { NextRequest, NextResponse } from "next/server";
import { handleAccountPasswordChangeRequest } from "@bot-thk/web-http";
import { apiConfig, toNextResponse } from "@/lib/authoring-proxy.ts";

/**
 * `PUT /api/authoring/password` — change the signed-in account's password.
 *
 * The credentials are already in the request; the identity is not, and comes
 * from the HttpOnly cookie the shared handler attaches to the upstream call.
 * The method, the exact-Origin check, the bounded body and the response are the
 * handler's; this file resolves the API origin and converts the response, and
 * nothing else.
 */
export async function PUT(request: NextRequest): Promise<NextResponse> {
  return toNextResponse(await handleAccountPasswordChangeRequest(request, apiConfig()));
}
