import assert from "node:assert/strict";
import test from "node:test";
import { handleArticleCatalogueRequest, handleCatalogueArticleRequest, handleCatalogueRestoreRequest, handleCatalogueEditionsRequest } from "../src/catalogue.ts";
import { ACCESS_TOKEN_COOKIE } from "../src/policy.ts";
import type { ApiProxyConfig } from "../src/api.ts";

const id = "a13dbadf-0000-4000-8000-000000000001";
const request = (path = "", init: RequestInit = {}) => new Request(`https://no-wave.test/api/authoring/catalogue${path}`, {
  ...init, headers: { cookie: `${ACCESS_TOKEN_COOKIE}=test-only-access`, "x-expected-author": "author-a", host: "no-wave.test", ...init.headers },
});
function fixture(actor = "author-a") {
  const calls: { url: string; method: string; authorization: string | null }[] = [];
  const config: ApiProxyConfig = { apiBaseUrl: "https://api.example.test", fetchImpl: async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url: url.pathname + url.search, method: init?.method ?? "GET", authorization: new Headers(init?.headers).get("authorization") });
    return Response.json({ data: url.pathname.endsWith("/me") ? { id: actor } : { ok: true } });
  } };
  return { calls, config };
}

test("the catalogue forwards canonical bounded search after verifying the same bearer account", async () => {
  const f = fixture();
  const response = await handleArticleCatalogueRequest(request("?q=%25_%E4%B8%AD%E6%96%87&locale=en&limit=25"), f.config);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.match(response.headers.get("x-robots-tag") ?? "", /noindex/);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0]!.url, "/api/v1/me");
  assert.match(f.calls[1]!.url, /^\/api\/v1\/me\/article-catalogue\?/);
  assert.equal(new URL("https://unused.test" + f.calls[1]!.url).searchParams.get("q"), "%_中文");
  assert.ok(f.calls.every(call => call.authorization === "Bearer test-only-access"));
});

test("account changes never reach the private list, details or restore operation", async () => {
  for (const invoke of [
    (config: ApiProxyConfig) => handleArticleCatalogueRequest(request(), config),
    (config: ApiProxyConfig) => handleCatalogueEditionsRequest(request(`/${id}/editions?scope=trash`), { id }, config),
    (config: ApiProxyConfig) => handleCatalogueArticleRequest(request(`/${id}?locale=en`), { id }, config),
    (config: ApiProxyConfig) => handleCatalogueRestoreRequest(request(`/${id}/restore?locale=en`, { method: "POST", headers: { origin: "https://no-wave.test" } }), { id }, config),
  ]) {
    const f = fixture("author-b");
    const response = await invoke(f.config);
    assert.equal(response.status, 409);
    assert.match(response.headers.get("x-robots-tag") ?? "", /noindex/);
    assert.equal((await response.json()).error.code, "ACCOUNT_CHANGED");
    assert.equal(f.calls.length, 1);
  }
});

test("ambiguous/oversize reads and unsafe restore origins are rejected before contacting the API", async () => {
  const f = fixture();
  for (const path of ["?q=x&q=y", "?actorId=another", "?limit=51", `?cursor=${"a".repeat(1025)}`]) {
    assert.equal((await handleArticleCatalogueRequest(request(path), f.config)).status, 400);
  }
  assert.equal((await handleArticleCatalogueRequest(request("", { headers: { "x-expected-author": "" } }), f.config)).status, 400);
  assert.equal((await handleCatalogueArticleRequest(request(`/${id}?locale=en&locale=zh-CN`), { id }, f.config)).status, 400);
  assert.equal((await handleCatalogueRestoreRequest(request("/bad/restore", { method: "POST", headers: { origin: "https://evil.test" } }), { id: "bad" }, f.config)).status, 403);
  assert.equal((await handleCatalogueRestoreRequest(request(`/${id}/restore?locale=en`, { method: "GET" }), { id }, f.config)).status, 405);
  assert.equal(f.calls.length, 0);
});

test("guarded restore preserves locale and remains the existing API operation", async () => {
  const f = fixture();
  const response = await handleCatalogueRestoreRequest(request(`/${id}/restore?locale=zh-TW`, { method: "POST", headers: { origin: "https://no-wave.test" } }), { id }, f.config);
  assert.equal(response.status, 200);
  assert.equal(f.calls[1]!.url, `/api/v1/articles/${id}/restore?locale=zh-TW`);
  assert.equal(f.calls[1]!.method, "POST");
});

test("complete-edition reads keep the explicit work/scope, same-bearer identity guard and private response headers", async () => {
  for (const scope of ["active", "trash"]) {
    const f = fixture();
    const response = await handleCatalogueEditionsRequest(request(`/${id}/editions?scope=${scope}`), { id }, f.config);
    assert.equal(response.status, 200);
    assert.deepEqual(f.calls.map(call => call.url), ["/api/v1/me", `/api/v1/me/article-catalogue/${id}/editions?scope=${scope}`]);
    assert.ok(f.calls.every(call => call.method === "GET" && call.authorization === "Bearer test-only-access"));
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    assert.match(response.headers.get("x-robots-tag") ?? "", /noindex/);
  }
  const f = fixture();
  for (const query of ["?scope=trash&scope=active", "?scope=deleted", "?locale=en", "?actorId=author-b"]) {
    const response = await handleCatalogueEditionsRequest(request(`/${id}/editions${query}`), { id }, f.config);
    assert.equal(response.status, 400);
    assert.match(response.headers.get("x-robots-tag") ?? "", /noindex/);
  }
  assert.equal((await handleCatalogueEditionsRequest(request(`/${id}/editions`, { method: "POST" }), { id }, f.config)).status, 405);
  assert.equal((await handleCatalogueEditionsRequest(request("/bad/editions"), { id: "bad" }, f.config)).status, 400);
  assert.equal(f.calls.length, 0);
});
