import assert from "node:assert/strict";
import test from "node:test";
import { handleAuthRequest } from "../src/auth.ts";
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from "../src/policy.ts";
import {
  API_BASE,
  ROTATED,
  TOKENS,
  assertNoStore,
  findCookie,
  json,
  request,
  setCookies,
  stubFetch,
  tokenEnvelope,
} from "./helpers.ts";

const LOGIN_BODY = JSON.stringify({ email: "writer@example.test", password: "correct-horse-battery" });

test("a successful login sets both HttpOnly cookies and never returns a token", async () => {
  const stub = stubFetch({ "api/v1/auth/login": () => tokenEnvelope(TOKENS) });
  const response = await handleAuthRequest(request("/api/auth/login", { body: LOGIN_BODY }), "login", {
    apiBaseUrl: API_BASE,
    fetchImpl: stub.fetchImpl,
  });

  assert.equal(response.status, 200);
  assertNoStore(response);
  const access = findCookie(response, ACCESS_TOKEN_COOKIE);
  const refresh = findCookie(response, REFRESH_TOKEN_COOKIE);
  assert.ok(access, "the access cookie must be set");
  assert.ok(refresh, "the refresh cookie must be set");
  assert.match(access, /^nw_access=/);
  assert.match(access, /Path=\/api\/authoring/);
  assert.match(access, /HttpOnly/);
  assert.match(access, /SameSite=Lax/);
  assert.match(access, /Max-Age=\d+/);
  assert.match(refresh, /Path=\/api(;|$)/);

  const body = await response.text();
  assert.equal(body.includes(TOKENS.accessToken), false, "the access token must not reach the browser");
  assert.equal(body.includes(TOKENS.refreshToken), false, "the refresh token must not reach the browser");
  assert.match(body, /accessExpiresAt/);
});

test("a registration keeps the upstream 201 and rotates the cookie set", async () => {
  const stub = stubFetch({ "api/v1/auth/register": () => tokenEnvelope(ROTATED, 201) });
  const response = await handleAuthRequest(request("/api/auth/register", { body: LOGIN_BODY }), "register", {
    apiBaseUrl: API_BASE,
    fetchImpl: stub.fetchImpl,
  });
  assert.equal(response.status, 201);
  assert.match(findCookie(response, ACCESS_TOKEN_COOKIE) ?? "", new RegExp(`=${ROTATED.accessToken}`));
});

test("Secure follows the browser-facing scheme, not the internal hop", async () => {
  const stub = stubFetch({ "api/v1/auth/login": () => tokenEnvelope(TOKENS) });

  const overTls = await handleAuthRequest(
    request("/api/auth/login", { body: LOGIN_BODY, headers: { "x-forwarded-proto": "https" } }),
    "login",
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.match(findCookie(overTls, ACCESS_TOKEN_COOKIE) ?? "", /; Secure/);

  const plain = await handleAuthRequest(
    request("/api/auth/login", { body: LOGIN_BODY, headers: { "x-forwarded-proto": "http" } }),
    "login",
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.doesNotMatch(
    findCookie(plain, ACCESS_TOKEN_COOKIE) ?? "",
    /; Secure/,
    "a plain-HTTP browser would silently drop a Secure cookie",
  );
});

test("mutations require an exact same-origin Origin and never reach the API otherwise", async () => {
  const stub = stubFetch({ "api/v1/auth/login": () => tokenEnvelope(TOKENS) });

  // An empty value means "no Origin header", which a browser sends for some
  // same-origin navigations but never for a legitimate cross-site mutation.
  for (const origin of ["", "https://attacker.test", "https://no-wave.test.evil", "https://no-wave.test/path"]) {
    const headers: Record<string, string> = { host: "no-wave.test", origin };
    const response = await handleAuthRequest(
      request("/api/auth/login", { body: LOGIN_BODY, headers }),
      "login",
      { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
    );
    assert.equal(response.status, 403, `origin ${origin} must be rejected`);
    assert.match(await response.text(), /ORIGIN_REJECTED/);
    assertNoStore(response);
  }
  assert.equal(stub.calls.length, 0, "a rejected origin must not call the identity service");
});

test("the request body is JSON-only and bounded", async () => {
  const stub = stubFetch({ "api/v1/auth/login": () => tokenEnvelope(TOKENS) });
  const cases: Array<{ init: Parameters<typeof request>[1]; status: number; code: string }> = [
    { init: { body: LOGIN_BODY, headers: { "content-type": "application/x-www-form-urlencoded" } }, status: 415, code: "UNSUPPORTED_MEDIA_TYPE" },
    { init: { body: LOGIN_BODY, headers: { "content-length": "999999" } }, status: 413, code: "PAYLOAD_TOO_LARGE" },
    { init: { body: "{not json" }, status: 400, code: "BAD_USER_INPUT" },
    { init: { body: "[]" }, status: 400, code: "BAD_USER_INPUT" },
    { init: { body: JSON.stringify({ blob: "x".repeat(5000) }) }, status: 413, code: "PAYLOAD_TOO_LARGE" },
  ];

  for (const testCase of cases) {
    const response = await handleAuthRequest(request("/api/auth/login", testCase.init), "login", {
      apiBaseUrl: API_BASE,
      fetchImpl: stub.fetchImpl,
    });
    assert.equal(response.status, testCase.status);
    assert.match(await response.text(), new RegExp(testCase.code));
    assertNoStore(response);
  }
  assert.equal(stub.calls.length, 0, "an invalid body must not be forwarded");
});

test("an unknown action is a 404 rather than an API call", async () => {
  const stub = stubFetch({});
  for (const action of ["../admin", "", "delete"]) {
    const response = await handleAuthRequest(request("/api/auth/x"), action, {
      apiBaseUrl: API_BASE,
      fetchImpl: stub.fetchImpl,
    });
    assert.equal(response.status, 404);
  }
  assert.equal(stub.calls.length, 0);
});

test("a missing API origin is reported explicitly and still clears a logout", async () => {
  const login = await handleAuthRequest(request("/api/auth/login", { body: LOGIN_BODY }), "login", {});
  assert.equal(login.status, 503);
  assert.match(await login.text(), /SERVICE_UNAVAILABLE/);

  const logout = await handleAuthRequest(
    request("/api/auth/logout", { headers: { cookie: `nw_refresh=${TOKENS.refreshToken}` } }),
    "logout",
    {},
  );
  assert.equal(logout.status, 503);
  assert.equal(setCookies(logout).length, 2, "logout must clear cookies even when the API is not configured");
});

test("an unreachable API is a 502 and a crashing logout still clears cookies", async () => {
  const failing = async (): Promise<Response> => {
    throw new Error("ECONNREFUSED");
  };
  const login = await handleAuthRequest(request("/api/auth/login", { body: LOGIN_BODY }), "login", {
    apiBaseUrl: API_BASE,
    fetchImpl: failing,
  });
  assert.equal(login.status, 502);
  assert.match(await login.text(), /could not be reached/);

  const logout = await handleAuthRequest(
    request("/api/auth/logout", { headers: { cookie: `nw_refresh=${TOKENS.refreshToken}` } }),
    "logout",
    { apiBaseUrl: API_BASE, fetchImpl: failing },
  );
  assert.equal(logout.status, 502);
  assert.equal(setCookies(logout).length, 2);
});

test("upstream errors are passed through with a sanitized body", async () => {
  const rejected = stubFetch({
    "api/v1/auth/login": () => json({ error: { code: "INVALID_CREDENTIALS", message: "邮箱或密码不正确。" } }, 401),
  });
  const unauthorized = await handleAuthRequest(request("/api/auth/login", { body: LOGIN_BODY }), "login", {
    apiBaseUrl: API_BASE,
    fetchImpl: rejected.fetchImpl,
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(setCookies(unauthorized).length, 0, "a failed login must not set cookies");
  assert.match(await unauthorized.text(), /INVALID_CREDENTIALS/);

  // An internal error body must not leak to the browser.
  const crashing = stubFetch({
    "api/v1/auth/login": () => json({ error: { code: "PG_PASSWORD_IN_SQL", message: "connection string postgres://u:p@h/db" } }, 500),
  });
  const failed = await handleAuthRequest(request("/api/auth/login", { body: LOGIN_BODY }), "login", {
    apiBaseUrl: API_BASE,
    fetchImpl: crashing.fetchImpl,
  });
  assert.equal(failed.status, 500);
  const failedBody = await failed.text();
  assert.match(failedBody, /SERVICE_UNAVAILABLE/);
  assert.equal(failedBody.includes("postgres://"), false, "upstream internals must not be forwarded");
});

test("a 200 without a valid token envelope is rejected instead of half-authenticating", async () => {
  const stub = stubFetch({ "api/v1/auth/login": () => json({ data: { accessToken: "short" } }) });
  const response = await handleAuthRequest(request("/api/auth/login", { body: LOGIN_BODY }), "login", {
    apiBaseUrl: API_BASE,
    fetchImpl: stub.fetchImpl,
  });
  assert.equal(response.status, 502);
  assert.match(await response.text(), /INVALID_AUTH_RESPONSE/);
  assert.equal(setCookies(response).length, 0);
});

test("refresh without a cookie is a 401, with a cookie it rotates both tokens", async () => {
  const stub = stubFetch({ "api/v1/auth/refresh": () => tokenEnvelope(ROTATED) });

  const anonymous = await handleAuthRequest(request("/api/auth/refresh"), "refresh", {
    apiBaseUrl: API_BASE,
    fetchImpl: stub.fetchImpl,
  });
  assert.equal(anonymous.status, 401);
  assert.equal(stub.calls.length, 0);

  const refreshed = await handleAuthRequest(
    request("/api/auth/refresh", { headers: { cookie: `nw_refresh=${TOKENS.refreshToken}` } }),
    "refresh",
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.equal(refreshed.status, 200);
  assert.equal(stub.calls.length, 1);
  assert.deepEqual(JSON.parse(String(stub.calls[0]?.init?.body)), { refreshToken: TOKENS.refreshToken });
  assert.match(findCookie(refreshed, ACCESS_TOKEN_COOKIE) ?? "", new RegExp(`=${ROTATED.accessToken}`));
  assert.match(findCookie(refreshed, REFRESH_TOKEN_COOKIE) ?? "", new RegExp(`=${ROTATED.refreshToken}`));
});

test("logout is idempotent and clears cookies with or without a session", async () => {
  const stub = stubFetch({
    "api/v1/auth/logout": () => new Response(null, { status: 401 }),
  });

  const withoutSession = await handleAuthRequest(request("/api/auth/logout"), "logout", {
    apiBaseUrl: API_BASE,
    fetchImpl: stub.fetchImpl,
  });
  assert.equal(withoutSession.status, 200);
  assert.equal(stub.calls.length, 0, "a session-less logout must not call the API");
  const cleared = setCookies(withoutSession);
  assert.equal(cleared.length, 2);
  assert.ok(cleared.every((cookie) => /Max-Age=0/.test(cookie)));

  // A rejected refresh token during logout is still a successful logout.
  const rejected = await handleAuthRequest(
    request("/api/auth/logout", { headers: { cookie: `nw_refresh=${TOKENS.refreshToken}` } }),
    "logout",
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.equal(rejected.status, 200);
  assert.equal(setCookies(rejected).length, 2);
  assert.deepEqual(JSON.parse(String(stub.calls[0]?.init?.body)), { refreshToken: TOKENS.refreshToken });
});
