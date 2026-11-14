import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:https";
import { Readable } from "node:stream";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { TLSSocket } from "node:tls";
import { createWebClientAddressBridge, currentWebRequestIsSecure } from "@bot-thk/web-http/client-address";
import { browserSecurityHeaders, protectHtmlResponse } from "../document-security.ts";
import { MOCK_CREDENTIALS, startMockRestApi } from "../mocks/rest-api.ts";
import { startProductionWeb } from "./support/production-web.ts";
import { call, close, listen, startTlsIngress, tlsCredentials } from "./support/tls-ingress.ts";

let credentials: Awaited<ReturnType<typeof tlsCredentials>>;
before(async () => { credentials = await tlsCredentials(); });

test("an actual verified TLS socket authorizes native HSTS through async HTML sealing without proxy headers", async () => {
  const bridge = createWebClientAddressBridge({});
  const observed: { encrypted: boolean; before: boolean; after: boolean }[] = [];
  const server = createServer(credentials, (request, response) => {
    for (const [name, value] of Object.entries(browserSecurityHeaders(bridge.isSecure(request)))) response.setHeader(name, value);
    void bridge.run(request, async () => {
      const before = currentWebRequestIsSecure();
      await delay(3);
      const secure = currentWebRequestIsSecure();
      observed.push({ encrypted: (request.socket as TLSSocket).encrypted === true, before, after: secure });
      const marker = randomBytes(24).toString("base64url");
      const html = `<html><head></head><body><p>native TLS document</p><script nonce="${marker}">window.nativeTlsBoot=true;</script></body></html>`;
      const sealed = await protectHtmlResponse(Readable.from([html]), { marker, secure, status: 200,
        signal: AbortSignal.timeout(2000), headers: new Headers({ "cache-control": "public, s-maxage=60" }) });
      response.writeHead(sealed.status, Object.fromEntries(sealed.headers));
      response.end(await sealed.text());
    }).catch(() => { response.writeHead(500); response.end(); });
  });
  try {
    const origin = await listen(server, true);
    const response = await call(origin, credentials.cert, "/", { headers: { "x-forwarded-proto": "http", forwarded: "proto=http" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cache-control"), "public, s-maxage=60");
    const digest = createHash("sha256").update("window.nativeTlsBoot=true;").digest("base64");
    assert.ok(response.headers.get("content-security-policy")!.includes(`'sha256-${digest}'`));
    assert.doesNotMatch(response.headers.get("content-security-policy")!, /nonce-|script-src[^;]*unsafe-inline/);
    assert.deepEqual(observed, [{ encrypted: true, before: true, after: true }]);
    assert.equal(currentWebRequestIsSecure(), false);
  } finally { await close(server); }
});

let api: Awaited<ReturnType<typeof startMockRestApi>>;
let web: Awaited<ReturnType<typeof startProductionWeb>>;
let ingress: Awaited<ReturnType<typeof startTlsIngress>>;
before(async () => {
  api = await startMockRestApi();
  web = await startProductionWeb({ API_BASE_URL: api.url, WEB_TRUSTED_PROXY_HOPS: "1", WEB_TRUSTED_PROXY_PEERS: "127.0.0.10/32" });
  ingress = await startTlsIngress(web.origin, credentials);
});
after(async () => { await ingress?.close(); await web?.close(); await api?.close(); });

test("real TLS termination preserves HSTS for public HTML, immutable assets and failures without contaminating HTTP", async () => {
  for (const [path, status] of [["/", 200], ["/favicon.png", 200], ["/%zz", 400], ["/articles/mock-upstream-failure", 503]] as const) {
    const tls = await call(ingress.https, credentials.cert, path, { headers: { "x-forwarded-proto": "http", "x-forwarded-for": "198.51.100.99" } });
    assert.equal(tls.status, status, path);
    assert.equal(tls.headers.get("strict-transport-security"), "max-age=31536000", path);
    assert.equal(tls.headers.get("x-frame-options"), "DENY");
    assert.equal(tls.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
    assert.match(tls.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    const plain = await call(ingress.http, credentials.cert, path, { headers: {
      "x-forwarded-proto": "https", "x-forwarded-for": "198.51.100.99", forwarded: "for=198.51.100.99;proto=https", "x-forwarded-ssl": "on",
    } });
    assert.equal(plain.status, status, path);
    assert.equal(plain.headers.get("strict-transport-security"), null, path);
    assert.equal(plain.headers.get("x-content-type-options"), "nosniff");
    assert.equal(plain.headers.get("cache-control"), tls.headers.get("cache-control"));
    if (status >= 400) assert.match(plain.headers.get("cache-control")!, /no-store/);
    if (path === "/") {
      assert.match(tls.headers.get("cache-control")!, /s-maxage=60/);
      assert.equal(plain.headers.get("content-security-policy"), tls.headers.get("content-security-policy"));
      assert.deepEqual(tls.headers.getSetCookie(), []);
    }
  }
});

test("the same real ingress keeps Secure-cookie issuance aligned with its observed browser-facing protocol", async () => {
  for (const [origin, secure] of [[ingress.https, true], [ingress.http, false]] as const) {
    const response = await call(origin, credentials.cert, "/api/auth/login", { method: "POST", body: MOCK_CREDENTIALS,
      headers: { "x-forwarded-proto": secure ? "http" : "https" } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control")!, /no-store/);
    assert.equal(response.headers.has("strict-transport-security"), secure);
    const cookies = response.headers.getSetCookie();
    assert.equal(cookies.length, 3);
    assert.ok(cookies.every(cookie => /; Secure(?:;|$)/.test(cookie) === secure));
    assert.ok(cookies.some(cookie => cookie.startsWith("nw_access=") && cookie.includes("Path=/api/authoring") && cookie.includes("HttpOnly")));
    assert.ok(cookies.some(cookie => cookie.startsWith("nw_refresh=") && cookie.includes("Path=/api;") && cookie.includes("HttpOnly")));
    assert.doesNotMatch(response.text, /mock-access-token|"refreshToken"|"accessToken"/);
  }
});
