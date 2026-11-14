import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import { createBffClientAddressResolver } from "./bff-client-address.ts";
import { redactDiagnostic, secretValues } from "../../infrastructure/log-redaction.ts";

const SECRET = "fixture-client-address-signing-secret-not-for-production";
const OTHER_SECRET = "a-different-deployment-client-address-signing-secret";
const NOW = 1_800_000_000_000;
const ENV = { BFF_CLIENT_ADDRESS_SECRET: SECRET };
const TARGET = "/api/v1/articles/reading/views?locale=en";
type AddressRequest = Pick<IncomingMessage, "socket" | "headers" | "method" | "url">;
function proof(address: string, { seconds = NOW / 1000, method = "POST", target = TARGET, secret = SECRET } = {}) {
  const digest = createHmac("sha256", secret).update(JSON.stringify(["no-wave:bff-client-address:v1", seconds, method, target, address])).digest("hex");
  return `v1.${seconds}.${digest}`;
}
function request({ address = "192.0.2.7", signature = proof(address), peer = "10.40.0.2", method = "POST", target = TARGET, forwarded = "198.51.100.99" } = {}): AddressRequest {
  return { socket: { remoteAddress: peer }, method, url: target, headers: {
    "x-nw-client-address": address, "x-nw-client-address-proof": signature, "x-forwarded-for": forwarded,
  } } as unknown as AddressRequest;
}
const resolver = () => createBffClientAddressResolver(ENV, () => NOW);

test("a valid bounded BFF signature supplies one address to the API request context", () => {
  const resolve = resolver();
  assert.equal(resolve(request()), "192.0.2.7");
  assert.equal(resolve(request({ address: "2001:db8::7" })), "2001:db8::7");
  assert.equal(resolve(request({ forwarded: "198.51.100.11, 198.51.100.12" })), "192.0.2.7");
  assert.equal(resolve(request({ peer: "10.40.0.3" })), "192.0.2.7", "the proof supports isolated API replicas without guessing peer networks");
});

test("the bridge is opt-in and unsigned legacy callers retain their existing peer policy", () => {
  const direct = createBffClientAddressResolver({});
  assert.equal(direct(request()), "10.40.0.2");
  assert.equal(direct(request({ address: "203.0.113.1" })), "10.40.0.2");
  const legacyProxy = createBffClientAddressResolver({ TRUSTED_PROXY_HOPS: "1" });
  assert.equal(legacyProxy(request()), "198.51.100.99");
  assert.equal(legacyProxy(request({ forwarded: "198.51.100.10, 198.51.100.11" })), "198.51.100.11");
  assert.equal(direct(request({ peer: "::ffff:192.0.2.5" })), "192.0.2.5");
});

test("without a proof direct callers cannot select their bucket even if all other IP headers agree", () => {
  const resolve = resolver();
  for (const address of ["192.0.2.7", "203.0.113.8", "2001:db8::9"]) {
    const req = request({ address });
    delete req.headers["x-nw-client-address-proof"];
    req.headers["x-real-ip"] = address;
    req.headers.forwarded = `for=${address}`;
    assert.equal(resolve(req), "10.40.0.2");
    req.headers["x-nw-client-address-proof"] = "v1.1800000000.invalid";
    assert.equal(resolve(req), "10.40.0.2");
  }
});

test("a signature cannot be moved to a different address, method, path or query", () => {
  const resolve = resolver();
  const captured = proof("192.0.2.7");
  assert.equal(resolve(request({ signature: captured })), "192.0.2.7");
  const variants = [
    request({ address: "192.0.2.8", signature: captured }),
    request({ method: "GET", signature: captured }),
    request({ target: "/api/v1/articles/another/views?locale=en", signature: captured }),
    request({ target: "/api/v1/articles/reading/views?locale=zh-CN", signature: captured }),
    request({ target: "/api/v1/articles/reading/views?locale=en&extra=1", signature: captured }),
    request({ target: "https://api.example.test" + TARGET, signature: captured }),
  ];
  for (const variant of variants) assert.equal(resolve(variant), "10.40.0.2");
  assert.equal(resolve(request({ signature: proof("192.0.2.7", { secret: OTHER_SECRET }) })), "10.40.0.2");
});

test("proofs have a narrow clock-skew window rather than becoming permanent IP credentials", () => {
  const resolve = resolver();
  for (const delta of [-30, -1, 0, 1, 30]) {
    const seconds = NOW / 1000 + delta;
    assert.equal(resolve(request({ signature: proof("192.0.2.7", { seconds }) })), "192.0.2.7");
  }
  for (const delta of [-31, 31, -3600, 3600]) {
    const seconds = NOW / 1000 + delta;
    assert.equal(resolve(request({ signature: proof("192.0.2.7", { seconds }) })), "10.40.0.2");
  }
  const later = createBffClientAddressResolver(ENV, () => NOW + 31_000);
  assert.equal(later(request()), "10.40.0.2");
});

test("malformed versions, lengths and encodings fail closed before any timing-safe comparison", () => {
  const resolve = resolver();
  const original = proof("192.0.2.7");
  const malformed = ["", "v2" + original.slice(2), original + "a", original.slice(0, -1), original.toUpperCase(),
    "v1.NaN." + "a".repeat(64), "v1.1800000000.5." + "a".repeat(64), "v1.-1800000000." + "a".repeat(64),
    "v1.01800000000." + "a".repeat(64), "v1.9007199254740992." + "a".repeat(64), original + ", " + original, "a".repeat(10000)];
  for (const signature of malformed) {
    assert.doesNotThrow(() => resolve(request({ signature })));
    assert.equal(resolve(request({ signature })), "10.40.0.2");
  }
});

test("duplicate private headers are not two opportunities to present one good proof", () => {
  const resolve = resolver();
  const duplicateAddress = request();
  duplicateAddress.headers["x-nw-client-address"] = ["192.0.2.7", "192.0.2.8"];
  assert.equal(resolve(duplicateAddress), "10.40.0.2");
  const duplicateProof = request();
  duplicateProof.headers["x-nw-client-address-proof"] = [proof("192.0.2.7"), proof("192.0.2.7")];
  assert.equal(resolve(duplicateProof), "10.40.0.2");
  const joinedAddress = request({ address: "192.0.2.7, 192.0.2.8" });
  assert.equal(resolve(joinedAddress), "10.40.0.2");
});

test("even a signed claim needs a canonical IP and never accepts padding, ports or control text", () => {
  const resolve = resolver();
  for (const address of ["", "unknown", "example.test", " 192.0.2.7", "192.0.2.7 ", "192.0.2.7:1234", "[2001:db8::7]:443", "2001:0DB8:0:0::7", "::ffff:192.0.2.7", "fe80::1%eth0", "192.0.2.7\u0000suffix", "a".repeat(10000)]) {
    assert.equal(resolve(request({ address })), "10.40.0.2", address.slice(0, 35));
  }
  assert.equal(resolve(request({ address: "2001:db8::7" })), "2001:db8::7");
  assert.equal(resolve(request({ address: "192.0.2.7" })), "192.0.2.7");
});

test("invalid proofs cannot be rescued by legacy hop trust when the signed bridge is configured", () => {
  assert.throws(() => createBffClientAddressResolver({ ...ENV, TRUSTED_PROXY_HOPS: "1" }), /TRUSTED_PROXY_HOPS/);
  assert.throws(() => createBffClientAddressResolver({ ...ENV, TRUSTED_PROXY_HOPS: "2" }), /TRUSTED_PROXY_HOPS/);
  const resolve = createBffClientAddressResolver({ ...ENV, TRUSTED_PROXY_HOPS: "0" }, () => NOW);
  const missing = request();
  delete missing.headers["x-nw-client-address"];
  assert.equal(resolve(missing), "10.40.0.2");
  assert.equal(resolve(request({ signature: "invalid", forwarded: "192.0.2.7" })), "10.40.0.2");
});

test("unknown transport identity stays one shared unknown bucket instead of trusting a forged fallback", () => {
  const resolve = resolver();
  const missing = request({ signature: "invalid", peer: "" });
  assert.equal(resolve(missing), "unknown");
  const valid = request({ peer: "" });
  assert.equal(resolve(valid), "192.0.2.7", "a verified BFF is the authority, not the intermediary socket string");
  missing.headers["x-forwarded-for"] = "192.0.2.8";
  assert.equal(resolve(missing), "unknown");
});

test("a configured signing secret is validated at startup and included in diagnostic redaction", () => {
  for (const secret of ["short", ` ${SECRET}`, `${SECRET}\n`, "字".repeat(40), "s".repeat(513)]) {
    assert.throws(() => createBffClientAddressResolver({ BFF_CLIENT_ADDRESS_SECRET: secret }), (error: unknown) => {
      assert.ok(error instanceof RangeError);
      assert.match(error.message, /BFF_CLIENT_ADDRESS_SECRET/);
      assert.equal(error.message.includes(secret), false);
      return true;
    });
  }
  const secrets = secretValues(ENV);
  assert.ok(secrets.includes(SECRET));
  const diagnostic = redactDiagnostic(`failed with ${SECRET}`, { secrets });
  assert.equal(diagnostic, "failed with <redacted>");
  assert.equal(createBffClientAddressResolver({ BFF_CLIENT_ADDRESS_SECRET: "" })(request()), "10.40.0.2");
});

test("an unusable verifier clock cannot silently disable proof expiry", () => {
  let now = NaN;
  const resolve = createBffClientAddressResolver(ENV, () => now);
  const signedRequest = request();
  assert.equal(resolve(signedRequest), "10.40.0.2", "NaN must not make every skew comparison false and accept an arbitrary-age proof");
  now = NOW;
  assert.equal(resolve(signedRequest), "192.0.2.7");
  for (const unusable of [NaN, Infinity, -Infinity, 0, -1000]) {
    now = unusable;
    assert.doesNotThrow(() => resolve(signedRequest));
    assert.equal(resolve(signedRequest), "10.40.0.2");
  }
});
