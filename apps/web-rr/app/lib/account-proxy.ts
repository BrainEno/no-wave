import {
  handleAccountEmailChangeRequest,
  handleAccountEmailVerificationRequest,
  handleAccountPasswordChangeRequest,
} from "@bot-thk/web-http";
import { apiBaseUrl } from "./runtime.ts";

/**
 * React Router binding for the account actions (ADR 0014).
 *
 * The handler — method, exact-Origin check, cookie-attached forwarding, the
 * decision not to read a request body at all — lives in `@bot-thk/web-http` so
 * every caller of it behaves identically. The only thing left here is the API
 * origin.
 */
export async function handleAccountEmailVerification(request: Request): Promise<Response> {
  return handleAccountEmailVerificationRequest(request, { apiBaseUrl: apiBaseUrl() });
}

/**
 * React Router binding for `PUT /api/authoring/password`.
 *
 * Everything that decides anything — the method, the exact-Origin check, the
 * bounded body, the cookie-attached forwarding — is the shared handler's, so
 * there is one place for it to be right. The only thing here is the API origin.
 */
export async function handleAccountPasswordChange(request: Request): Promise<Response> {
  return handleAccountPasswordChangeRequest(request, { apiBaseUrl: apiBaseUrl() });
}

/**
 * React Router binding for `PUT /api/authoring/email`.
 *
 * Everything that decides anything is the shared handler's; the only thing
 * here is the API origin.
 */
export async function handleAccountEmailChange(request: Request): Promise<Response> {
  return handleAccountEmailChangeRequest(request, { apiBaseUrl: apiBaseUrl() });
}
