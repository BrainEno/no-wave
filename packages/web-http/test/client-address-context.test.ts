import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import { createWebClientAddressBridge, upstreamClientAddressHeaders } from "../src/client-address.node.ts";

const SECRET = "fixture-client-address-signing-secret-not-for-production";
const ENV = { BFF_CLIENT_ADDRESS_SECRET: SECRET };
const TARGET = "https://api.example.test/api/v1/me?locale=en";
const NOW = 1_800_000_000_000;
const request = (peer: string | undefined, forwarded?: string | string[]) => ({
  socket: { remoteAddress: peer }, headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded },
}) as unknown as Pick<IncomingMessage, "socket" | "headers">;
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
function signed(address: string, method = "GET", target = "/api/v1/me?locale=en", seconds = NOW / 1000) {
  const mac = createHmac("sha256", SECRET).update(JSON.stringify(["no-wave:bff-client-address:v1", seconds, method, target, address])).digest("hex");
  return { "x-nw-client-address": address, "x-nw-client-address-proof": `v1.${seconds}.${mac}` };
}
const current = (url = TARGET, method = "GET") => Object.fromEntries(new Headers(upstreamClientAddressHeaders(url, method)));

test("no request context can mint a signed client address", () => {
  assert.deepEqual(current(), {});
  const bridge = createWebClientAddressBridge({});
  assert.equal(bridge.enabled, false);
  assert.equal(bridge.trustedProxyHops, 0);
  assert.deepEqual(bridge.run(request("192.0.2.7", "203.0.113.9"), () => current()), {});
  assert.deepEqual(current(), {});
});

test("a direct visitor is charged to the socket, never a browser-written forwarding header", () => {
  const bridge = createWebClientAddressBridge(ENV, () => NOW);
  assert.equal(bridge.enabled, true);
  const headers = bridge.run(request("192.0.2.7", "203.0.113.9, 198.51.100.4"), () => current());
  assert.deepEqual(headers, signed("192.0.2.7"));
  assert.equal(Object.values(headers).some((value) => value.includes(SECRET)), false);
  assert.deepEqual(current(), {}, "the address is scoped to one asynchronous request, not a module-wide visitor");
});

test("signatures bind method, path, exact query and protocol version without sending the secret", () => {
  const bridge = createWebClientAddressBridge(ENV, () => NOW);
  bridge.run(request("192.0.2.7"), () => {
    const read = current();
    const write = current(TARGET, "POST");
    const query = current("https://api.example.test/api/v1/me?locale=zh-CN");
    const path = current("https://api.example.test/api/v1/me/sessions?locale=en");
    assert.deepEqual(read, signed("192.0.2.7"));
    assert.deepEqual(write, signed("192.0.2.7", "POST"));
    assert.notEqual(read["x-nw-client-address-proof"], write["x-nw-client-address-proof"]);
    assert.notEqual(read["x-nw-client-address-proof"], query["x-nw-client-address-proof"]);
    assert.notEqual(read["x-nw-client-address-proof"], path["x-nw-client-address-proof"]);
    assert.equal(read["x-nw-client-address"], "192.0.2.7");
  });
});

test("the signing timestamp is regenerated for each upstream call, including refresh and retry", () => {
  let now = NOW;
  const bridge = createWebClientAddressBridge(ENV, () => now);
  bridge.run(request("192.0.2.7"), () => {
    assert.deepEqual(current(), signed("192.0.2.7"));
    now += 2000;
    const refreshed = current("https://api.example.test/api/v1/auth/refresh", "POST");
    assert.deepEqual(refreshed, signed("192.0.2.7", "POST", "/api/v1/auth/refresh", NOW / 1000 + 2));
    now += 2000;
    assert.deepEqual(current(), signed("192.0.2.7", "GET", "/api/v1/me?locale=en", NOW / 1000 + 4));
  });
});

test("proxy hops require named network peers rather than making all direct callers trusted", () => {
  assert.throws(() => createWebClientAddressBridge({ ...ENV, WEB_TRUSTED_PROXY_HOPS: "1" }), /WEB_TRUSTED_PROXY_PEERS/);
  const bridge = createWebClientAddressBridge({ ...ENV, WEB_TRUSTED_PROXY_HOPS: "1", WEB_TRUSTED_PROXY_PEERS: "10.40.0.0/16" }, () => NOW);
  const throughProxy = bridge.run(request("10.40.2.3", "198.51.100.1, 192.0.2.7"), () => current());
  assert.deepEqual(throughProxy, signed("192.0.2.7"));
  const bypassing = bridge.run(request("203.0.113.6", "192.0.2.99"), () => current());
  assert.deepEqual(bypassing, signed("203.0.113.6"));
  assert.equal(bridge.trustedProxyHops, 1);
});

test("two named proxy hops select from the right and ignore arbitrary left-hand claims", () => {
  const bridge = createWebClientAddressBridge({ ...ENV, WEB_TRUSTED_PROXY_HOPS: "2", WEB_TRUSTED_PROXY_PEERS: "10.40.0.1, 10.40.0.2" }, () => NOW);
  const plain = bridge.run(request("10.40.0.2", "192.0.2.7, 10.40.0.1"), () => current());
  const forged = bridge.run(request("10.40.0.2", "attacker.invalid, 198.51.100.4, 192.0.2.7, 10.40.0.1"), () => current());
  assert.deepEqual(plain, signed("192.0.2.7"));
  assert.deepEqual(forged, plain);
  const short = bridge.run(request("10.40.0.2", "192.0.2.7"), () => current());
  assert.deepEqual(short, signed("10.40.0.2"));
  const absent = bridge.run(request("10.40.0.2"), () => current());
  assert.deepEqual(absent, signed("10.40.0.2"));
});

test("IPv4 mapped peers, source ports and IPv6 spellings have one canonical bucket", () => {
  const direct = createWebClientAddressBridge(ENV, () => NOW);
  for (const peer of ["192.0.2.7", "::ffff:192.0.2.7", "::FFFF:c000:207"]) {
    assert.deepEqual(direct.run(request(peer), () => current()), signed("192.0.2.7"), peer);
  }
  const proxy = createWebClientAddressBridge({ ...ENV, WEB_TRUSTED_PROXY_HOPS: "1", WEB_TRUSTED_PROXY_PEERS: "2001:db8:10::/48, 10.40.0.2" }, () => NOW);
  const v6 = proxy.run(request("2001:0DB8:0010:0:0:0:0:2", "[2001:0db8::0007]:4321"), () => current());
  assert.deepEqual(v6, signed("2001:db8::7"));
  const v4 = proxy.run(request("::ffff:10.40.0.2", "192.0.2.7:34567"), () => current());
  assert.deepEqual(v4, signed("192.0.2.7"));
});

test("malformed or incomplete trusted suffixes fall back to the observed peer", () => {
  const bridge = createWebClientAddressBridge({ ...ENV, WEB_TRUSTED_PROXY_HOPS: "2", WEB_TRUSTED_PROXY_PEERS: "10.40.0.1, 10.40.0.2" }, () => NOW);
  for (const forwarded of ["192.0.2.7,", ",10.40.0.1", "192.0.2.7, invalid", "unknown, 10.40.0.1", "192.0.2.7:99999, 10.40.0.1", "[2001:db8::7]:70000, 10.40.0.1", "x".repeat(9000)]) {
    const headers = bridge.run(request("10.40.0.2", forwarded), () => current());
    assert.deepEqual(headers, signed("10.40.0.2"), forwarded.slice(0, 40));
    assert.equal(headers["x-nw-client-address"], "10.40.0.2");
  }
});

test("duplicate forwarding lines preserve the chain order rather than picking the first line", () => {
  const bridge = createWebClientAddressBridge({ ...ENV, WEB_TRUSTED_PROXY_HOPS: "2", WEB_TRUSTED_PROXY_PEERS: "10.40.0.1, 10.40.0.2" }, () => NOW);
  const headers = bridge.run(request("10.40.0.2", ["attacker.invalid, 192.0.2.7", "10.40.0.1"]), () => current());
  assert.deepEqual(headers, signed("192.0.2.7"));
  const other = bridge.run(request("10.40.0.2", ["192.0.2.7", "192.0.2.8", "10.40.0.1"]), () => current());
  assert.deepEqual(other, signed("192.0.2.8"));
});

test("missing or unusable socket identity cannot be replaced by untrusted headers", () => {
  const bridge = createWebClientAddressBridge({ ...ENV, WEB_TRUSTED_PROXY_HOPS: "1", WEB_TRUSTED_PROXY_PEERS: "10.40.0.2" }, () => NOW);
  for (const peer of [undefined, "", "not-an-address", "127.0.0.1\r\nmalicious", "fe80::1%eth0"]) {
    assert.deepEqual(bridge.run(request(peer, "192.0.2.7"), () => current()), {});
  }
  assert.deepEqual(current(), {});
});

test("a bad secret or an ambiguous ingress policy is rejected at composition without leaking values", () => {
  for (const secret of ["short", " ".repeat(40), ` ${SECRET}`, `${SECRET}\n`, "字".repeat(40), "x".repeat(513)]) {
    assert.throws(() => createWebClientAddressBridge({ BFF_CLIENT_ADDRESS_SECRET: secret }), (error: unknown) => {
      assert.ok(error instanceof RangeError);
      assert.match(error.message, /BFF_CLIENT_ADDRESS_SECRET/);
      assert.equal(error.message.includes(secret), false);
      return true;
    });
  }
  for (const hops of ["-1", "1.5", "1e0", "true", "6", "Infinity"]) {
    assert.throws(() => createWebClientAddressBridge({ ...ENV, WEB_TRUSTED_PROXY_HOPS: hops }), /WEB_TRUSTED_PROXY_HOPS/);
  }
  for (const peers of ["example.test", "0.0.0.0/0", "::/0", "192.0.2.7/33", "2001:db8::/129", "192.0.2.7,,192.0.2.8", "192.0.2.7/24/1", "fe80::1%eth0", "x".repeat(5000)]) {
    assert.throws(() => createWebClientAddressBridge({ ...ENV, WEB_TRUSTED_PROXY_HOPS: "1", WEB_TRUSTED_PROXY_PEERS: peers }), /WEB_TRUSTED_PROXY_PEERS/);
  }
});

test("asynchronous overlap, nesting and thrown failures never transfer another visitor's context", async () => {
  const bridge = createWebClientAddressBridge(ENV, () => NOW);
  const firstEntered = deferred(), secondEntered = deferred(), firstRelease = deferred(), secondRelease = deferred();
  const first = bridge.run(request("192.0.2.7"), async () => {
    firstEntered.release();
    await firstRelease.promise;
    assert.deepEqual(current(), signed("192.0.2.7"));
    await bridge.run(request("192.0.2.9"), async () => { await Promise.resolve(); assert.deepEqual(current(), signed("192.0.2.9")); });
    assert.deepEqual(current(), signed("192.0.2.7"));
    assert.throws(() => bridge.run(request("192.0.2.10"), () => { throw new Error("fixture"); }), /fixture/);
    assert.deepEqual(current(), signed("192.0.2.7"));
  });
  await firstEntered.promise;
  const second = bridge.run(request("192.0.2.8"), async () => {
    secondEntered.release();
    await secondRelease.promise;
    assert.deepEqual(current(), signed("192.0.2.8"));
  });
  await secondEntered.promise;
  assert.deepEqual(current(), {});
  firstRelease.release();
  await first;
  secondRelease.release();
  await second;
  assert.deepEqual(current(), {});
});

test("an explicitly disabled nested server scope cannot inherit another server's signed metadata", async () => {
  const enabled = createWebClientAddressBridge(ENV, () => NOW);
  const disabled = createWebClientAddressBridge({});
  await enabled.run(request("192.0.2.7"), async () => {
    assert.deepEqual(current(), signed("192.0.2.7"));
    await disabled.run(request("192.0.2.8"), async () => {
      await Promise.resolve();
      assert.deepEqual(current(), {});
    });
    assert.deepEqual(current(), signed("192.0.2.7"));
  });
  assert.deepEqual(current(), {});
});


test("every intermediate in a multi-hop suffix must be named, so a shorter ingress topology cannot mint IPs", () => {
  const bridge = createWebClientAddressBridge({ ...ENV, WEB_TRUSTED_PROXY_HOPS: "2", WEB_TRUSTED_PROXY_PEERS: "10.40.0.1, 10.40.0.2" }, () => NOW);
  const normal = bridge.run(request("10.40.0.2", "192.0.2.7, 10.40.0.1"), () => current());
  assert.deepEqual(normal, signed("192.0.2.7"));
  const oneHopAttacker = bridge.run(request("10.40.0.2", "192.0.2.99, 203.0.113.7"), () => current());
  assert.deepEqual(oneHopAttacker, signed("10.40.0.2"), "a direct caller of the last proxy is not an earlier trusted proxy");
  const forgedLeft = bridge.run(request("10.40.0.2", "198.51.100.99, 192.0.2.99, 203.0.113.7"), () => current());
  assert.deepEqual(forgedLeft, oneHopAttacker);
  const three = createWebClientAddressBridge({ ...ENV, WEB_TRUSTED_PROXY_HOPS: "3", WEB_TRUSTED_PROXY_PEERS: "10.40.0.0/24" }, () => NOW);
  assert.deepEqual(three.run(request("10.40.0.3", "192.0.2.7, 10.40.0.1, 10.40.0.2"), () => current()), signed("192.0.2.7"));
  assert.deepEqual(three.run(request("10.40.0.3", "192.0.2.7, 203.0.113.9, 10.40.0.2"), () => current()), signed("10.40.0.3"));
  assert.deepEqual(three.run(request("10.40.0.3", "192.0.2.7, 10.40.0.1, 203.0.113.9"), () => current()), signed("10.40.0.3"));
  assert.deepEqual(current(), {});
});

test("named IPv6 networks authorize only their own peers and canonical mapped IPv4 keeps IPv4 policy", () => {
  const bridge = createWebClientAddressBridge({ ...ENV, WEB_TRUSTED_PROXY_HOPS: "1", WEB_TRUSTED_PROXY_PEERS: "2001:db8:40::/48, 10.40.0.0/24" }, () => NOW);
  const trusted6 = bridge.run(request("2001:0db8:0040::2", "192.0.2.7"), () => current());
  assert.deepEqual(trusted6, signed("192.0.2.7"));
  const outside6 = bridge.run(request("2001:db8:41::2", "192.0.2.7"), () => current());
  assert.deepEqual(outside6, signed("2001:db8:41::2"));
  const mapped4 = bridge.run(request("::ffff:10.40.0.2", "[2001:db8::7]:8443"), () => current());
  assert.deepEqual(mapped4, signed("2001:db8::7"));
  const outside4 = bridge.run(request("::ffff:10.41.0.2", "192.0.2.7"), () => current());
  assert.deepEqual(outside4, signed("10.41.0.2"));
  assert.equal(Object.keys(outside4).length, 2);
});

test("invalid outbound targets or signing clocks fail without replacing the current request scope", () => {
  const bridge = createWebClientAddressBridge(ENV, () => NOW);
  bridge.run(request("192.0.2.7"), () => {
    for (const target of ["file:///api/v1/me", "ftp://api.example.test/me", "https://name:password@api.example.test/me", TARGET + "#fragment", "not-absolute"]) {
      assert.throws(() => current(target));
      assert.deepEqual(current(), signed("192.0.2.7"));
    }
    for (const method of ["get", "POST GET", "", "POST\r\nOther: value"]) {
      assert.throws(() => current(TARGET, method), /signing target/);
      assert.deepEqual(current(), signed("192.0.2.7"));
    }
  });
  for (const now of [NaN, Infinity, -1, 0, Number.MAX_SAFE_INTEGER * 2000]) {
    const invalidClock = createWebClientAddressBridge(ENV, () => now);
    assert.throws(() => invalidClock.run(request("192.0.2.7"), () => current()), /signing clock/);
    assert.deepEqual(current(), {});
  }
});
