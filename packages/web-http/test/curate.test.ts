import assert from "node:assert/strict";
import test from "node:test";

import {
  FEATURED_CANDIDATES_LIMIT,
  authoringFeaturedCandidatesPath,
  authoringFeaturedPath,
  handleAuthoringFeaturedCandidatesRequest,
  handleAuthoringFeaturedRequest,
} from "../src/curate.ts";
import { API_BASE, assertNoStore, json, request, stubFetch } from "./helpers.ts";

/**
 * Editorial shelf proxy contract (ADR 0016).
 *
 * The featured shelf is the one endpoint on this proxy whose read is public and
 * whose write is privileged, so both halves are asserted here: the read reaches
 * the API unauthenticated, and the write — a whole arrangement, not a delta —
 * only leaves our own origin. The candidate search is asserted to build its
 * query instead of forwarding the caller's, so a screen cannot be talked into
 * asking upstream for something it never meant to ask for.
 */

const ARTICLE_ID = "3f7c1d90-8a2b-4c1e-9f3a-6c5b2e8d1a44";

function upstream(body: unknown = { data: [] }, status = 200) {
  return stubFetch({ "api/v1/": () => json(body, status) });
}

/**
 * The featured shelf is the one endpoint on this proxy whose read is public and
 * whose write is privileged, so both halves are asserted here: the read reaches
 * the API unauthenticated, and the write — a whole arrangement, not a delta —
 * only leaves our own origin.
 */
function featuredRequest(method = "GET", body?: string, headers: Record<string, string> = {}): Request {
  return request("/api/authoring/featured", {
    method,
    headers: { host: "no-wave.test", origin: "https://no-wave.test", ...headers },
    ...(body === undefined ? {} : { body }),
  });
}

test("the featured shelf is a public read and an origin-checked whole-shelf write", async () => {
  const shelf = [{ id: ARTICLE_ID, title: "被选中的一篇" }];
  const read = upstream({ data: shelf });
  const listed = await handleAuthoringFeaturedRequest(featuredRequest(), {
    apiBaseUrl: API_BASE, fetchImpl: read.fetchImpl,
  });
  assert.equal(listed.status, 200);
  assertNoStore(listed);
  assert.equal(read.calls[0]?.url, `${API_BASE}/${authoringFeaturedPath()}`);
  assert.equal(read.calls[0]?.init?.method, "GET");
  assert.deepEqual(await listed.json(), { data: shelf });

  // One request carrying the whole arrangement, forwarded verbatim: no
  // re-ordering, no per-item splitting, nothing for the proxy to interpret.
  const write = upstream({ data: shelf });
  const saved = await handleAuthoringFeaturedRequest(
    featuredRequest("PUT", JSON.stringify({ articleIds: [ARTICLE_ID] }), { "content-type": "application/json" }),
    { apiBaseUrl: API_BASE, fetchImpl: write.fetchImpl },
  );
  assert.equal(saved.status, 200);
  assert.equal(write.calls[0]?.url, `${API_BASE}/api/v1/featured`);
  assert.equal(write.calls[0]?.init?.method, "PUT");
  assert.equal(write.calls[0]?.init?.body, JSON.stringify({ articleIds: [ARTICLE_ID] }));

  const foreign = upstream();
  const rejected = await handleAuthoringFeaturedRequest(
    featuredRequest("PUT", JSON.stringify({ articleIds: [] }), {
      "content-type": "application/json", origin: "https://elsewhere.test",
    }),
    { apiBaseUrl: API_BASE, fetchImpl: foreign.fetchImpl },
  );
  assert.equal(rejected.status, 403);
  assert.deepEqual(foreign.calls, []);

  const wrongMethod = await handleAuthoringFeaturedRequest(featuredRequest("DELETE"), {
    apiBaseUrl: API_BASE, fetchImpl: upstream().fetchImpl,
  });
  assert.equal(wrongMethod.status, 405);
});

test("the candidate search is built here, not forwarded from the caller", async () => {
  const stub = upstream({ data: [{ id: ARTICLE_ID, title: "候选的一篇" }] });
  // `limit=999` and `status=draft` are in the query string and are not in the
  // answer: the screen asks for published works by the page it can handle, and
  // a caller does not get to widen that.
  const found = await handleAuthoringFeaturedCandidatesRequest(
    request("/api/authoring/featured/candidates?q=%20%E6%B5%AA%20&limit=999&status=draft", { method: "GET" }),
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.equal(found.status, 200);
  assertNoStore(found);
  assert.equal(stub.calls[0]?.url, `${API_BASE}/${authoringFeaturedCandidatesPath("浪")}`);
  assert.equal(stub.calls[0]?.init?.method, "GET");
  assert.deepEqual(await found.json(), { data: [{ id: ARTICLE_ID, title: "候选的一篇" }] });

  const wrongMethod = await handleAuthoringFeaturedCandidatesRequest(
    request("/api/authoring/featured/candidates", { method: "POST" }),
    { apiBaseUrl: API_BASE, fetchImpl: upstream().fetchImpl },
  );
  assert.equal(wrongMethod.status, 405);
});

test("an empty candidate search is a plain published list, and the limit is the screen's own", () => {
  assert.equal(authoringFeaturedCandidatesPath("   "), `api/v1/articles?status=published&limit=${FEATURED_CANDIDATES_LIMIT}&offset=0`);
});
