import { NextRequest } from "next/server";
import { forwardAuthoringApi } from "@/lib/authoring-proxy.ts";

export async function GET(request: NextRequest) {
  return forwardAuthoringApi(request, "api/v1/me", "GET");
}
