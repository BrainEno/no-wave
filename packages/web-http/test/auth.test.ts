import assert from "node:assert/strict";
import test from "node:test";
import { handleAuthRequest, IDENTITY_ACTIONS } from "../src/auth.ts";
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

/**
 * Recovery and verification (ADR 0014) share the route family but not the
 * session machinery. These tests exist because the failure mode of getting that
 * split wrong is not an error page — it is either a 502 on every recovery
 * request (envelope check) or a browser that stays signed in with a session the
 * API just revoked (missing cookie clear).
 */

const OK_BODY = { data: { ok: true } };

/** `init.headers` is a `Headers` in some handlers and a plain object in others. */
function headerOf(call: { init?: RequestInit } | undefined, name: string): string | null {
  const headers = call?.init?.headers as Headers | Record<string, string> | undefined;
  if (!headers) return null;
  return typeof (headers as Headers).get === "function"
    ? (headers as Headers).get(name)
    : (headers as Record<string, string>)[name] ?? null;
}

function identityRequest(action: string, body: string, headers: Record<string, string> = {}): Request {
  return request(`/api/auth/${action}`, {
    method: "POST",
    body,
    headers: { host: "no-wave.test", origin: "https://no-wave.test", ...headers },
  });
}

test("recovery and verification forward the body and answer without touching the session", async () => {
  for (const action of IDENTITY_ACTIONS) {
    const stub = stubFetch({ [`api/v1/auth/${action}`]: () => json(OK_BODY, action === "forgot-password" ? 202 : 200) });
    const body = JSON.stringify({ token: "abc", password: "a-long-enough-password", email: "writer@example.test" });
    const response = await handleAuthRequest(identityRequest(action, body), action, {
      apiBaseUrl: API_BASE,
      fetchImpl: stub.fetchImpl,
    });

    assert.equal(response.status, action === "forgot-password" ? 202 : 200, `${action} must keep the upstream status`);
    assertNoStore(response);
    assert.deepEqual(await response.json(), OK_BODY);
    assert.equal(stub.calls.length, 1, `${action} must reach the API exactly once`);
    assert.equal(stub.calls[0]?.url, `${API_BASE}/api/v1/auth/${action}`);
    assert.equal(headerOf(stub.calls[0], "content-type"), "application/json; charset=utf-8");
    // `reset-password` is the exception and has its own test: a successful
    // reset revokes the account's sessions, so it clears the cookies.
    if (action !== "reset-password") {
      assert.equal(setCookies(response).length, 0, `${action} carries no token, so it must not write one`);
    }
  }
});

test("a successful password reset clears the session cookies, because the API revoked every session", async () => {
  const stub = stubFetch({ "api/v1/auth/reset-password": () => json(OK_BODY, 200) });
  const response = await handleAuthRequest(
    identityRequest("reset-password", JSON.stringify({ token: "t", password: "a-long-enough-password" }), {
      cookie: `${ACCESS_TOKEN_COOKIE}=${TOKENS.accessToken}; ${REFRESH_TOKEN_COOKIE}=${TOKENS.refreshToken}`,
    }),
    "reset-password",
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );

  assert.equal(response.status, 200);
  const access = findCookie(response, ACCESS_TOKEN_COOKIE);
  const refresh = findCookie(response, REFRESH_TOKEN_COOKIE);
  assert.ok(access && refresh, "both cookies must be cleared, not just the access token");
  assert.match(access, /Max-Age=0/);
  assert.match(refresh, /Max-Age=0/);
  assert.equal(await response.clone().text().then((text) => text.includes(TOKENS.refreshToken)), false);
});

test("a rejected password reset leaves the visitor's cookies alone", async () => {
  // A 401 means the link was spent or expired — the account was not recovered,
  // so nothing was revoked and clearing cookies would sign out a bystander.
  for (const status of [400, 401, 429]) {
    const stub = stubFetch({
      "api/v1/auth/reset-password": () => json({ error: { code: "AUTHENTICATION_FAILED", message: "nope" } }, status),
    });
    const response = await handleAuthRequest(
      identityRequest("reset-password", JSON.stringify({ token: "t", password: "a-long-enough-password" }), {
        cookie: `${ACCESS_TOKEN_COOKIE}=${TOKENS.accessToken}`,
      }),
      "reset-password",
      { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
    );
    assert.equal(response.status, status, `status ${status} must pass through`);
    assert.equal(setCookies(response).length, 0, `status ${status} must not clear cookies`);
  }
});

test("recovery and verification keep the origin check and the bounded body", async () => {
  const stub = stubFetch({ "api/v1/auth/": () => json(OK_BODY, 202) });

  const crossOrigin = await handleAuthRequest(
    identityRequest("forgot-password", JSON.stringify({ email: "writer@example.test" }), { origin: "https://evil.test" }),
    "forgot-password",
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.equal(crossOrigin.status, 403);

  const oversized = await handleAuthRequest(
    identityRequest("reset-password", JSON.stringify({ token: "x".repeat(9000), password: "a-long-enough-password" })),
    "reset-password",
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.equal(oversized.status, 413);

  assert.equal(stub.calls.length, 0, "neither request may reach the API");
});

test("recovery failures are sanitized: a rate limit keeps its message, a 5xx keeps nothing", async () => {
  const throttled = stubFetch({
    "api/v1/auth/forgot-password": () => json({ error: { code: "RATE_LIMITED", message: "请稍后再试。" } }, 429),
  });
  const limited = await handleAuthRequest(
    identityRequest("forgot-password", JSON.stringify({ email: "writer@example.test" })),
    "forgot-password",
    { apiBaseUrl: API_BASE, fetchImpl: throttled.fetchImpl },
  );
  assert.equal(limited.status, 429);
  assert.match(await limited.text(), /请稍后再试。/);

  const broken = stubFetch({
    "api/v1/auth/verify-email": () => json({ error: { code: "INTERNAL", message: "connection string: postgres://…" } }, 500),
  });
  const failed = await handleAuthRequest(identityRequest("verify-email", JSON.stringify({ token: "abc" })), "verify-email", {
    apiBaseUrl: API_BASE,
    fetchImpl: broken.fetchImpl,
  });
  assert.equal(failed.status, 500);
  const text = await failed.text();
  assert.match(text, /SERVICE_UNAVAILABLE/);
  assert.equal(text.includes("postgres://"), false, "an upstream secret must not reach the browser");
});

test("a recovery answer without a data object is a proxy error, not a half-success", async () => {
  const stub = stubFetch({ "api/v1/auth/verify-email": () => json({ ok: true }, 200) });
  const response = await handleAuthRequest(identityRequest("verify-email", JSON.stringify({ token: "abc" })), "verify-email", {
    apiBaseUrl: API_BASE,
    fetchImpl: stub.fetchImpl,
  });
  assert.equal(response.status, 502);
  assert.match(await response.text(), /INVALID_AUTH_RESPONSE/);
});
