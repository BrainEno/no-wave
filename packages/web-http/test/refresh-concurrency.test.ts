import assert from "node:assert/strict";
import test from "node:test";
import { forwardAuthoringRequest } from "../src/forward.ts";
import { InMemoryRefreshCoordinator } from "../src/refresh-coordinator.ts";
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE, SESSION_MARKER_COOKIE } from "../src/policy.ts";
import { API_BASE, ROTATED, TOKENS, findCookie, json, request, setCookies, stubFetch, tokenEnvelope, type StubFetch } from "./helpers.ts";

const sessionCookie = `nw_access=${TOKENS.accessToken}; nw_refresh=${TOKENS.refreshToken}`;

/**
 * The #183 race, made deterministic.
 *
 * Requests reach the API with the same stale credentials. Their 401s are held
 * behind a gate until the expected number has arrived, and the refresh response
 * is held until the rotation has been started, so no scheduling luck is
 * involved: either the proxy presents the old refresh token once, or it
 * presents it N times and the identity layer would revoke the session family.
 */
function race(staleRequests: number, refreshResponse: Response): {
  stub: StubFetch;
  started: Promise<void>;
  finishRefresh: () => void;
  refreshCalls: () => number;
} {
  let refreshCalls = 0;
  let staleResourceCalls = 0;
  let releaseAll401s: () => void = () => {};
  let notifyRefreshStarted: () => void = () => {};
  let releaseRefresh: (response: Response) => void = () => {};

  const all401s = new Promise<void>((resolve) => { releaseAll401s = resolve; });
  const started = new Promise<void>((resolve) => { notifyRefreshStarted = resolve; });
  const refreshResult = new Promise<Response>((resolve) => { releaseRefresh = resolve; });

  const stub = stubFetch({
    "api/v1/auth/refresh": () => {
      refreshCalls += 1;
      notifyRefreshStarted();
      return refreshResult;
    },
    "api/v1/notifications": (call) => {
      const auth = new Headers(call.init?.headers).get("authorization");
      if (auth === `Bearer ${ROTATED.accessToken}`) return json({ data: { ok: true } });
      staleResourceCalls += 1;
      if (staleResourceCalls === staleRequests) releaseAll401s();
      return all401s.then(() => json({ error: { code: "TOKEN_EXPIRED" } }, 401));
    },
  });
  return {
    stub,
    started,
    finishRefresh: () => releaseRefresh(refreshResponse),
    refreshCalls: () => refreshCalls,
  };
}

function dispatch(stub: StubFetch, cookie = sessionCookie, coordinator?: InMemoryRefreshCoordinator): Promise<Response> {
  return forwardAuthoringRequest(
    request("/api/authoring/notifications", { method: "GET", headers: { cookie } }),
    "api/v1/notifications",
    "GET",
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl, ...(coordinator ? { refreshCoordinator: coordinator } : {}) },
  );
}

test("parallel 401s share exactly one refresh and all finish on the rotated session", async () => {
  const r = race(3, tokenEnvelope(ROTATED));
  const pending = [dispatch(r.stub), dispatch(r.stub), dispatch(r.stub)];
  await r.started;
  r.finishRefresh();
  const responses = await Promise.all(pending);

  assert.equal(r.refreshCalls(), 1, "the old refresh token must be presented to the API only once");
  assert.equal(r.stub.calls.filter((call) => call.url.includes("/auth/refresh")).length, 1);
  for (const response of responses) {
    assert.equal(response.status, 200, "every concurrent request must continue on the new session");
    assert.match(await response.text(), /ok/);
    assert.match(findCookie(response, ACCESS_TOKEN_COOKIE) ?? "", new RegExp(`=${ROTATED.accessToken}`));
    assert.match(findCookie(response, REFRESH_TOKEN_COOKIE) ?? "", new RegExp(`=${ROTATED.refreshToken}`));
    assert.ok(findCookie(response, SESSION_MARKER_COOKIE), "each response renews the page's session marker");
  }
});

test("a request that arrives after the rotation settled still joins the winner", async () => {
  const r = race(3, tokenEnvelope(ROTATED));
  const pending = [dispatch(r.stub), dispatch(r.stub), dispatch(r.stub)];
  await r.started;
  r.finishRefresh();
  assert.ok((await Promise.all(pending)).every((response) => response.status === 200));

  // Still carrying the old cookie: its 401 comes after the winner's refresh has
  // resolved but before any Set-Cookie could have reached a real browser.
  const late = await dispatch(r.stub);
  assert.equal(late.status, 200);
  assert.equal(r.refreshCalls(), 1, "the late sibling must not submit the consumed token again");
  assert.match(findCookie(late, ACCESS_TOKEN_COOKIE) ?? "", new RegExp(`=${ROTATED.accessToken}`));
});

test("a rejected refresh is shared: every waiter clears the session, once", async () => {
  const r = race(3, json({ error: { code: "INVALID_REFRESH_TOKEN", message: "rejected" } }, 401));
  const pending = [dispatch(r.stub), dispatch(r.stub), dispatch(r.stub)];
  await r.started;
  r.finishRefresh();
  const responses = await Promise.all(pending);

  assert.equal(r.refreshCalls(), 1);
  for (const response of responses) {
    assert.equal(response.status, 401);
    const cleared = setCookies(response);
    assert.equal(cleared.length, 3);
    assert.ok(cleared.every((cookie) => /Max-Age=0/.test(cookie)));
  }
});

test("a transient refresh failure is shared: no waiter clears the session", async () => {
  const r = race(2, json({ error: { code: "SERVICE_UNAVAILABLE", message: "down" } }, 503));
  const pending = [dispatch(r.stub), dispatch(r.stub)];
  await r.started;
  r.finishRefresh();
  const responses = await Promise.all(pending);

  assert.equal(r.refreshCalls(), 1);
  for (const response of responses) {
    assert.equal(response.status, 401);
    assert.equal(setCookies(response).length, 0, "a 5xx proves nothing about the session");
  }
});

test("sessions with different refresh tokens never share a rotation", async () => {
  const otherCookie = `nw_access=${TOKENS.accessToken}; nw_refresh=${"t".repeat(43)}`;
  const stub = stubFetch({
    "api/v1/auth/refresh": () => tokenEnvelope(ROTATED),
    "api/v1/notifications": (call) => {
      const auth = new Headers(call.init?.headers).get("authorization");
      return auth === `Bearer ${ROTATED.accessToken}`
        ? json({ data: { ok: true } })
        : json({ error: { code: "TOKEN_EXPIRED" } }, 401);
    },
  });
  // One coordinator for both: only the digest of the stale credentials may
  // keep their rotations apart.
  const coordinator = new InMemoryRefreshCoordinator();
  const responses = await Promise.all([
    dispatch(stub, sessionCookie, coordinator),
    dispatch(stub, otherCookie, coordinator),
  ]);
  assert.ok(responses.every((response) => response.status === 200));
  assert.equal(stub.calls.filter((call) => call.url.includes("/auth/refresh")).length, 2);
});

test("the reuse window is bounded: a later stale request performs a new rotation", async () => {
  let clock = 1_000;
  const coordinator = new InMemoryRefreshCoordinator({ reuseMs: 1_000, now: () => clock });
  let refreshCalls = 0;
  const stub = stubFetch({
    "api/v1/auth/refresh": () => { refreshCalls += 1; return tokenEnvelope(ROTATED); },
    "api/v1/notifications": (call) => {
      const auth = new Headers(call.init?.headers).get("authorization");
      return auth === `Bearer ${ROTATED.accessToken}`
        ? json({ data: { ok: true } })
        : json({ error: { code: "TOKEN_EXPIRED" } }, 401);
    },
  });

  assert.equal((await dispatch(stub, sessionCookie, coordinator)).status, 200);
  assert.equal(refreshCalls, 1);
  clock += 2_000;
  assert.equal((await dispatch(stub, sessionCookie, coordinator)).status, 200);
  assert.equal(refreshCalls, 2, "the ledger must not turn a replay into an endless grace window");
});

test("two isolated Web processes each rotate without a shared coordinator", async () => {
  // ADR 0025 §3 is a deployment contract, not a best-effort guess. This pins
  // the boundary a shared coordinator has to replace: two in-memory ledgers are
  // two processes, and neither can see the other's rotation. A multi-instance
  // deployment must use sticky routing or inject a shared implementation.
  const r = race(2, tokenEnvelope(ROTATED));
  const pending = [
    dispatch(r.stub, sessionCookie, new InMemoryRefreshCoordinator()),
    dispatch(r.stub, sessionCookie, new InMemoryRefreshCoordinator()),
  ];
  await r.started;
  r.finishRefresh();
  const responses = await Promise.all(pending);
  assert.ok(responses.every((response) => response.status === 200));
  assert.equal(r.refreshCalls(), 2, "the shipped coordinator is process-scoped by design");
});
