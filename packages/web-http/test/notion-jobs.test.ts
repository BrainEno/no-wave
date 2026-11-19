import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { handleNotionJobsRequest, handleNotionJobRequest } from "../src/notion-jobs.ts";
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from "../src/policy.ts";
import { API_BASE, TOKENS, ROTATED, request, stubFetch, json, tokenEnvelope, assertNoStore, findCookie } from "./helpers.ts";

const id = randomUUID(), path = "/api/authoring/notion-jobs", statusPath = `${path}/${id}`;
const cookie = `${ACCESS_TOKEN_COOKIE}=${TOKENS.accessToken}; ${REFRESH_TOKEN_COOKIE}=${TOKENS.refreshToken}`;
const etag = `"${"a".repeat(43)}"`;
const body = JSON.stringify({ bundle: { pages: [] }, planToken: "signed-private-preview" });
const start = (headers: Record<string, string> = {}, query = "") => request(`${path}${query}`, {
  body, headers: { cookie, "idempotency-key": "test-job-request-0001", ...headers },
});
test("job submission uses cookies only, forwards an unchanged plan and maps Location to the private BFF", async () => {
  const upstream = stubFetch({ "api/v1/me": () => json({ data: { id: "author" } }),
    "api/v1/imports/notion/jobs": () => json({ data: { id } }, 202,
      { location: `/api/v1/imports/notion/jobs/${id}`, "retry-after": "2", "set-cookie": "leak=token" }) });
  const response = await handleNotionJobsRequest(start({ authorization: "Bearer browser-forgery", "x-expected-author": "author" }),
    { apiBaseUrl: API_BASE, fetchImpl: upstream.fetchImpl });
  assert.equal(response.status, 202);
  assertNoStore(response);
  assert.equal(response.headers.get("location"), statusPath);
  assert.equal(response.headers.get("retry-after"), "2");
  assert.equal(response.headers.get("set-cookie"), null);
  const call = upstream.calls.at(-1)!;
  assert.equal(new Headers(call.init?.headers).get("authorization"), `Bearer ${TOKENS.accessToken}`);
  assert.equal(new Headers(call.init?.headers).get("idempotency-key"), "test-job-request-0001");
  assert.equal(call.init?.body, body);
});
test("status polls forward only validated conditionals and preserve a bodyless private 304", async () => {
  const upstream = stubFetch({ "api/v1/imports/notion/jobs/": () => new Response(null,
    { status: 304, headers: { etag, location: "https://evil.test/", "x-secret": "not-for-browser" } }) });
  const response = await handleNotionJobRequest(request(statusPath, { method: "GET", headers: {
    cookie, "if-none-match": etag, prefer: "wait=1", "x-extra": "untrusted",
  } }), { id }, { apiBaseUrl: API_BASE, fetchImpl: upstream.fetchImpl });
  assert.equal(response.status, 304);
  assert.equal(await response.text(), "");
  assert.equal(response.headers.get("etag"), etag);
  assert.equal(response.headers.get("location"), null);
  assert.equal(response.headers.get("x-secret"), null);
  assertNoStore(response);
  const headers = new Headers(upstream.calls[0]?.init?.headers);
  assert.equal(headers.get("if-none-match"), etag);
  assert.equal(headers.get("prefer"), "wait=1");
  assert.equal(headers.get("x-extra"), null);
});
test("bad method, origin, pagination, id, plan envelope or conditionals never reach upstream", async () => {
  const upstream = stubFetch({});
  const config = { apiBaseUrl: API_BASE, fetchImpl: upstream.fetchImpl };
  for (const req of [start({}, "?limit=2&limit=3"), start({}, "?owner=other"),
    start({ "idempotency-key": "short" }), request(path, { body: JSON.stringify({ bundle: {}, planToken: "p", token: "forbidden" }) })]) {
    assert.equal((await handleNotionJobsRequest(req, config)).status, 400);
  }
  assert.equal((await handleNotionJobsRequest(start({ origin: "https://foreign.test" }), config)).status, 403);
  assert.equal((await handleNotionJobRequest(request(statusPath, { method: "DELETE", headers: { origin: "https://foreign.test" } }), { id: "invalid" }, config)).status, 403);
  assert.equal((await handleNotionJobsRequest(request(path, { method: "PATCH" }), config)).status, 405);
  const invalidHeaders: Record<string, string>[] = [{ prefer: "wait=6" }, { "if-none-match": "*" }, { prefer: "wait=1, respond-async" }];
  for (const headers of invalidHeaders) {
    assert.equal((await handleNotionJobRequest(request(statusPath, { method: "GET", headers }), { id }, config)).status, 400);
  }
  assert.equal(upstream.calls.length, 0);
});
test("a successful rotation survives a subsequent status 503; neither diagnostics nor upstream cookies escape", async () => {
  let calls = 0;
  const upstream = stubFetch({ "auth/refresh": () => tokenEnvelope(ROTATED),
    "api/v1/imports/notion/jobs/": () => ++calls === 1 ? json({ error: { code: "STALE" } }, 401)
      : json({ error: { message: "raw database secret" } }, 503, { "retry-after": "2", "set-cookie": "upstream=secret" }) });
  const response = await handleNotionJobRequest(request(statusPath, { method: "GET", headers: { cookie } }), { id },
    { apiBaseUrl: API_BASE, fetchImpl: upstream.fetchImpl });
  assert.equal(response.status, 503);
  assert.equal(calls, 2);
  assert.equal(response.headers.get("retry-after"), "2");
  assert.ok(findCookie(response, ACCESS_TOKEN_COOKIE)?.includes(ROTATED.accessToken));
  assert.doesNotMatch(await response.text(), /raw database secret|upstream/);
});
test("missing API is not a durable queue fixture, and suspicious Location/ETag values are discarded", async () => {
  assert.equal((await handleNotionJobsRequest(start())).status, 503);
  const upstream = stubFetch({ "api/v1/imports/notion/jobs": () => json({ data: { id } }, 202,
    { location: "https://foreign.test/stolen", etag: "untrusted-value" }) });
  const response = await handleNotionJobsRequest(start(), { apiBaseUrl: API_BASE, fetchImpl: upstream.fetchImpl });
  assert.equal(response.headers.get("location"), null);
  assert.equal(response.headers.get("etag"), null);
});

test("the original key can select a retained job without its expired plan; query selectors cannot be mixed", async () => {
  const upstream = stubFetch({ "api/v1/imports/notion/jobs": () => json({ data: [{ id, state: "expired" }] }) });
  const config = { apiBaseUrl: API_BASE, fetchImpl: upstream.fetchImpl };
  const headers = { cookie, "idempotency-key": "test-job-request-0001" };
  const response = await handleNotionJobsRequest(request(path, { method: "GET", headers }), config);
  assert.equal(response.status, 200);
  assert.equal(new Headers(upstream.calls[0]?.init?.headers).get("idempotency-key"), headers["idempotency-key"]);
  assert.equal((await handleNotionJobsRequest(request(path + "?limit=20", { method: "GET", headers }), config)).status, 400);
  assert.equal((await handleNotionJobsRequest(request(path, { method: "GET", headers: { ...headers, "idempotency-key": "bad key" } }), config)).status, 400);
  assert.equal(upstream.calls.length, 1);
});
