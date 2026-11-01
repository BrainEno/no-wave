import { handleAuthRequest } from "@bot-thk/web-http";
import { apiBaseUrl } from "./runtime.ts";

/**
 * React Router binding for the shared HTTP seam.
 *
 * Phase 2 moved the cookie policy, origin check, body limits and error mapping
 * into `@bot-thk/web-http`; the only framework-specific step left is resolving
 * the server-only API origin. Every route handler in this application calls the
 * same package the same way.
 */
export async function handleAuth(request: Request, action: string | undefined): Promise<Response> {
  return handleAuthRequest(request, action, { apiBaseUrl: apiBaseUrl() });
}
