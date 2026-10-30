import { NextRequest, NextResponse } from "next/server";
import { handleAccountEmailVerificationRequest } from "@bot-thk/web-http";
import { apiConfig, toNextResponse } from "@/lib/authoring-proxy.ts";

/**
 * `POST /api/authoring/email-verification` — ask for a verification link for the
 * signed-in account's own address.
 *
 * Which address is mailed is the API's decision, taken from the session: the
 * browser cannot name one, so this route takes no input at all. The Origin
 * check, the method and the cookie-attached forwarding are the shared handler's;
 * this file resolves the API origin and converts the response, and nothing else.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  return toNextResponse(await handleAccountEmailVerificationRequest(request, apiConfig()));
}
