import assert from "node:assert/strict";
import test from "node:test";

import { handleAccountEmailVerificationRequest } from "../src/account.ts";
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from "../src/policy.ts";
import { API_BASE, ROTATED, TOKENS, assertNoStore, json, request, setCookies, stubFetch, tokenEnvelope } from "./helpers.ts";

/**
 * Account-action proxy contract (ADR 0014).
 *
 * Asking for a verification link is the one account action a signed-in browser
 * can take, and it is addressed entirely by the session: no address travels in
 * the request, so a caller cannot aim mail at an address that is not theirs.
 * That is only true while the token comes from the HttpOnly cookie, which is
 * what these assertions pin down — together with the Origin check, the method,
 * and the fact that a 401 is an answer rather than an error.
 */

function verificationRequest(method = "POST", headers: Record<string, string> = {}): Request {
  return request("/api/authoring/email-verification", {
    method,
    headers: { host: "no-wave.test", origin: "https://no-wave.test", ...headers },
  });
}

function signedIn(): Record<string, string> {
  return { cookie: `${ACCESS_TOKEN_COOKIE}=${TOKENS.accessToken}; ${REFRESH_TOKEN_COOKIE}=${TOKENS.refreshToken}` };
}

test("a verification request is forwarded with the cookie's token and no address of its own", async () => {
  const stub = stubFetch({ "api/v1/me/email-verification": () => json({ data: { ok: true, alreadyVerified: false } }, 202) });
  const response = await handleAccountEmailVerificationRequest(verificationRequest("POST", signedIn()), {
    apiBaseUrl: API_BASE,
    fetchImpl: stub.fetchImpl,
  });

  assert.equal(response.status, 202);
  assertNoStore(response);
  assert.deepEqual(await response.json(), { data: { ok: true, alreadyVerified: false } });
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0]?.url, `${API_BASE}/api/v1/me/email-verification`);
  const headers = stub.calls[0]?.init?.headers as Headers;
  assert.equal(headers.get("authorization"), `Bearer ${TOKENS.accessToken}`);
  assert.equal(stub.calls[0]?.init?.method, "POST");
  // The API decides whose address gets the mail, so the body carries nothing.
  assert.equal(stub.calls[0]?.init?.body, "{}");
});

test("only a POST from our own origin reaches the API", async () => {
  const stub = stubFetch({ "api/v1/": () => json({ data: {} }, 200) });

  const read = await handleAccountEmailVerificationRequest(verificationRequest("GET", signedIn()), {
    apiBaseUrl: API_BASE,
    fetchImpl: stub.fetchImpl,
  });
  assert.equal(read.status, 405);

  const foreign = await handleAccountEmailVerificationRequest(
    verificationRequest("POST", { ...signedIn(), origin: "https://evil.test" }),
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.equal(foreign.status, 403);

  assert.equal(stub.calls.length, 0, "neither request may reach the API");
});

test("a signed-out visitor gets a 401 to render, and a rejected session is cleared rather than retried", async () => {
  const anonymous = stubFetch({ "api/v1/me/email-verification": () => json({ error: { code: "UNAUTHENTICATED" } }, 401) });
  const response = await handleAccountEmailVerificationRequest(verificationRequest(), {
    apiBaseUrl: API_BASE,
    fetchImpl: anonymous.fetchImpl,
  });
  assert.equal(response.status, 401);
  assertNoStore(response);
  assert.equal(setCookies(response).length, 0, "without a refresh token there is nothing to clear");

  // A refused refresh token means the session is over: the proxy clears the
  // cookies instead of leaving the desk to retry a credential the API rejected.
  const expired = stubFetch({
    "api/v1/me/email-verification": () => json({ error: { code: "UNAUTHENTICATED" } }, 401),
    "api/v1/auth/refresh": () => json({ error: { code: "UNAUTHENTICATED" } }, 401),
  });
  const rejected = await handleAccountEmailVerificationRequest(verificationRequest("POST", signedIn()), {
    apiBaseUrl: API_BASE,
    fetchImpl: expired.fetchImpl,
  });
  assert.equal(rejected.status, 401);
  assert.equal(setCookies(rejected).length, 2, "both cookies must be cleared when the refresh is refused");
});

test("an expired access token is refreshed once and the call is retried with the new one", async () => {
  let attempts = 0;
  const stub = stubFetch({
    // The first attempt meets an expired access token; the retry is the one
    // that must carry the rotated credential, and it is the only one that counts.
    "api/v1/me/email-verification": () => {
      attempts += 1;
      return attempts === 1
        ? json({ error: { code: "UNAUTHENTICATED" } }, 401)
        : json({ data: { ok: true, alreadyVerified: true } }, 202);
    },
    "api/v1/auth/refresh": () => tokenEnvelope(ROTATED),
  });
  const response = await handleAccountEmailVerificationRequest(verificationRequest("POST", signedIn()), {
    apiBaseUrl: API_BASE,
    fetchImpl: stub.fetchImpl,
  });

  assert.equal(response.status, 202);
  assert.equal(attempts, 2, "the expired token must be retried exactly once, never in a loop");
  assert.match(setCookies(response).join(";"), new RegExp(`${ACCESS_TOKEN_COOKIE}=${ROTATED.accessToken}`));
});

test("no configured API is a 503 the desk can explain, not a framework error", async () => {
  const stub = stubFetch({ "api/v1/": () => json({ data: {} }, 200) });
  const response = await handleAccountEmailVerificationRequest(verificationRequest("POST", signedIn()), {
    fetchImpl: stub.fetchImpl,
  });
  assert.equal(response.status, 503);
  assert.match(await response.text(), /SERVICE_UNAVAILABLE/);
  assert.equal(stub.calls.length, 0);
});
