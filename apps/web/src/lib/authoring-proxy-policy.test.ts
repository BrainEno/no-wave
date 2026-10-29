import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { forwardAuthoringApi } from "./authoring-proxy.ts";
import { isSameOriginMutation, safeRedirectPath, tokenMaxAge } from "./authoring-proxy-policy.ts";

test("authoring mutations require an exact same-origin browser origin", () => {
  assert.equal(isSameOriginMutation("https://example.test/api/authoring/articles", "https://example.test"), true);
  assert.equal(isSameOriginMutation("https://example.test/api/authoring/articles", "https://attacker.test"), false);
  assert.equal(isSameOriginMutation("https://example.test/api/authoring/articles", "https://example.test.evil"), false);
  assert.equal(isSameOriginMutation("https://example.test/api/authoring/articles", "https://example.test/path"), false);
  assert.equal(isSameOriginMutation("https://example.test/api/authoring/articles", null), false);
});

test("post-login redirects stay relative to the current site", () => {
  assert.equal(safeRedirectPath("/write"), "/write");
  assert.equal(safeRedirectPath("/account?tab=profile#top"), "/account?tab=profile#top");
  assert.equal(safeRedirectPath("//attacker.test"), "/write");
  assert.equal(safeRedirectPath("https://attacker.test"), "/write");
  assert.equal(safeRedirectPath("/\\\\attacker.test"), "/write");
});

test("cookie lifetimes are finite and capped", () => {
  const now = Date.parse("2026-10-28T00:00:00.000Z");
  assert.equal(tokenMaxAge("2026-10-28T00:01:00.000Z", now), 60);
  assert.equal(tokenMaxAge("2027-12-01T00:00:00.000Z", now), 30 * 24 * 60 * 60);
  assert.equal(tokenMaxAge("not-a-date", now), 0);
});


test("comment idempotency keys survive the same-origin API proxy", async () => {
  const originalFetch = globalThis.fetch;
  const previousEnv = {
    API_BASE_URL: process.env.API_BASE_URL,
    API_SERVICE_URL: process.env.API_SERVICE_URL,
    API_GRAPHQL_URL: process.env.API_GRAPHQL_URL,
  };
  let forwardedHeaders: Headers | null = null;
  process.env.API_BASE_URL = "https://api.example.test";
  delete process.env.API_SERVICE_URL;
  delete process.env.API_GRAPHQL_URL;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    forwardedHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({ data: { accepted: true } }), {
      status: 201,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }) as typeof fetch;
  try {
    const request = new NextRequest("https://web.example.test/api/articles/example/comments", {
      method: "POST",
      headers: { "idempotency-key": "comment-once-7" },
    });
    const response = await forwardAuthoringApi(
      request,
      "api/v1/articles/example/comments",
      "POST",
      JSON.stringify({ content: "A comment" }),
    );
    assert.equal(response.status, 201);
    assert.equal(forwardedHeaders?.get("idempotency-key"), "comment-once-7");
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
