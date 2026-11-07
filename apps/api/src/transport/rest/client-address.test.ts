import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import {
  DEFAULT_TRUSTED_PROXY_HOPS,
  MAXIMUM_TRUSTED_PROXY_HOPS,
  clientAddressFor,
  resolveTrustedProxyHops,
} from "./client-address.ts";

/**
 * Who a request is charged to (audit F-21).
 *
 * The API used the socket peer and ignored `X-Forwarded-For`, which is right when
 * the process sees the visitor and wrong on every deployment that puts a proxy in
 * front of it — there every visitor shares one bucket, so the per-IP limits stop
 * being per-IP. Blindly trusting the header is not the fix either: that lets a
 * client mint a fresh bucket per request.
 *
 * These tests pin the middle: the header is read only as far from the right as
 * the operator says there are proxies, and nothing a client writes to its left can
 * move that position.
 */

/** Just enough of an `IncomingMessage` for the resolver. */
function request({ peer = "192.0.2.1", forwarded }: { peer?: string | null; forwarded?: string | string[] } = {}) {
  return {
    headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded },
    socket: { remoteAddress: peer ?? undefined },
  } as unknown as Pick<IncomingMessage, "headers" | "socket">;
}

test("with no proxy configured the socket peer is the client, and the header is ignored", () => {
  assert.equal(DEFAULT_TRUSTED_PROXY_HOPS, 0);
  assert.equal(clientAddressFor(request({ forwarded: "203.0.113.7" })), "192.0.2.1");
  assert.equal(clientAddressFor(request({ forwarded: "203.0.113.7" }), 0), "192.0.2.1");
  // A client that names itself cannot choose its bucket by naming a new one.
  assert.equal(clientAddressFor(request({ forwarded: "203.0.113.8" })), "192.0.2.1");
});

test("one trusted proxy takes the address that proxy appended, not the one before it", () => {
  // Behind one proxy the header has exactly one entry; a client-written entry in
  // front of it must not win.
  assert.equal(clientAddressFor(request({ forwarded: "203.0.113.7" }), 1), "203.0.113.7");
  assert.equal(clientAddressFor(request({ forwarded: "10.0.0.9, 203.0.113.7" }), 1), "203.0.113.7");
  assert.equal(
    clientAddressFor(request({ forwarded: "198.51.100.1, 198.51.100.2, 203.0.113.7" }), 1),
    "203.0.113.7",
    "only the last entry was written by the proxy we named",
  );
});

test("two trusted proxies take the entry before the last one", () => {
  // client → cdn → ingress → api: the header is "client, cdn", and the ingress
  // appended the CDN. With two named proxies the client is the first entry.
  assert.equal(clientAddressFor(request({ forwarded: "203.0.113.7, 10.0.0.2" }), 2), "203.0.113.7");
  assert.equal(
    clientAddressFor(request({ forwarded: "203.0.113.7, 10.0.0.2, 10.0.0.3" }), 2),
    "10.0.0.2",
    "the second-from-the-right entry is the one the outermost named proxy appended",
  );
});

test("a chain shorter than the configuration is not trusted, and falls back to the peer", () => {
  // Two proxies were configured but the request arrived with one entry: this is
  // not the deployment the operator described, so guessing is the wrong move.
  assert.equal(clientAddressFor(request({ forwarded: "203.0.113.7" }), 2), "192.0.2.1");
  assert.equal(clientAddressFor(request({}), 1), "192.0.2.1");
  assert.equal(clientAddressFor(request({ forwarded: "   " }), 1), "192.0.2.1");
});

test("a header entry that is not an address falls back to the peer", () => {
  for (const forwarded of ["not-an-address", "evil.example", "999.1.1.1", "1.2.3.4.5", ""]) {
    assert.equal(clientAddressFor(request({ forwarded }), 1), "192.0.2.1", JSON.stringify(forwarded));
  }
});

test("the same client is one bucket whether the address is plain or IPv4-mapped", () => {
  assert.equal(clientAddressFor(request({ peer: "::ffff:192.0.2.1" })), "192.0.2.1");
  assert.equal(clientAddressFor(request({ forwarded: "::ffff:203.0.113.7" }), 1), "203.0.113.7");
  // A source port appended by a proxy is not part of the address.
  assert.equal(clientAddressFor(request({ forwarded: "203.0.113.7:51234" }), 1), "203.0.113.7");
  assert.equal(clientAddressFor(request({ forwarded: "[2001:db8::1]:443" }), 1), "2001:db8::1");
  assert.equal(clientAddressFor(request({ forwarded: "2001:db8::1" }), 1), "2001:db8::1");
});

test("duplicate X-Forwarded-For headers are read as one chain", () => {
  assert.equal(clientAddressFor(request({ forwarded: ["203.0.113.7", "10.0.0.2"] }), 2), "203.0.113.7");
  assert.equal(clientAddressFor(request({ forwarded: ["203.0.113.7", "10.0.0.2"] }), 1), "10.0.0.2");
});

test("a request with no address at all charges one honest shared bucket", () => {
  assert.equal(clientAddressFor(request({ peer: null })), "unknown");
  assert.equal(clientAddressFor(request({ peer: "" })), "unknown");
});

test("an invalid configured hop count is a startup error, never a silent default", () => {
  assert.equal(resolveTrustedProxyHops({}), 0);
  assert.equal(resolveTrustedProxyHops({ TRUSTED_PROXY_HOPS: "" }), 0);
  assert.equal(resolveTrustedProxyHops({ TRUSTED_PROXY_HOPS: "0" }), 0);
  assert.equal(resolveTrustedProxyHops({ TRUSTED_PROXY_HOPS: "2" }), 2);
  assert.equal(resolveTrustedProxyHops({ TRUSTED_PROXY_HOPS: String(MAXIMUM_TRUSTED_PROXY_HOPS) }), MAXIMUM_TRUSTED_PROXY_HOPS);
  for (const raw of ["-1", "1.5", "true", "6", "ten", " "]) {
    if (raw === " ") continue; // an empty value is "not configured", tested above
    assert.throws(
      () => resolveTrustedProxyHops({ TRUSTED_PROXY_HOPS: raw }),
      (error: unknown) => error instanceof RangeError && /TRUSTED_PROXY_HOPS/.test((error as Error).message),
      raw,
    );
  }
});
