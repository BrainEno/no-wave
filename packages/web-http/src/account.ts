import type { ApiProxyConfig } from "./api.ts";
import { forwardAuthoringRequest } from "./forward.ts";
import { errorResponse } from "./http.ts";
import { isSameOriginMutation } from "./policy.ts";

/**
 * The account actions the browser can take while signed in (ADR 0014).
 *
 * Deliberately its own module: `authoring.ts` is the writing desk's works, and
 * an address proof is not a work. The two share nothing but the forwarding
 * helper, which is where the cookie-attached `Authorization` header and the
 * single refresh-and-retry live.
 *
 * Nothing in this file imports a framework.
 */

function methodOf(request: Request, allowed: readonly string[]): string | null {
  const method = request.method.toUpperCase();
  return allowed.includes(method) ? method : null;
}

function rejectCrossOrigin(request: Request): boolean {
  return isSameOriginMutation(request.url, request.headers.get("origin"), request.headers.get("host")) === false;
}

/**
 * `POST /api/authoring/email-verification` — ask for a verification link for
 * the signed-in account's own address.
 *
 * The API mails the address it already has for the session, so there is no
 * address in this request to get wrong: the only input is the caller's
 * identity, and that comes from the cookie `forwardAuthoringRequest` attaches.
 * A 401 is passed through as an answer — it means "sign in again", not an
 * error page — and the same helper clears the cookies when the refresh token
 * itself is refused.
 */
export async function handleAccountEmailVerificationRequest(
  request: Request,
  config: ApiProxyConfig = {},
): Promise<Response> {
  const method = methodOf(request, ["POST"]);
  if (method === null) {
    return errorResponse("METHOD_NOT_ALLOWED", "Only POST is supported for email verification.", 405);
  }
  if (rejectCrossOrigin(request)) {
    return errorResponse("ORIGIN_REJECTED", "The request origin was rejected.", 403);
  }
  // No request body is read at all: which address gets the mail is decided by
  // the session cookie upstream, so accepting a body here would only be an
  // input for a caller to get wrong. Not reading it is also the bounded choice.
  return forwardAuthoringRequest(request, "api/v1/me/email-verification", "POST", config, "{}");
}
