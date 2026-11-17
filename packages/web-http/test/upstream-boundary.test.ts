import assert from "node:assert/strict";
import test from "node:test";
import { forwardAuthoringRequest } from "../src/forward.ts";
import { handleAuthRequest } from "../src/auth.ts";
import { API_BASE, ROTATED, json, request, setCookies } from "./helpers.ts";

const limit = 8 * 1024 * 1024;

test("a resource 5xx never relays driver diagnostics or upstream cookies", async () => {
  const response = await forwardAuthoringRequest(request("/api/authoring/session"), "api/v1/me", "GET", {
    apiBaseUrl: API_BASE,
    fetchImpl: async () => json({ error: { code: "DATABASE_ERROR", message: "postgres://private:secret@database/internal", stack: "private frame" } }, 503,
      { "set-cookie": "internal=secret", "retry-after": "7" }),
  });
  assert.equal(response.status, 503);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(response.headers.get("retry-after"), "7");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.doesNotMatch(await response.text(), /postgres|private|secret|DATABASE_ERROR|stack/);
});

test("an advertised oversized upstream body is cancelled before buffering", async () => {
  let cancelled = false;
  const response = await forwardAuthoringRequest(request("/api/authoring/session"), "api/v1/me", "GET", {
    apiBaseUrl: API_BASE,
    fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"data":{}}')); controller.close(); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { headers: { "content-type": "application/json", "content-length": String(limit + 1) } }),
  });
  assert.equal(response.status, 502);
  assert.equal(cancelled, true);
  assert.equal((await response.json()).error.code, "UPSTREAM_RESPONSE_TOO_LARGE");
});

test("the decoded byte ceiling is enforced when Content-Length is missing or dishonest", async () => {
  for (const declared of [undefined, "1"]) {
    let produced = 0;
    let cancelled = false;
    const response = await forwardAuthoringRequest(request("/api/authoring/session"), "api/v1/me", "GET", {
      apiBaseUrl: API_BASE,
      fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          produced++;
          controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
          if (produced === 12) controller.close();
        },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 }), { headers: { "content-type": "application/json", ...(declared ? { "content-length": declared } : {}) } }),
    });
    assert.equal(response.status, 502);
    assert.equal(cancelled, true);
    assert.ok(produced <= 9, "oversized content must not be fully consumed");
  }
});

test("a pre-cancelled browser request never starts an upstream operation", async () => {
  const controller = new AbortController();
  controller.abort(new Error("private cancellation reason"));
  let calls = 0;
  const response = await forwardAuthoringRequest(new Request("https://no-wave.test/api/authoring/session", { signal: controller.signal }), "api/v1/me", "GET", {
    apiBaseUrl: API_BASE, fetchImpl: async () => { calls++; return json({ data: {} }); },
  });
  assert.equal(response.status, 499);
  assert.equal(calls, 0);
  assert.doesNotMatch(await response.text(), /private cancellation reason/);
});

test("cancelling after upstream headers cancels the reader without waiting for the deadline", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const response = await forwardAuthoringRequest(new Request("https://no-wave.test/api/authoring/session", { signal: controller.signal }), "api/v1/me", "GET", {
    apiBaseUrl: API_BASE, upstreamTimeoutMs: 100,
    fetchImpl: async () => {
      setTimeout(() => controller.abort(), 5);
      return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), { headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(response.status, 499);
  assert.equal(cancelled, true);
});

test("an HTML success is an invalid API response, never an executable browser document", async () => {
  const response = await forwardAuthoringRequest(request("/api/authoring/session"), "api/v1/me", "GET", {
    apiBaseUrl: API_BASE,
    fetchImpl: async () => new Response("<script>privateUpstream()</script>", { headers: { "content-type": "text/html" } }),
  });
  assert.equal(response.status, 502);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  assert.doesNotMatch(await response.text(), /script|privateUpstream/);
});

test("business conflicts retain the structured fields needed for recovery", async () => {
  const payload = { error: { code: "REVISION_CONFLICT", message: "The work changed.", details: { revision: 9, actor: "original" } } };
  const response = await forwardAuthoringRequest(request("/api/authoring/articles/a"), "api/v1/articles/a", "PUT", {
    apiBaseUrl: API_BASE, fetchImpl: async () => json(payload, 409),
  }, "{}");
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), payload);
});

test("authentication uses its own small response ceiling and never writes cookies on failure", async () => {
  const response = await handleAuthRequest(request("/api/auth/login", { body: "{}" }), "login", {
    apiBaseUrl: API_BASE,
    fetchImpl: async () => json({ data: { diagnostic: "x".repeat(64 * 1024) } }),
  });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "UPSTREAM_RESPONSE_TOO_LARGE");
  assert.deepEqual(setCookies(response), []);
});

test("a resource 401 can coordinate exactly one refresh even when its optional error body is absent or corrupt", async () => {
  let caseNumber = 0;
  for (const path of ["api/v1/me/articles", "api/v1/imports/notion/export?slugs=work-one"]) {
    for (const body of [null, new Uint8Array([123, 34, 120, 34, 58, 34, 255, 34, 125])]) {
      const calls: string[] = [];
      const current = ++caseNumber;
      const response = await forwardAuthoringRequest(request("/api/authoring/articles", { method: "GET", headers: {
        cookie: `nw_access=expired; nw_refresh=${String.fromCharCode(97 + current).repeat(43)}`,
      } }), path, "GET", { apiBaseUrl: API_BASE, fetchImpl: async url => {
        calls.push(url.includes("auth/refresh") ? "refresh" : "resource");
        if (url.includes("auth/refresh")) return json({ data: ROTATED });
        return calls.length === 1 ? new Response(body, { status: 401, headers: { "content-type": "application/json" } }) : json({ data: [] });
      } });
      assert.equal(response.status, 200, `${path}, fixture ${current}`);
      assert.deepEqual(await response.json(), { data: [] });
      assert.deepEqual(calls, ["resource", "refresh", "resource"]);
      assert.ok(setCookies(response).some(cookie => cookie.startsWith(`nw_access=${ROTATED.accessToken}`)));
    }
  }
});
