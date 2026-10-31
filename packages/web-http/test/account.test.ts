import assert from "node:assert/strict";
import test from "node:test";

import { handleAccountEmailVerificationRequest, handleAccountPasswordChangeRequest } from "../src/account.ts";
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
  assert.equal(setCookies(rejected).length, 3, "every session cookie — including the marker — must be cleared when the refresh is refused");
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

/**
 * `PUT /api/authoring/password`.
 *
 * The proxy's job here is narrow, and the assertions keep it narrow: carry the
 * cookie's token, refuse anything that is not a same-origin PUT, and forward
 * the body without parsing it. What makes a password acceptable is the API's
 * rule and the API's alone — a copy of it here would drift the first time it
 * changed.
 */
function passwordRequest(method = "PUT", headers: Record<string, string> = {}, body = "{}"): Request {
  // A GET has no body to carry, and the constructor refuses one.
  return request("/api/authoring/password", {
    method,
    ...(method === "GET" ? {} : { body }),
    headers: { host: "no-wave.test", origin: "https://no-wave.test", ...headers },
  });
}

test("a password change is forwarded as PUT with the cookie's token and the body untouched", async () => {
  const body = JSON.stringify({ currentPassword: "the-old-one", newPassword: "a-brand-new-password" });
  const stub = stubFetch({ "api/v1/me/password": () => json({ data: { ok: true, revokedSessions: 2 } }, 200) });
  const response = await handleAccountPasswordChangeRequest(passwordRequest("PUT", signedIn(), body), {
    apiBaseUrl: API_BASE,
    fetchImpl: stub.fetchImpl,
  });

  assert.equal(response.status, 200);
  assertNoStore(response);
  assert.deepEqual(await response.json(), { data: { ok: true, revokedSessions: 2 } });
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0]?.url, `${API_BASE}/api/v1/me/password`);
  assert.equal(stub.calls[0]?.init?.method, "PUT");
  const headers = stub.calls[0]?.init?.headers as Headers;
  assert.equal(headers.get("authorization"), `Bearer ${TOKENS.accessToken}`);
  assert.equal(stub.calls[0]?.init?.body, body, "the credentials go upstream as typed, and are not re-encoded here");
});

test("only a same-origin PUT reaches the API", async () => {
  const stub = stubFetch({ "api/v1/": () => json({ data: {} }, 200) });

  const posted = await handleAccountPasswordChangeRequest(passwordRequest("POST", signedIn()), {
    apiBaseUrl: API_BASE,
    fetchImpl: stub.fetchImpl,
  });
  assert.equal(posted.status, 405);

  const read = await handleAccountPasswordChangeRequest(passwordRequest("GET", signedIn()), {
    apiBaseUrl: API_BASE,
    fetchImpl: stub.fetchImpl,
  });
  assert.equal(read.status, 405, "a password is never readable");

  const foreign = await handleAccountPasswordChangeRequest(
    passwordRequest("PUT", { ...signedIn(), origin: "https://evil.test" }),
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.equal(foreign.status, 403);
  assert.equal(stub.calls.length, 0, "none of them may reach the API");
});

test("a password change body is bounded, and a body that is not JSON is refused here", async () => {
  const stub = stubFetch({ "api/v1/": () => json({ data: {} }, 200) });
  const form = await handleAccountPasswordChangeRequest(
    new Request("https://no-wave.test/api/authoring/password", {
      method: "PUT",
      headers: { host: "no-wave.test", origin: "https://no-wave.test", "content-type": "text/plain", ...signedIn() },
      body: "currentPassword=x",
    }),
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.equal(form.status, 415);

  const oversized = await handleAccountPasswordChangeRequest(
    passwordRequest("PUT", signedIn(), JSON.stringify({ currentPassword: "x", newPassword: "y".repeat(9000) })),
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.equal(oversized.status, 413);
  assert.equal(stub.calls.length, 0, "no credential is forwarded before it has been bounded");
});

test("a signed-out password change is a 401 to render, and a refused refresh clears the cookies", async () => {
  const anonymous = stubFetch({ "api/v1/me/password": () => json({ error: { code: "UNAUTHENTICATED" } }, 401) });
  const noSession = await handleAccountPasswordChangeRequest(passwordRequest("PUT", {}, "{}"), {
    apiBaseUrl: API_BASE,
    fetchImpl: anonymous.fetchImpl,
  });
  assert.equal(noSession.status, 401);
  assertNoStore(noSession);
  assert.equal(setCookies(noSession).length, 0, "without a refresh token there is nothing to clear");

  const expired = stubFetch({
    "api/v1/me/password": () => json({ error: { code: "UNAUTHENTICATED" } }, 401),
    "api/v1/auth/refresh": () => json({ error: { code: "UNAUTHENTICATED" } }, 401),
  });
  const rejected = await handleAccountPasswordChangeRequest(passwordRequest("PUT", signedIn()), {
    apiBaseUrl: API_BASE,
    fetchImpl: expired.fetchImpl,
  });
  assert.equal(rejected.status, 401);
  assert.equal(setCookies(rejected).length, 3, "every session cookie is cleared when the refresh is refused");
});

test("an expired access token is refreshed once and the password change is retried", async () => {
  let attempts = 0;
  const stub = stubFetch({
    "api/v1/me/password": () => {
      attempts += 1;
      return attempts === 1 ? json({ error: { code: "UNAUTHENTICATED" } }, 401) : json({ data: { ok: true, revokedSessions: 0 } }, 200);
    },
    "api/v1/auth/refresh": () => tokenEnvelope(ROTATED),
  });
  const response = await handleAccountPasswordChangeRequest(passwordRequest("PUT", signedIn()), {
    apiBaseUrl: API_BASE,
    fetchImpl: stub.fetchImpl,
  });
  assert.equal(response.status, 200);
  assert.equal(attempts, 2, "retried exactly once, never in a loop");
  assert.match(setCookies(response).join(";"), new RegExp(`${ACCESS_TOKEN_COOKIE}=${ROTATED.accessToken}`));
});

test("no configured API is a 503 the account page can explain", async () => {
  const stub = stubFetch({ "api/v1/": () => json({ data: {} }, 200) });
  const response = await handleAccountPasswordChangeRequest(passwordRequest("PUT", signedIn()), {
    fetchImpl: stub.fetchImpl,
  });
  assert.equal(response.status, 503);
  assert.match(await response.text(), /SERVICE_UNAVAILABLE/);
  assert.equal(stub.calls.length, 0);
});
