import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { after, before, test } from "node:test";
import { startMockRestApi } from "../mocks/rest-api.ts";
import { startProductionWeb } from "./support/production-web.ts";
import { callFrom, EDGE_PEER, FIRST_CLIENT } from "./support/client-address-stack.ts";
import { htmlScripts, inlineScriptText } from "./support/html-scripts.ts";

let api: Awaited<ReturnType<typeof startMockRestApi>>;
let web: Awaited<ReturnType<typeof startProductionWeb>>;
before(async () => {
  api = await startMockRestApi();
  web = await startProductionWeb({ API_BASE_URL: api.url, SITE_URL: "https://security.example.test",
    WEB_TRUSTED_PROXY_HOPS: "0", WEB_TRUSTED_PROXY_PEERS: "" });
});
after(async () => { await web?.close(); await api?.close(); });

function baseline(headers: Headers): void {
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(headers.get("x-frame-options"), "DENY");
  assert.equal(headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.equal(headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
}
function documentPolicy(headers: Headers, html: string): string[] {
  baseline(headers);
  const policy = headers.get("content-security-policy") ?? "";
  assert.match(policy, /(?:^|;)\s*frame-ancestors 'none'(?:;|$)/);
  assert.match(policy, /(?:^|;)\s*object-src 'none'(?:;|$)/);
  assert.match(policy, /(?:^|;)\s*base-uri 'self'(?:;|$)/);
  assert.match(policy, /(?:^|;)\s*script-src-attr 'none'(?:;|$)/);
  const script = policy.split(";").find(value => value.trim().startsWith("script-src ")) ?? "";
  assert.doesNotMatch(script, /unsafe-inline|unsafe-eval|nonce-|https:|\*/);
  assert.equal(headers.get("content-security-policy-report-only"), null, "the policy must actually enforce");
  const hashes: string[] = [];
  for (const node of htmlScripts(html)) {
    if (node.attrs.some(attribute => attribute.name === "src")) continue;
    assert.match(node.attrs.find(attribute => attribute.name === "nonce")?.value ?? "", /^[A-Za-z0-9_-]{32}$/, "framework scripts have render-local provenance");
    const digest = createHash("sha256").update(inlineScriptText(node)).digest("base64");
    assert.ok(script.includes(`'sha256-${digest}'`), "every actual inline framework script is authorized by its exact bytes");
    hashes.push(digest);
  }
  assert.ok(hashes.length >= 3, "exercise hydration, restoration and streamed handoff, not a script-free mock page");
  return hashes;
}

test("all public documents enforce hashed scripts without giving up shared HTML caching", async () => {
  for (const path of ["/", "/en", "/articles", "/authors", "/categories"]) {
    const response: Response = await fetch(web.origin + path);
    assert.equal(response.status, 200, path);
    documentPolicy(response.headers, await response.text());
    assert.match(response.headers.get("cache-control") ?? "", /public,.*s-maxage=60/);
    assert.equal(response.headers.get("strict-transport-security"), null, "SITE_URL is not transport evidence");
    assert.deepEqual(response.headers.getSetCookie(), []);
  }
});

test("authenticated private shells enforce the same CSP and remain data-free and no-store", async () => {
  const cookie = `nw_session=${Math.floor(Date.now() / 1000) + 3600}`;
  for (const path of ["/account", "/write", "/write/media", "/messages", "/admin/featured", "/tags"]) {
    const response: Response = await fetch(web.origin + path, { headers: { cookie }, redirect: "manual" });
    assert.equal(response.status, 200, path);
    const html = await response.text();
    documentPolicy(response.headers, html);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    assert.doesNotMatch(html, /nw_access=|nw_refresh=|passwordHash/);
  }
});

test("404 and upstream 503 documents retain real status, private cache policy and executable hydration", async () => {
  for (const [path, status] of [["/no-such-security-page", 404], ["/articles/no-such-work", 404], ["/articles/mock-upstream-failure", 503]] as const) {
    const response: Response = await fetch(web.origin + path);
    assert.equal(response.status, status, path);
    const html = await response.text();
    documentPolicy(response.headers, html);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    assert.match(html, /noindex/);
    assert.doesNotMatch(html, /stack trace|DATABASE_URL/);
  }
});

test("redirects, health JSON, malformed requests and unauthorized resources all receive the baseline", async () => {
  for (const [path, status] of [["/account", 302], ["/healthz?probe=1", 200], ["/%zz", 400], ["/api/authoring/session", 401]] as const) {
    const response: Response = await fetch(web.origin + path, { redirect: "manual" });
    assert.equal(response.status, status, path);
    baseline(response.headers);
    assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(response.headers.get("strict-transport-security"), null);
    await response.body?.cancel();
  }
});

test("immutable JS, CSS, fonts and icons have nosniff and restrictive standalone-document policies", async () => {
  const assets = await readdir(new URL("../build/client/assets/", import.meta.url));
  for (const extension of [".js", ".css", ".woff2"]) {
    const name = assets.find(value => value.endsWith(extension));
    assert.ok(name, `the real build contains ${extension}`);
    for (const method of ["GET", "HEAD"]) {
      const response: Response = await fetch(`${web.origin}/assets/${name}`, { method, headers: { "accept-encoding": "identity" } });
      assert.equal(response.status, 200);
      baseline(response.headers);
      assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
      assert.match(response.headers.get("cache-control") ?? "", /max-age=31536000, immutable/);
      assert.ok(Number(response.headers.get("content-length")) > 0);
      if (method === "HEAD") assert.equal((await response.arrayBuffer()).byteLength, 0);
      else await response.body?.cancel();
    }
  }
  const icon = await fetch(web.origin + "/favicon.svg");
  baseline(icon.headers);
  assert.match(icon.headers.get("content-security-policy") ?? "", /object-src 'none'/);
  await icon.body?.cancel();
});

test("fresh render markers differ but never become reusable browser nonce credentials", async () => {
  const [first, second] = await Promise.all([fetch(web.origin + "/"), fetch(web.origin + "/")]);
  const [left, right] = await Promise.all([first.text(), second.text()]);
  const leftMarker = htmlScripts(left)[0]?.attrs.find(attribute => attribute.name === "nonce")?.value;
  const rightMarker = htmlScripts(right)[0]?.attrs.find(attribute => attribute.name === "nonce")?.value;
  assert.ok(leftMarker);
  assert.ok(rightMarker);
  assert.notEqual(leftMarker, rightMarker);
  assert.deepEqual(documentPolicy(first.headers, left), documentPolicy(second.headers, right));
  assert.equal(first.headers.get("content-security-policy"), second.headers.get("content-security-policy"), "the executable bytes, not the render marker, determine a cache-safe policy");
});

test("content decoding and HEAD do not change script policy, cache dimensions or response metadata", async () => {
  const plain = await fetch(web.origin + "/", { headers: { "accept-encoding": "identity" } });
  const zipped = await fetch(web.origin + "/", { headers: { "accept-encoding": "gzip" } });
  assert.equal(zipped.headers.get("content-encoding"), "gzip");
  assert.deepEqual(documentPolicy(plain.headers, await plain.text()), documentPolicy(zipped.headers, await zipped.text()));
  assert.equal(plain.headers.get("content-security-policy"), zipped.headers.get("content-security-policy"));
  assert.match(zipped.headers.get("vary") ?? "", /Accept-Encoding.*Cookie.*Authorization/i);
  const head = await fetch(web.origin + "/", { method: "HEAD" });
  baseline(head.headers);
  assert.equal(head.headers.get("content-security-policy"), plain.headers.get("content-security-policy"));
  assert.equal((await head.text()).length, 0);
});

test("a browser cannot invent HSTS with Forwarded, X-Forwarded-Proto, Host or a configured site origin", async () => {
  const spoofedHeaders: Record<string, string>[] = [
    { "x-forwarded-proto": "https" }, { forwarded: "for=203.0.113.1;proto=https" },
    { "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.1", host: "secure.example.test" },
    { "x-forwarded-host": "secure.example.test", "x-forwarded-ssl": "on" },
  ];
  for (const headers of spoofedHeaders) {
    const response: Response = await fetch(web.origin + "/healthz", { headers });
    baseline(response.headers);
    assert.equal(response.headers.get("strict-transport-security"), null);
    await response.body?.cancel();
  }
});

test("only a named ingress with an intact protocol/address suffix may set HSTS, including static and error paths", async (t) => {
  const protectedWeb = await startProductionWeb({ API_BASE_URL: api.url, WEB_TRUSTED_PROXY_HOPS: "1", WEB_TRUSTED_PROXY_PEERS: `${EDGE_PEER}/32` });
  t.after(() => protectedWeb.close());
  const forwarded = { "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" };
  for (const path of ["/", "/account", "/healthz", "/favicon.png", "/%zz", "/articles/mock-upstream-failure"]) {
    const response = await callFrom(protectedWeb.origin, EDGE_PEER, path, { method: "GET", headers: forwarded });
    baseline(response.headers);
    assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000", path);
    assert.doesNotMatch(response.headers.get("strict-transport-security")!, /includeSubDomains|preload/);
  }
  for (const [peer, headers] of [
    [FIRST_CLIENT, forwarded], [EDGE_PEER, { "x-forwarded-proto": "https" }],
    [EDGE_PEER, { ...forwarded, "x-forwarded-proto": "https, http" }],
    [EDGE_PEER, { ...forwarded, "x-forwarded-proto": "https://spoof.test" }],
  ] as const) {
    const response = await callFrom(protectedWeb.origin, peer, "/", { method: "GET", headers });
    assert.equal(response.headers.get("strict-transport-security"), null);
    documentPolicy(response.headers, response.text);
  }
});

test("the built production entry never relaxes script policy when NODE_ENV is missing or mislabelled", async (t) => {
  for (const mode of ["", "development"]) {
    const unlabelled = await startProductionWeb({ API_BASE_URL: api.url, NODE_ENV: mode, WEB_TRUSTED_PROXY_HOPS: "0", WEB_TRUSTED_PROXY_PEERS: "" });
    t.after(() => unlabelled.close());
    const response = await fetch(unlabelled.origin + "/");
    assert.equal(response.status, 200);
    documentPolicy(response.headers, await response.text());
    assert.match(response.headers.get("cache-control") ?? "", /s-maxage=60/);
  }
});
