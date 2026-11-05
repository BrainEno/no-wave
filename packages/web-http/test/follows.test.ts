import assert from "node:assert/strict";
import test from "node:test";

import {
  FOLLOW_TARGET_MAX_LENGTH,
  handleAuthorProfileRequest,
  handleUserFollowRequest,
  isFollowTargetId,
  followRequestPath,
} from "../src/follows.ts";
import { ACCESS_TOKEN_COOKIE } from "../src/policy.ts";
import { API_BASE, TOKENS, assertNoStore, json, request, stubFetch } from "./helpers.ts";

/**
 * Follow proxy contract (#198).
 *
 * The API models following as a relationship — `POST` creates it, `DELETE`
 * removes it — and `docs/architecture/rest-idempotency.md` records both as
 * convergent. These tests hold the proxy to speaking that same language rather
 * than flattening it into something the API does not implement.
 *
 * The interesting cases are the ones where a proxy can quietly add behaviour:
 * turning the verb into a body, deciding for itself who may follow whom, or
 * answering "did the id you guessed exist" to a cross-origin caller.
 */

const TARGET = "2f1c6f0e-0b1a-4f2e-9c3d-5a7b8c9d0e1f";

function followUpstream(
  body: unknown = { data: { userId: TARGET, followerCount: 4, isFollowing: true } },
  status = 200,
) {
  const stub = stubFetch({ "api/v1/users/": () => json(body, status) });
  return { calls: stub.calls, config: { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl } };
}

function followRequest(
  method: string,
  target = TARGET,
  options: { locale?: string | null; headers?: Record<string, string>; cookie?: string } = {},
): Request {
  const locale = options.locale === undefined ? "zh-CN" : options.locale;
  const query = locale === null ? "" : `?locale=${encodeURIComponent(locale)}`;
  const headers: Record<string, string> = {
    origin: "https://no-wave.test",
    ...options.headers,
  };
  if (options.cookie) headers.cookie = options.cookie;
  return request(`/api/users/${encodeURIComponent(target)}/follow${query}`, { method, headers });
}

test("POST follows and DELETE unfollows, both against the same upstream path", async () => {
  for (const method of ["POST", "DELETE"]) {
    const { config, calls } = followUpstream();
    const response = await handleUserFollowRequest(followRequest(method), { targetUserId: TARGET, locale: "zh-CN" }, config);
    assert.equal(response.status, 200, method);
    assertNoStore(response);
    assert.equal(calls.length, 1, `${method} must make exactly one upstream call`);
    assert.equal(calls[0].init?.method, method, "the verb is the state — it must survive the proxy");
    assert.ok(calls[0].url.includes(`/api/v1/users/${TARGET}/follow`), calls[0].url);
    assert.ok(calls[0].url.includes("locale=zh-CN"), "the API requires a locale on every verb");
  }
});

test("the follow carries no body", async () => {
  // A body here would suggest the payload means something. It does not: the verb
  // is the whole request, and inventing `{following: true}` would create a
  // second definition of the operation for the API to disagree with.
  const { config, calls } = followUpstream();
  await handleUserFollowRequest(followRequest("POST"), { targetUserId: TARGET, locale: "zh-CN" }, config);
  assert.equal(calls[0].init?.body, undefined);
  assert.equal(new Headers(calls[0].init?.headers).get("content-type"), null, "no body, no content-type");
});

test("there is no GET: the read lives on the author profile", async () => {
  // `GET /users/:id/follow` answers 405 at the API, and the viewer's own follow
  // state arrives on `GET /authors/:userId` as `isFollowing`. A proxy that
  // invented the read would hold a second answer to a question that already has
  // one — and the two would eventually disagree.
  const { config, calls } = followUpstream();
  const response = await handleUserFollowRequest(followRequest("GET"), { targetUserId: TARGET, locale: "zh-CN" }, config);
  assert.equal(response.status, 405);
  assert.equal(calls.length, 0, "an unsupported method must not reach the API");
});

test("a session cookie becomes a bearer token, and the cookie itself stays home", async () => {
  const { config, calls } = followUpstream();
  const cookie = `${ACCESS_TOKEN_COOKIE}=${TOKENS.accessToken}`;
  const response = await handleUserFollowRequest(
    followRequest("POST", TARGET, { cookie }),
    { targetUserId: TARGET, locale: "zh-CN" },
    config,
  );
  assert.equal(response.status, 200);
  const forwarded = new Headers(calls[0].init?.headers);
  assert.equal(forwarded.get("authorization"), `Bearer ${TOKENS.accessToken}`);
  assert.equal(forwarded.get("cookie"), null);
});

test("a signed-out write reaches the API and its 401 comes back unchanged", async () => {
  // The proxy must not decide who may follow whom. If it pre-empted the 401 the
  // two layers would drift, and the client would get a different answer
  // depending on which one noticed first.
  const stub = stubFetch({
    "api/v1/users/": () => json({ error: { code: "UNAUTHENTICATED", message: "Authentication is required." } }, 401),
  });
  const response = await handleUserFollowRequest(
    followRequest("POST"),
    { targetUserId: TARGET, locale: "zh-CN" },
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.equal(response.status, 401);
  assert.equal(stub.calls.length, 1, "the request is forwarded so the API can be the one to refuse it");
  const forwarded = new Headers(stub.calls[0].init?.headers);
  assert.equal(forwarded.get("authorization"), null, "no session, no invented credential");
});

test("a cross-origin write is refused before the id is looked at", async () => {
  const { config, calls } = followUpstream();
  const hostile = request(`/api/users/${TARGET}/follow?locale=zh-CN`, {
    method: "POST",
    headers: { origin: "https://evil.test" },
  });
  const response = await handleUserFollowRequest(hostile, { targetUserId: TARGET, locale: "zh-CN" }, config);
  assert.equal(response.status, 403);
  const body = await response.json() as { error?: { code?: string } };
  assert.equal(body.error?.code, "ORIGIN_REJECTED");
  assert.equal(calls.length, 0, "nothing is forwarded, so nothing can be probed");
});

test("the Origin check runs before validation, so existence cannot be probed", async () => {
  // Same order as every other mutation proxy: a hostile origin gets the same
  // answer whether or not the id it guessed was well-formed.
  const { config } = followUpstream();
  const hostile = request("/api/users/not%20even%20valid/follow?locale=zh-CN", {
    method: "POST",
    headers: { origin: "https://evil.test" },
  });
  const response = await handleUserFollowRequest(hostile, { targetUserId: "not even valid", locale: "zh-CN" }, config);
  assert.equal(response.status, 403);
});

test("a target id that cannot be a path segment is refused locally", async () => {
  const { config, calls } = followUpstream();
  for (const bad of ["", " padded ", "a/b", "a\\b", "..", ".", "a".repeat(FOLLOW_TARGET_MAX_LENGTH + 1), "tab\there"]) {
    const response = await handleUserFollowRequest(
      followRequest("POST", "placeholder"),
      { targetUserId: bad, locale: "zh-CN" },
      config,
    );
    assert.equal(response.status, 400, JSON.stringify(bad));
  }
  assert.equal(calls.length, 0, "a malformed id never reaches the API");
});

test("an id that is well-formed but not a UUID is still forwarded", async () => {
  // The author page is addressed by whatever userId the API returned. Instances
  // that seeded or migrated their accounts may not have UUIDs, and the API's
  // `decodeUserId` accepts them — so refusing them here would break the button
  // on those instances while the API was willing to answer.
  const { config, calls } = followUpstream();
  const response = await handleUserFollowRequest(
    followRequest("POST", "alice-writer"),
    { targetUserId: "alice-writer", locale: "zh-CN" },
    config,
  );
  assert.equal(response.status, 200);
  assert.ok(calls[0].url.includes("/api/v1/users/alice-writer/follow"), calls[0].url);
});

test("the locale defaults on a missing query and is validated when present", async () => {
  const { config, calls } = followUpstream();
  const ok = await handleUserFollowRequest(followRequest("POST", TARGET, { locale: null }), { targetUserId: TARGET, locale: null }, config);
  assert.equal(ok.status, 200);
  assert.ok(calls[0].url.includes("locale=zh-CN"), "a missing locale means the default one");

  const bad = await handleUserFollowRequest(
    followRequest("POST", TARGET, { locale: "fr-FR" }),
    { targetUserId: TARGET, locale: "fr-FR" },
    config,
  );
  assert.equal(bad.status, 400);
  assert.equal(calls.length, 1, "an unsupported locale does not reach the API");
});

test("an upstream failure is passed through as a failure, with no caching", async () => {
  const stub = stubFetch({
    "api/v1/users/": () => json({ error: { code: "SERVICE_UNAVAILABLE", message: "try later" } }, 500),
  });
  const response = await handleUserFollowRequest(
    followRequest("POST"),
    { targetUserId: TARGET, locale: "zh-CN" },
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.equal(response.status, 500);
  assertNoStore(response);
  // NOT asserted: that the body is scrubbed. `forwardAuthoringRequest` is a
  // transparent forwarder, the same way it is for likes and comments.
});

test("an unconfigured API is a 503, not a silent success", async () => {
  const response = await handleUserFollowRequest(followRequest("POST"), { targetUserId: TARGET, locale: "zh-CN" }, {});
  assert.equal(response.status, 503);
});

test("the upstream path encodes the id it was given", async () => {
  assert.equal(followRequestPath("a b", "zh-CN"), "api/v1/users/a%20b/follow?locale=zh-CN");
  assert.equal(followRequestPath("x", "en"), "api/v1/users/x/follow?locale=en");
});

test("isFollowTargetId accepts ordinary ids and refuses transport hazards", () => {
  assert.equal(isFollowTargetId(TARGET), true);
  assert.equal(isFollowTargetId("alice-writer"), true);
  assert.equal(isFollowTargetId("a".repeat(FOLLOW_TARGET_MAX_LENGTH)), true);
  for (const bad of ["", " x", "x ", "a/b", "a\\b", "..", ".", "a".repeat(FOLLOW_TARGET_MAX_LENGTH + 1), "\n"]) {
    assert.equal(isFollowTargetId(bad), false, JSON.stringify(bad));
  }
});

test("the author profile read carries the viewer, so isFollowing can be true", async () => {
  // The author page is server-rendered without a session, so its `isFollowing`
  // is always false. The browser asks this endpoint with its own cookie; if the
  // cookie were not forwarded, a reader who follows the author would see an
  // unfollowed button forever.
  const stub = stubFetch({
    "api/v1/me": () => json({ data: { id: "reader" } }),
    "api/v1/authors/": () => json({ data: { userId: TARGET, followerCount: 4, isFollowing: true } }),
  });
  const cookie = `${ACCESS_TOKEN_COOKIE}=${TOKENS.accessToken}`;
  const response = await handleAuthorProfileRequest(
    new Request(`https://no-wave.test/api/authors/${TARGET}?locale=zh-CN`, {
      headers: { host: "no-wave.test", cookie },
    }),
    { userId: TARGET, locale: "zh-CN" },
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.equal(response.status, 200);
  const body = await response.json() as { data?: { isFollowing?: unknown } };
  assert.equal(body.data?.isFollowing, true);
  assert.equal(stub.calls.length, 2);
  for (const call of stub.calls) {
    const forwarded = new Headers(call.init?.headers);
    assert.equal(forwarded.get("authorization"), `Bearer ${TOKENS.accessToken}`);
    assert.equal(forwarded.get("cookie"), null);
  }
});

test("the author profile read is public and works signed out", async () => {
  const stub = stubFetch({
    "api/v1/authors/": () => json({ data: { userId: TARGET, followerCount: 4, isFollowing: false } }),
  });
  const response = await handleAuthorProfileRequest(
    new Request(`https://no-wave.test/api/authors/${TARGET}?locale=zh-CN`, { headers: { host: "no-wave.test" } }),
    { userId: TARGET, locale: "zh-CN" },
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.equal(response.status, 200);
  assert.equal(new Headers(stub.calls[0].init?.headers).get("authorization"), null);
});

test("the author profile read refuses a write verb", async () => {
  const { config, calls } = followUpstream();
  const response = await handleAuthorProfileRequest(
    request(`/api/authors/${TARGET}?locale=zh-CN`, { method: "POST" }),
    { userId: TARGET, locale: "zh-CN" },
    config,
  );
  assert.equal(response.status, 405);
  assert.equal(calls.length, 0);
});

test("the author profile read validates the id before forwarding", async () => {
  const { config, calls } = followUpstream();
  const response = await handleAuthorProfileRequest(
    new Request("https://no-wave.test/api/authors/a%2Fb?locale=zh-CN", { headers: { host: "no-wave.test" } }),
    { userId: "a/b", locale: "zh-CN" },
    config,
  );
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

test("follow writes use the trusted TLS-terminating proxy origin without accepting a downgrade", async () => {
  for (const [origin, expected] of [
    ["https://preview.example", 200],
    ["http://preview.example", 403],
    ["https://evil.example", 403],
  ] as const) {
    const { config, calls } = followUpstream();
    const response = await handleUserFollowRequest(
      new Request(`http://127.0.0.1:3100/api/authoring/users/${TARGET}/follow`, {
        method: "POST", headers: { host: "preview.example", origin, "x-forwarded-proto": "https" },
      }), { targetUserId: TARGET }, config,
    );
    assert.equal(response.status, expected, origin);
    assert.equal(calls.length, expected === 200 ? 1 : 0);
  }
});
