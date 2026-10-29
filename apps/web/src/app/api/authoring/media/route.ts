import type { NextRequest } from "next/server";
import { handleMediaPost } from "@/lib/authoring-proxy.ts";

export const runtime = "nodejs";

/**
 * Authenticated image upload.
 *
 * The browser cannot call the API directly (the token is HttpOnly), so the bytes
 * are relayed. Origin check, content-type allow-list and the 8 MiB body ceiling
 * are enforced in `@bot-thk/web-http` before the body is buffered.
 */
export async function POST(request: NextRequest): Promise<Response> {
  return handleMediaPost(request);
}
