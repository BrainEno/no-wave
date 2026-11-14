import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createWebClientAddressBridge, currentWebRequestIsSecure, upstreamClientAddressHeaders } from "../src/client-address.node.ts";

type NativeRequest = Parameters<ReturnType<typeof createWebClientAddressBridge>["isSecure"]>[0];
function request(peer: string, headers: IncomingMessage["headers"] = {}, encrypted = false): NativeRequest {
  return { socket: { remoteAddress: peer, encrypted }, headers };
}
const policy = (hops = "1") => createWebClientAddressBridge({ WEB_TRUSTED_PROXY_HOPS: hops, WEB_TRUSTED_PROXY_PEERS: "10.40.0.0/24,2001:db8:40::/48" });
const directHeaders = { "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" };

test("native TLS is authoritative without proxy trust, while browser-origin claims never are", () => {
  const bridge = createWebClientAddressBridge({});
  assert.equal(bridge.enabled, false);
  assert.equal(bridge.isSecure(request("203.0.113.9", {}, true)), true);
  assert.equal(bridge.isSecure(request("203.0.113.9", { "x-forwarded-proto": "http" }, true)), true);
  for (const headers of [directHeaders, { forwarded: "proto=https;for=203.0.113.9" }, { host: "https.example.test", "x-forwarded-ssl": "on" }]) {
    assert.equal(bridge.isSecure(request("203.0.113.9", headers)), false);
  }
  assert.equal(currentWebRequestIsSecure(), false, "no ambient request means no transport authority");
});

test("a named single-hop ingress needs both complete address and protocol evidence", () => {
  const bridge = policy();
  assert.equal(bridge.isSecure(request("10.40.0.1", directHeaders)), true);
  assert.equal(bridge.isSecure(request("::ffff:10.40.0.1", directHeaders)), true);
  assert.equal(bridge.isSecure(request("2001:db8:40::2", directHeaders)), true);
  assert.equal(bridge.isSecure(request("10.41.0.1", directHeaders)), false);
  assert.equal(bridge.isSecure(request("2001:db8:41::2", directHeaders)), false);
  assert.equal(bridge.isSecure(request("10.40.0.1", { "x-forwarded-proto": "https" })), false);
  assert.equal(bridge.isSecure(request("10.40.0.1", { "x-forwarded-for": "203.0.113.9" })), false);
  assert.equal(bridge.isSecure(request("10.40.0.1", { ...directHeaders, "x-forwarded-proto": "  HTTPS " })), true);
  assert.equal(bridge.isSecure(request("10.40.0.1", { ...directHeaders, "x-forwarded-proto": "http" }, true)), false, "a proxy's internal TLS hop is not the visitor's transport");
});

test("untrusted prefixes cannot choose HSTS or repair an incomplete trusted suffix", () => {
  const bridge = policy();
  assert.equal(bridge.isSecure(request("10.40.0.1", { "x-forwarded-for": "forged-prefix,203.0.113.9", "x-forwarded-proto": "https,http" })), false);
  assert.equal(bridge.isSecure(request("10.40.0.1", { "x-forwarded-for": "forged-prefix,203.0.113.9", "x-forwarded-proto": "junk,https" })), true);
  const two = policy("2");
  const chain = { "x-forwarded-for": "203.0.113.9,10.40.0.2", "x-forwarded-proto": "https,http" };
  assert.equal(two.isSecure(request("10.40.0.1", chain)), true);
  assert.equal(two.isSecure(request("10.40.0.1", { ...chain, "x-forwarded-proto": "http,https" })), false);
  assert.equal(two.isSecure(request("10.40.0.1", { ...chain, "x-forwarded-for": "203.0.113.9,192.0.2.2" })), false);
  assert.equal(two.isSecure(request("10.40.0.1", { ...chain, "x-forwarded-for": "203.0.113.9" })), false);
  assert.equal(two.isSecure(request("10.40.0.1", { ...chain, "x-forwarded-proto": "https" })), false);
  assert.equal(two.isSecure(request("10.40.0.1", { "x-forwarded-for": "untrusted,203.0.113.9,10.40.0.2", "x-forwarded-proto": "forged,https,http" })), true);
});

test("malformed, duplicated, oversized or non-HTTP protocol evidence fails closed", () => {
  const bridge = policy();
  for (const protocol of ["", "https:", "https://trusted.test", "wss", "https;proto=http", "https,", "https\r\nx: yes", "x".repeat(8193), ["https", "http"]]) {
    assert.equal(bridge.isSecure(request("10.40.0.1", { ...directHeaders, "x-forwarded-proto": protocol })), false);
  }
  for (const address of ["", "unknown", "203.0.113.999", "[fe80::1%eth0]", "203.0.113.9,", "x".repeat(8193)]) {
    assert.equal(bridge.isSecure(request("10.40.0.1", { ...directHeaders, "x-forwarded-for": address })), false);
  }
  assert.equal(bridge.isSecure(request("10.40.0.1", { ...directHeaders, forwarded: "proto=https", "x-forwarded-proto": "http" })), false);
});

test("TLS context works even when client-address signing is disabled and survives asynchronous SSR", async () => {
  const bridge = policy();
  assert.equal(bridge.enabled, false);
  await bridge.run(request("10.40.0.1", directHeaders), async () => {
    assert.equal(currentWebRequestIsSecure(), true);
    assert.deepEqual(upstreamClientAddressHeaders("https://api.example.test/api/v1/articles", "GET"), {});
    await delay(2);
    assert.equal(currentWebRequestIsSecure(), true);
  });
  assert.equal(currentWebRequestIsSecure(), false);
});

test("nested HTTP and untrusted ingresses shadow HTTPS instead of inheriting another request's authority", async () => {
  const secure = policy(), direct = createWebClientAddressBridge({});
  await secure.run(request("10.40.0.1", directHeaders), async () => {
    assert.equal(currentWebRequestIsSecure(), true);
    await direct.run(request("203.0.113.9", directHeaders), async () => {
      await delay(1);
      assert.equal(currentWebRequestIsSecure(), false);
    });
    assert.equal(currentWebRequestIsSecure(), true);
    secure.run(request("10.41.0.1", directHeaders), () => assert.equal(currentWebRequestIsSecure(), false));
    assert.equal(currentWebRequestIsSecure(), true);
  });
  assert.equal(currentWebRequestIsSecure(), false);
});

test("parallel native, trusted-proxy and forged requests do not leak TLS authority or attribution", async () => {
  const bridge = createWebClientAddressBridge({ WEB_TRUSTED_PROXY_HOPS: "1", WEB_TRUSTED_PROXY_PEERS: "10.40.0.0/24",
    BFF_CLIENT_ADDRESS_SECRET: "fixture-only-transport-proof-secret-at-least-32-characters" });
  const results = await Promise.all(Array.from({ length: 18 }, async (_, index) => {
    const secure = index % 3 !== 2;
    const native = index % 3 === 0;
    const input = native ? request("203.0.113.8", {}, true) : request(index % 3 === 1 ? "10.40.0.1" : "192.0.2.1", directHeaders);
    return bridge.run(input, async () => {
      const before = upstreamClientAddressHeaders("https://api.example.test/api/v1/articles", "GET");
      await delay(index % 4);
      assert.equal(currentWebRequestIsSecure(), secure);
      assert.deepEqual(upstreamClientAddressHeaders("https://api.example.test/api/v1/articles", "GET"), before);
      assert.equal(before["x-nw-client-address"], native ? "203.0.113.8" : index % 3 === 1 ? "203.0.113.9" : "192.0.2.1");
      return currentWebRequestIsSecure();
    });
  }));
  assert.equal(results.filter(Boolean).length, 12);
  assert.equal(currentWebRequestIsSecure(), false);
});
