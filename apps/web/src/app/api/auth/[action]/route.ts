import { NextRequest, NextResponse } from "next/server";
import { handleAuthPost } from "@/lib/authoring-proxy.ts";

const AUTH_ACTIONS = new Set(["login", "register", "refresh", "logout"]);

export async function POST(request: NextRequest, context: { params: Promise<{ action: string }> }): Promise<NextResponse> {
  const { action } = await context.params;
  if (!AUTH_ACTIONS.has(action)) {
    return NextResponse.json({ error: { code: "NOT_FOUND", message: "The authentication route was not found." } }, { status: 404, headers: { "cache-control": "no-store" } });
  }
  return handleAuthPost(request, action as "login" | "register" | "refresh" | "logout");
}
