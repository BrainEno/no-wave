/**
 * Upstream timeouts, response compression, and the local writing tools' empty shells.
 */

import assert from "node:assert/strict";

import { readdir } from "node:fs/promises";
import { gunzipSync, brotliDecompressSync } from "node:zlib";
import { test } from "node:test";
import { MOCK_STALL_QUERY } from "../mocks/rest-api.ts";
import { registerPublicWebApp, get, mockApi, packageDir, wire, withEnvServer } from "./support/web-behavior-harness.ts";

registerPublicWebApp();

test("a stalled content API answers 503 inside the budget and leaves the server serving", async () => {
  // `API_TIMEOUT_MS` is 1200 for this process (see the spawn environment). The
  // mock API accepts the connection and then says nothing, which is the failure
  // a bare `fetch` would wait out until the socket or the client gave up.
  const started = Date.now();
  const stalled = await get(`/search?q=${MOCK_STALL_QUERY}`);
  const elapsed = Date.now() - started;

  assert.equal(stalled.status, 503);
  assert.match(stalled.headers.get("cache-control") ?? "", /no-store/);
  assert.match(stalled.body, /服务暂时不可用/, "the page's own 503 boundary, not a blank error");
  assert.match(stalled.body, /class="nw-w nw-head nw-error-page" data-error-boundary="500"/);
  assert.match(stalled.body, /内容暂时无法加载，请稍后重试/);
  // Bounded by the budget, not by a browser or load-balancer timeout.
  assert.ok(elapsed >= 1_000 && elapsed < 10_000, `elapsed ${elapsed} ms outside the configured budget`);

  // The stalled request must not have pinned the process: an ordinary page is
  // still served immediately after it.
  mockApi.resetRequests();
  const afterStall = await get("/");
  assert.equal(afterStall.status, 200);
  assert.ok(mockApi.requests().length > 0);
});

test("a malformed API_TIMEOUT_MS fails closed instead of waiting forever", async () => {
  await withEnvServer({ API_TIMEOUT_MS: "soon" }, async (url) => {
    // The public read never reaches the API: the budget is invalid, and the page
    // answers its own 503 rather than calling out without a deadline.
    mockApi.resetRequests();
    const page = await fetch(`${url}/search?q=anything`);
    assert.equal(page.status, 503);
    assert.match(await page.text(), /服务暂时不可用/);
    assert.deepEqual(mockApi.requests(), []);

    // The same rejection on a proxy route carries the proxy's own error code.
    const proxied = await fetch(`${url}/api/feed`, { headers: { accept: "application/json" } });
    assert.equal(proxied.status, 503);
    assert.match(await proxied.text(), /SERVICE_UNAVAILABLE/);
    assert.deepEqual(mockApi.requests(), []);
  });
});

test("the production server negotiates compressed HTML, JS and CSS over HTTP", async () => {
  const assets = await readdir(`${packageDir}build/client/assets`);
  const script = assets.find((name) => /^entry\.client-.*\.js$/.test(name));
  const css = assets.find((name) => /^globals-.*\.css$/.test(name));
  assert.ok(script, "the Vite entry script exists");
  assert.ok(css, "the built global stylesheet exists");
  for (const path of ["/", `/assets/${script}`, `/assets/${css}`]) {
    const plain = await wire(path, { "accept-encoding": "identity" });
    assert.equal(plain.status, 200, path);
    assert.equal(plain.headers["content-encoding"], undefined);
    assert.match(String(plain.headers.vary), /accept-encoding/i);
    for (const [encoding, decompress] of [["gzip", gunzipSync], ["br", brotliDecompressSync]] as const) {
      const encoded = await wire(path, { "accept-encoding": encoding });
      assert.equal(encoded.status, 200, `${path} ${encoding}`);
      assert.equal(encoded.headers["content-encoding"], encoding, path);
      assert.match(String(encoded.headers.vary), /accept-encoding/i);
      const decoded = decompress(encoded.body);
      if (path === "/") {
        assert.match(decoded.toString(), /<html/i);
        assert.match(decoded.toString(), /nw-footer/);
      } else assert.deepEqual(decoded, plain.body, path);
      assert.ok(encoded.body.length < decoded.length, `${path} should shrink`);
    }
  }
});

test("the production server does not compress private, query-bearing or authenticated HTML", async () => {
  const cases: Array<{ path: string; headers: Record<string, string> }> = [
    { path: "/sign-in?next=%2Faccount", headers: {} },
    { path: "/?q=reflected", headers: {} },
    { path: "/", headers: { cookie: "nw_session=123" } },
    { path: "/", headers: { authorization: "Bearer secret" } },
  ];
  for (const { path, headers } of cases) {
    const response = await wire(path, { "accept-encoding": "gzip", ...headers });
    assert.equal(response.status, 200, path);
    assert.equal(response.headers["content-encoding"], undefined, path);
    assert.match(String(response.headers.vary), /accept-encoding/i);
    assert.match(response.body.toString(), /<html/i);
  }
});

test("the local three-way merge route is an empty private shell and does not reflect or load file URLs", async () => {
  const response = await get("/write/merge");
  assert.equal(response.status, 200);
  assert.match(response.body, /data-route="write-merge"/);
  assert.match(response.body, /本机三方文稿合并/);
  assert.match(response.body, /noindex, nofollow/);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.doesNotMatch(response.body, /contenteditable="true"/);
  const query = await get("/write/merge?base=https%3A%2F%2Fattacker.test%2FPRIVATE-MERGE-FILE");
  assert.equal(query.status, 302);
  assert.equal(query.headers.get("location"), "/write/merge");
  assert.match(query.headers.get("cache-control") ?? "", /no-store/);
  assert.doesNotMatch(query.body, /PRIVATE-MERGE-FILE/);
});

test("the local collection tool is a protected empty shell without account authority or file-URL auto-loading", async () => {
  const response = await get("/write/collections");
  assert.equal(response.status, 200);
  assert.match(response.body, /data-route="write-collections"/);
  assert.match(response.body, /本机文稿集合/);
  assert.match(response.body, /noindex/);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  const query = await get("/write/collections?file=https%3A%2F%2Fattacker.test%2FPRIVATE-FILE-URL");
  assert.equal(query.status, 302);
  assert.equal(query.headers.get("location"), "/write/collections");
  assert.match(query.headers.get("cache-control") ?? "", /no-store/);
  assert.doesNotMatch(query.body, /PRIVATE-FILE-URL/);
});

test("the local encryption tool is an empty no-store document with a narrowly scoped Worker capability and inert URL input", async () => {
  const response = await get("/write/vault");
  assert.equal(response.status, 200);
  assert.match(response.body, /data-route="write-vault"/);
  assert.match(response.body, /本机文稿加密备份/);
  assert.match(response.body, /noindex, nofollow/);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.match(response.headers.get("content-security-policy") ?? "", /worker-src 'self'/);
  assert.doesNotMatch(response.body, /contenteditable="true"|PRIVATE_VAULT_SOURCE/);
  const query = await get("/write/vault?password=PRIVATE_VAULT_SOURCE&file=https%3A%2F%2Fattacker.test%2Fnever");
  assert.equal(query.status, 302); assert.equal(query.headers.get("location"), "/write/vault");
  assert.match(query.headers.get("cache-control") ?? "", /no-store/);
  assert.doesNotMatch(query.body, /PRIVATE_VAULT_SOURCE/);
  for (const path of ["/write/merge", "/write/collections", "/"]) {
    const ordinary = await get(path);
    assert.match(ordinary.headers.get("content-security-policy") ?? "", /worker-src 'none'/);
  }
});

test("the local paragraph-overlap review is an empty private shell, rejects URL-selected sources and does not enable Workers", async () => {
  const response = await get("/write/overlap");
  assert.equal(response.status, 200);
  assert.match(response.body, /data-route="write-overlap"/);
  assert.match(response.body, /本机文稿重复段落审阅/);
  assert.match(response.body, /noindex, nofollow/);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.match(response.headers.get("content-security-policy") ?? "", /worker-src 'none'/);
  assert.doesNotMatch(response.body, /contenteditable="true"|PRIVATE_OVERLAP_SOURCE/);
  for (const path of ["/write/overlap?file=https%3A%2F%2Fattacker.test%2FPRIVATE_OVERLAP_SOURCE", "/write/%6fverlap", "/write/overlap/"]) {
    const query = await get(path);
    assert.equal(query.status, 302, path);
    assert.equal(query.headers.get("location"), "/write/overlap");
    assert.match(query.headers.get("cache-control") ?? "", /no-store/);
    assert.doesNotMatch(query.body, /PRIVATE_OVERLAP_SOURCE/);
  }
});

test("local terminology review is an empty no-store shell, rejects URL-selected source/glossary and never broadens Worker capability", async () => {
  const response = await get("/write/terms");
  assert.equal(response.status, 200);
  assert.match(response.body, /data-route="write-terms"/);
  assert.match(response.body, /本机术语一致性审阅/);
  assert.match(response.body, /noindex, nofollow/);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.match(response.headers.get("content-security-policy") ?? "", /worker-src 'none'/);
  assert.doesNotMatch(response.body, /contenteditable="true"|PRIVATE_TERMS_SOURCE/);
  for (const path of ["/write/terms?file=https%3A%2F%2Fattacker.test%2FPRIVATE_TERMS_SOURCE&recipe=secret", "/write/%74erms", "/write/terms/"]) {
    const query = await get(path);
    assert.equal(query.status, 302, path);
    assert.equal(query.headers.get("location"), "/write/terms");
    assert.match(query.headers.get("cache-control") ?? "", /no-store/);
    assert.doesNotMatch(query.body, /PRIVATE_TERMS_SOURCE/);
  }
});

test("local punctuation/rhythm review is an empty private shell with URL-inert inputs and no Worker permission", async () => {
  const response = await get("/write/cadence");
  assert.equal(response.status, 200);
  assert.match(response.body, /data-route="write-cadence"/);
  assert.match(response.body, /本机标点与停顿节奏审阅/);
  assert.match(response.body, /noindex, nofollow/);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.match(response.headers.get("content-security-policy") ?? "", /worker-src 'none'/);
  assert.doesNotMatch(response.body, /contenteditable="true"|PRIVATE_CADENCE_SOURCE/);
  for (const path of ["/write/cadence?file=https%3A%2F%2Fattacker.test%2FPRIVATE_CADENCE_SOURCE&dot=true", "/write/%63adence", "/write/cadence/"]) {
    const query = await get(path);
    assert.equal(query.status, 302, path);
    assert.equal(query.headers.get("location"), "/write/cadence");
    assert.match(query.headers.get("cache-control") ?? "", /no-store/);
    assert.doesNotMatch(query.body, /PRIVATE_CADENCE_SOURCE/);
  }
});
