import assert from "node:assert/strict";
import test from "node:test";
import { handleAuthRequest } from "../src/auth.ts";
import { clearedTokenCookieHeaders, hasUsableSession, sessionMarkerFrom, tokenCookieHeaders } from "../src/cookies.ts";
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE, SESSION_MARKER_COOKIE } from "../src/policy.ts";
import { API_BASE, TOKENS, findCookie, request, setCookies, stubFetch, tokenEnvelope } from "./helpers.ts";

const LOGIN_BODY = JSON.stringify({ email: "writer@example.test", password: "correct-horse-battery" });

/**
 * The session marker.
 *
 * These tests exist because the marker is the one cookie a page render can see,
 * which makes it the one cookie that could accidentally start carrying
 * authority. Every assertion here is either "it is visible to pages" or "it
 * still says nothing about who you are".
 */
test("the session marker is the only cookie a page route can see", async () => {
  const stub = stubFetch({ "api/v1/auth/login": () => tokenEnvelope(TOKENS) });
  const response = await handleAuthRequest(request("/api/auth/login", { body: LOGIN_BODY }), "login", {
    apiBaseUrl: API_BASE,
    fetchImpl: stub.fetchImpl,
  });

  const marker = findCookie(response, SESSION_MARKER_COOKIE);
  assert.ok(marker, "the marker must be set alongside the tokens");
  assert.match(marker, /Path=\//, "a page render can only read a cookie scoped to /");
  assert.match(marker, /HttpOnly/);
  assert.match(marker, /SameSite=Lax/);

  // The tokens stay where they were: widening either of them to `/` would put a
  // credential on every page request and every static asset fetch.
  assert.match(findCookie(response, ACCESS_TOKEN_COOKIE) ?? "", /Path=\/api\/authoring/);
  assert.match(findCookie(response, REFRESH_TOKEN_COOKIE) ?? "", /Path=\/api(;|$)/);
});

test("the marker carries an expiry, not a credential", async () => {
  const stub = stubFetch({ "api/v1/auth/login": () => tokenEnvelope(TOKENS) });
  const response = await handleAuthRequest(request("/api/auth/login", { body: LOGIN_BODY }), "login", {
    apiBaseUrl: API_BASE,
    fetchImpl: stub.fetchImpl,
  });

  const marker = findCookie(response, SESSION_MARKER_COOKIE) ?? "";
  const value = marker.slice(SESSION_MARKER_COOKIE.length + 1, marker.indexOf(";"));
  assert.match(value, /^\d{1,15}$/, "the marker is unix seconds, so nothing else can hide in it");

  const expected = Math.floor(Date.parse(TOKENS.refreshExpiresAt) / 1000);
  assert.equal(Number(value), expected, "the marker expires exactly when the session can no longer be renewed");
  assert.equal(marker.includes(TOKENS.accessToken), false);
  assert.equal(marker.includes(TOKENS.refreshToken), false);
});

test("logout clears the marker, so a private page cannot outlive the session", async () => {
  const stub = stubFetch({ "api/v1/auth/logout": () => tokenEnvelope(TOKENS) });
  const response = await handleAuthRequest(
    request("/api/auth/logout", { headers: { cookie: `nw_refresh=${TOKENS.refreshToken}` } }),
    "logout",
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );

  const marker = findCookie(response, SESSION_MARKER_COOKIE);
  assert.ok(marker, "the marker must be cleared with the tokens");
  assert.match(marker, /^nw_session=;/);
  assert.match(marker, /Max-Age=0/);
});

test("the marker is readable from a request and usable only while it is current", () => {
  const now = Date.now();
  const future = Math.floor((now + 60 * 60 * 1000) / 1000);
  const past = Math.floor((now - 1000) / 1000);

  const requestWith = (cookie: string): Request =>
    new Request("https://no-wave.test/account", { headers: { cookie } });

  assert.equal(sessionMarkerFrom(requestWith(`nw_session=${future}`)), String(future));
  assert.equal(hasUsableSession(sessionMarkerFrom(requestWith(`nw_session=${future}`)), now), true);
  assert.equal(hasUsableSession(sessionMarkerFrom(requestWith(`nw_session=${past}`)), now), false,
    "an expired marker is a signed-out visitor");
  assert.equal(hasUsableSession(sessionMarkerFrom(requestWith("nw_access=leaked-token"))), false,
    "no cookie but the marker decides anything");
  assert.equal(hasUsableSession(undefined), false);

  // Anything forged or unparseable counts as signed out rather than signed in.
  for (const value of ["", "soon", "-1", `${future}.5`, "99999999999999999999", "0x10"]) {
    assert.equal(hasUsableSession(value, now), false, `${JSON.stringify(value)} must not open a private page`);
  }
});

test("the marker outlives neither the tokens nor the browser's cookie jar", () => {
  const request = new Request("https://no-wave.test/api/auth/login", { headers: { origin: "https://no-wave.test" } });
  const now = Date.now();
  const headers = tokenCookieHeaders(request, TOKENS, now);

  const marker = headers.find((cookie) => cookie.startsWith(`${SESSION_MARKER_COOKIE}=`)) ?? "";
  const refresh = headers.find((cookie) => cookie.startsWith(`${REFRESH_TOKEN_COOKIE}=`)) ?? "";
  const maxAgeOf = (cookie: string): number => Number(/Max-Age=(\d+)/.exec(cookie)?.[1] ?? -1);
  assert.equal(maxAgeOf(marker), maxAgeOf(refresh), "the marker must expire with the refresh token, not before or after");

  const cleared = clearedTokenCookieHeaders(request);
  assert.equal(cleared.length, 3);
  assert.ok(cleared.every((cookie) => /Max-Age=0/.test(cookie)));
  assert.ok(cleared.some((cookie) => cookie.startsWith(`${SESSION_MARKER_COOKIE}=`)));

  // Rotation keeps the marker in step: a renewed session renews the page's view
  // of it, so a private page does not redirect mid-session.
  const rotated = tokenCookieHeaders(request, { ...TOKENS, refreshExpiresAt: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString() }, now);
  const rotatedMarker = rotated.find((cookie) => cookie.startsWith(`${SESSION_MARKER_COOKIE}=`)) ?? "";
  assert.ok(maxAgeOf(rotatedMarker) > maxAgeOf(marker));
});

test("the marker is never more generous than the token it describes", () => {
  const request = new Request("https://no-wave.test/api/auth/login", { headers: { origin: "https://no-wave.test" } });
  const now = Date.now();
  const maxAgeOf = (cookie: string): number => Number(/Max-Age=(\d+)/.exec(cookie)?.[1] ?? -1);
  const markerOf = (headers: string[]): string => headers.find((cookie) => cookie.startsWith(`${SESSION_MARKER_COOKIE}=`)) ?? "";

  // An expiry the cookie jar cannot read collapses both cookies to zero rather
  // than inventing a lifetime. It cannot happen through the proxy — the token
  // envelope check rejects an unparseable `refreshExpiresAt` — so this is the
  // last line, not the first.
  const malformed = tokenCookieHeaders(request, { ...TOKENS, refreshExpiresAt: "not-a-date" }, now);
  assert.equal(maxAgeOf(markerOf(malformed)), maxAgeOf(malformed.find((c) => c.startsWith(`${REFRESH_TOKEN_COOKIE}=`)) ?? ""));
  assert.equal(maxAgeOf(markerOf(malformed)), 0);
  assert.equal(Number(markerOf(malformed).slice(SESSION_MARKER_COOKIE.length + 1, markerOf(malformed).indexOf(";"))), 0);

  // And a refresh token near its ceiling is not extended by the marker:
  // `tokenMaxAge` caps at 30 days, so both cookies agree there too.
  const longLived = tokenCookieHeaders(request, { ...TOKENS, refreshExpiresAt: new Date(now + 365 * 24 * 60 * 60 * 1000).toISOString() }, now);
  assert.equal(maxAgeOf(markerOf(longLived)), maxAgeOf(longLived.find((c) => c.startsWith(`${REFRESH_TOKEN_COOKIE}=`)) ?? ""));
  assert.equal(maxAgeOf(markerOf(longLived)), 30 * 24 * 60 * 60);

  const written = new Response(null);
  for (const cookie of tokenCookieHeaders(request, TOKENS, now)) written.headers.append("set-cookie", cookie);
  assert.equal(setCookies(written).length, 3);
});
