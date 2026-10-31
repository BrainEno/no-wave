import { handleAccountEmailVerificationRequest } from "@bot-thk/web-http";
import { apiBaseUrl } from "./runtime.ts";

/**
 * React Router binding for the account actions (ADR 0014).
 *
 * The handler — method, exact-Origin check, cookie-attached forwarding, the
 * decision not to read a request body at all — lives in `@bot-thk/web-http` so
 * the App Router route and this one cannot drift apart. The only thing left
 * here is the API origin.
 */
export async function handleAccountEmailVerification(request: Request): Promise<Response> {
  return handleAccountEmailVerificationRequest(request, { apiBaseUrl: apiBaseUrl() });
}
