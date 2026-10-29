import type { NextRequest } from "next/server";
import { fetchPublicMedia } from "@/lib/authoring-proxy.ts";

export const runtime = "nodejs";

/**
 * Public media read.
 *
 * The object store is private and its credentials stay in the API, so the bytes
 * are relayed through the app. Everything else about the response — id
 * validation, immutable caching, ETag revalidation, the 8 MiB ceiling and the
 * content-type lockdown — is defined once in `@bot-thk/web-http` and shared with
 * the React Router prototype.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  return fetchPublicMedia(request, id);
}
