import type { ApiProxyConfig } from "./api.ts";
import { readLimitedJson } from "./body.ts";
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

/**
 * An identity change is two short fields — what you have, and what you want it
 * to become. Bounded like the other identity bodies, because a proxy has no
 * reason to buffer megabytes in front of an endpoint that answers 401.
 */
const ACCOUNT_BODY_MAX_BYTES = 4096;

/**
 * `PUT /api/authoring/password` — change the signed-in account's password.
 *
 * Both credentials go upstream exactly as the browser typed them: the proxy
 * cannot check the old one and must not keep the new one, so the body is read
 * once, bounded, and forwarded without being parsed. The rules — that the old
 * password must match, and how long the new one must be — belong to the API,
 * which is the only place that can enforce them against the stored hash.
 *
 * No token is issued here either: a change keeps the session that made it and
 * ends the others, and which session that is, is the API's to decide. The
 * refresh-and-retry in the forwarder still applies, so an expired access token
 * is renewed rather than answered as a failure.
 */
export async function handleAccountPasswordChangeRequest(
  request: Request,
  config: ApiProxyConfig = {},
): Promise<Response> {
  const method = methodOf(request, ["PUT"]);
  if (method === null) {
    return errorResponse("METHOD_NOT_ALLOWED", "Only PUT is supported for a password change.", 405);
  }
  if (rejectCrossOrigin(request)) {
    return errorResponse("ORIGIN_REJECTED", "The request origin was rejected.", 403);
  }
  const body = await readLimitedJson(request, ACCOUNT_BODY_MAX_BYTES);
  if (!body.ok) return body.response;
  return forwardAuthoringRequest(request, "api/v1/me/password", "PUT", config, body.text);
}

/**
 * `PUT /api/authoring/email` — move the signed-in account to another address.
 *
 * The current password travels with the new address, for the same reason it
 * travels with a new password and then some: whoever controls the address
 * controls the account's recovery. The proxy cannot check either field, so it
 * reads the body once, bounded, and forwards it without parsing — what counts
 * as an address, and whether it is taken, is the API's to decide.
 *
 * Nothing is refreshed or re-issued here: the account keeps its session, and
 * the answer carries the address and its verification state so the page can
 * show them without asking again.
 */
export async function handleAccountEmailChangeRequest(
  request: Request,
  config: ApiProxyConfig = {},
): Promise<Response> {
  const method = methodOf(request, ["PUT"]);
  if (method === null) {
    return errorResponse("METHOD_NOT_ALLOWED", "Only PUT is supported for changing the address.", 405);
  }
  if (rejectCrossOrigin(request)) {
    return errorResponse("ORIGIN_REJECTED", "The request origin was rejected.", 403);
  }
  const body = await readLimitedJson(request, ACCOUNT_BODY_MAX_BYTES);
  if (!body.ok) return body.response;
  return forwardAuthoringRequest(request, "api/v1/me/email", "PUT", config, body.text);
}
