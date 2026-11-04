import assert from "node:assert/strict";
import test from "node:test";

import {
  FEED_DEFAULT_LIMIT,
  FEED_MAX_LIMIT,
  FEED_MAX_OFFSET,
  feedRequestPath,
  handleFeedRequest,
  parseFeedInteger,
} from "../src/feed.ts";
import { ACCESS_TOKEN_COOKIE } from "../src/policy.ts";
import { API_BASE, TOKENS, assertNoStore, json, stubFetch } from "./helpers.ts";

/**
 * Following-feed proxy contract (#198).
 *
 * The feed is the reason following exists: without a read side, following an
 * author only lets a reader go and look at their profile, and the graph is
 * write-only.
 *
 * The case that matters most here is not the happy path but **401 versus an
 * empty list**. They look identical in a list-shaped body and mean opposite
 * things: "sign in to see your feed" versus "nobody you follow has published
 * anything". Only the status code separates them, so the proxy must not soften
 * or swallow it.
 */

function feedUpstream(
  body: unknown = { data: [{ slug: "a-work", title: "A work" }] },
  status = 200,
) {
  const stub = stubFetch({ "api/v1/me/feed": () => json(body, status) });
  return { calls: stub.calls, config: { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl } };
}

function feedRequest(query = "locale=zh-CN", options: { cookie?: string; method?: string } = {}): Request {
  const headers: Record<string, string> = { host: "no-wave.test", accept: "application/json" };
  if (options.cookie) headers.cookie = options.cookie;
  return new Request(`https://no-wave.test/api/feed?${query}`, {
    method: options.method ?? "GET",
    headers,
  });
}

test("an authenticated read carries the session cookie as a bearer token", async () => {
  const { config, calls } = feedUpstream();
  const response = await handleFeedRequest(
    feedRequest("locale=zh-CN", { cookie: `${ACCESS_TOKEN_COOKIE}=${TOKENS.accessToken}` }),
    { locale: "zh-CN" },
    config,
  );
  assert.equal(response.status, 200);
  assertNoStore(response);
  const forwarded = new Headers(calls[0].init?.headers);
  assert.equal(forwarded.get("authorization"), `Bearer ${TOKENS.accessToken}`);
  assert.equal(forwarded.get("cookie"), null, "the cookie does not travel upstream");
  assert.equal(calls[0].init?.method, "GET");
});

test("signed out is a 401, not an empty feed", async () => {
  // An empty array and a missing session render the same in a list. If the proxy
  // turned 401 into `[]`, a signed-out reader would be told "nobody you follow
  // has published anything" instead of "sign in" — and nothing on the page could
  // tell the difference.
  const stub = stubFetch({
    "api/v1/me/feed": () =>
      json({ error: { code: "UNAUTHENTICATED", message: "Authentication is required." } }, 401),
  });
  const response = await handleFeedRequest(feedRequest(), { locale: "zh-CN" }, {
    apiBaseUrl: API_BASE,
    fetchImpl: stub.fetchImpl,
  });
  assert.equal(response.status, 401);
  assert.equal(stub.calls.length, 1, "the API decides, and the answer is passed through");
  assert.equal(new Headers(stub.calls[0].init?.headers).get("authorization"), null);
});

test("an empty feed is forwarded as an empty list", async () => {
  const { config } = feedUpstream({ data: [] });
  const response = await handleFeedRequest(feedRequest(), { locale: "zh-CN" }, config);
  assert.equal(response.status, 200);
  const body = await response.json() as { data?: unknown[] };
  assert.deepEqual(body.data, []);
});

test("limit and offset reach the API as numbers it can parse", async () => {
  const { config, calls } = feedUpstream();
  await handleFeedRequest(feedRequest("locale=zh-CN&limit=5&offset=10"), { locale: "zh-CN", limit: "5", offset: "10" }, config);
  assert.ok(calls[0].url.includes("limit=5"), calls[0].url);
  assert.ok(calls[0].url.includes("offset=10"), calls[0].url);
});

test("a missing limit and offset become the defaults", async () => {
  const { config, calls } = feedUpstream();
  await handleFeedRequest(feedRequest(), { locale: "zh-CN" }, config);
  assert.ok(calls[0].url.includes(`limit=${FEED_DEFAULT_LIMIT}`), calls[0].url);
  assert.ok(calls[0].url.includes("offset=0"), calls[0].url);
});

test("pagination values that are not clean integers are refused locally", async () => {
  // `Number()` would accept every one of these and mean something the caller did
  // not ask for — `1e3` is 1000, `1.5` becomes a fractional offset. Refusing at
  // the edge names the problem; forwarding it turns a client bug into an API
  // error the reader sees as a broken page.
  const { config, calls } = feedUpstream();
  for (const bad of ["1.5", "1e3", "+1", " 1", "abc", "-1", "0x10", "1_000"]) {
    const response = await handleFeedRequest(
      feedRequest(`locale=zh-CN&limit=${encodeURIComponent(bad)}`),
      { locale: "zh-CN", limit: bad },
      config,
    );
    assert.equal(response.status, 400, JSON.stringify(bad));
  }
  assert.equal(calls.length, 0, "a malformed limit never reaches the API");
});

test("a limit of zero is refused but an offset of zero is not", async () => {
  const { config, calls } = feedUpstream();
  const zeroLimit = await handleFeedRequest(feedRequest("locale=zh-CN&limit=0"), { locale: "zh-CN", limit: "0" }, config);
  assert.equal(zeroLimit.status, 400, "a feed of nothing is a caller bug");

  const zeroOffset = await handleFeedRequest(feedRequest("locale=zh-CN&offset=0"), { locale: "zh-CN", offset: "0" }, config);
  assert.equal(zeroOffset.status, 200, "the first page is offset zero");
  assert.equal(calls.length, 1);
});

test("values over the API's own bounds are refused rather than forwarded", async () => {
  const { config, calls } = feedUpstream();
  for (const [limit, offset] of [
    [String(FEED_MAX_LIMIT + 1), "0"],
    ["20", String(FEED_MAX_OFFSET + 1)],
  ]) {
    const response = await handleFeedRequest(
      feedRequest(`locale=zh-CN&limit=${limit}&offset=${offset}`),
      { locale: "zh-CN", limit, offset },
      config,
    );
    assert.equal(response.status, 400, `limit=${limit} offset=${offset}`);
  }
  assert.equal(calls.length, 0);
});

test("only GET is accepted", async () => {
  const { config, calls } = feedUpstream();
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const response = await handleFeedRequest(
      feedRequest("locale=zh-CN", { method }),
      { locale: "zh-CN" },
      config,
    );
    assert.equal(response.status, 405, method);
  }
  assert.equal(calls.length, 0, "a write verb never reaches a read endpoint");
});

test("the locale defaults when absent and is validated when present", async () => {
  const { config, calls } = feedUpstream();
  const ok = await handleFeedRequest(feedRequest(""), { locale: null }, config);
  assert.equal(ok.status, 200);
  assert.ok(calls[0].url.includes("locale=zh-CN"), "a missing locale means the default one");

  const bad = await handleFeedRequest(feedRequest("locale=fr-FR"), { locale: "fr-FR" }, config);
  assert.equal(bad.status, 400);
});

test("an unconfigured API is a 503, not an empty feed", async () => {
  // The same distinction as signed-out: `[]` would claim "nothing new", which is
  // a statement about the reader's follow graph, not about the deployment.
  const response = await handleFeedRequest(feedRequest(), { locale: "zh-CN" }, {});
  assert.equal(response.status, 503);
});

test("an upstream failure is passed through, with no caching", async () => {
  const stub = stubFetch({
    "api/v1/me/feed": () => json({ error: { code: "SERVICE_UNAVAILABLE", message: "try later" } }, 500),
  });
  const response = await handleFeedRequest(feedRequest(), { locale: "zh-CN" }, {
    apiBaseUrl: API_BASE,
    fetchImpl: stub.fetchImpl,
  });
  assert.equal(response.status, 500);
  assertNoStore(response);
});

test("parseFeedInteger accepts clean integers and refuses everything else", () => {
  assert.equal(parseFeedInteger(null, 20, 100), 20);
  assert.equal(parseFeedInteger("", 20, 100), 20);
  assert.equal(parseFeedInteger("0", 20, 100), 0);
  assert.equal(parseFeedInteger("5", 20, 100), 5);
  assert.equal(parseFeedInteger("100", 20, 100), 100);
  for (const bad of ["101", "1.5", "1e3", "+1", " 1", "1 ", "abc", "-1", "0x10"]) {
    assert.equal(parseFeedInteger(bad, 20, 100), null, JSON.stringify(bad));
  }
});

test("the upstream path is exactly the API's", () => {
  assert.equal(feedRequestPath("zh-CN", 20, 0), "api/v1/me/feed?locale=zh-CN&limit=20&offset=0");
  assert.equal(feedRequestPath("en", 5, 40), "api/v1/me/feed?locale=en&limit=5&offset=40");
});
