import { NextRequest, NextResponse } from "next/server";
import { isAuthAction, isIdentityAction } from "@bot-thk/web-http";
import { handleAuthPost } from "@/lib/authoring-proxy.ts";

/**
 * The browser-facing auth routes.
 *
 * `login`/`register`/`refresh`/`logout` carry a session; the recovery and
 * verification actions in `IDENTITY_ACTIONS` share the route family but are
 * handled without one. Both sets are validated by the shared package, so this
 * file only has to refuse what neither set names — and it no longer restates
 * the action list as a type, which is what let the two drift apart.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ action: string }> }): Promise<NextResponse> {
  const { action } = await context.params;
  if (!isAuthAction(action) && !isIdentityAction(action)) {
    return NextResponse.json({ error: { code: "NOT_FOUND", message: "The authentication route was not found." } }, { status: 404, headers: { "cache-control": "no-store" } });
  }
  return handleAuthPost(request, action);
}
