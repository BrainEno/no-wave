import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { createAuthContext, verifyBearerToken } from "./authentication.mjs";

const env = {
  AUTH_JWT_SECRET: "test-only-secret-that-is-at-least-32-bytes",
  AUTH_JWT_ISSUER: "https://auth.example.test",
  AUTH_JWT_AUDIENCE: "bot-thk-api",
};
const now = 1_800_000_000;

function token(claims = {}, header = { alg: "HS256", typ: "JWT" }, secret = env.AUTH_JWT_SECRET) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode(header)}.${encode(claims)}`;
  const signature = createHmac("sha256", secret).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

const validClaims = {
  sub: "user-123",
  iss: env.AUTH_JWT_ISSUER,
  aud: env.AUTH_JWT_AUDIENCE,
  exp: now + 60,
  jti: "session-123",
};

function requestWithToken(value) {
  return new Request("http://localhost/graphql", {
    headers: value ? { authorization: `Bearer ${value}` } : {},
  });
}

test("accepts a correctly signed JWT with issuer, audience, expiry, and subject", () => {
  assert.deepEqual(verifyBearerToken(requestWithToken(token(validClaims)), env, now), { id: "user-123", sessionId: "session-123", sessionExpiresAt: now + 60 });
});

test("accepts an audience array containing the configured API audience", () => {
  const claims = { ...validClaims, aud: ["another-api", env.AUTH_JWT_AUDIENCE] };
  assert.deepEqual(verifyBearerToken(requestWithToken(token(claims)), env, now), { id: "user-123", sessionId: "session-123", sessionExpiresAt: now + 60 });
});

test("rejects missing bearer token and does not trust client identity headers", () => {
  assert.equal(verifyBearerToken(requestWithToken(null), env, now), null);
  const request = new Request("http://localhost/graphql", {
    headers: { "x-user-id": "attacker", authorization: "Bearer invalid" },
  });
  assert.equal(createAuthContext(request, env).user, null);
});

test("rejects oversized bearer token input before parsing", () => {
  const oversized = "a".repeat(8193);
  assert.equal(verifyBearerToken(requestWithToken(oversized), env, now), null);
});

test("rejects invalid signature, unsupported algorithm, expired token, and wrong claims", () => {
  assert.equal(verifyBearerToken(requestWithToken(token(validClaims, undefined, "attacker-secret")), env, now), null);
  assert.equal(verifyBearerToken(requestWithToken(token(validClaims, { alg: "none" })), env, now), null);
  assert.equal(verifyBearerToken(requestWithToken(token({ ...validClaims, exp: now })), env, now), null);
  assert.equal(verifyBearerToken(requestWithToken(token({ ...validClaims, iss: "https://evil.example" })), env, now), null);
  assert.equal(verifyBearerToken(requestWithToken(token({ ...validClaims, aud: "other-api" })), env, now), null);
  assert.equal(verifyBearerToken(requestWithToken(token({ ...validClaims, sub: "" })), env, now), null);
  assert.equal(verifyBearerToken(requestWithToken(token({ ...validClaims, sub: " user-123 " })), env, now), null);
  const { jti: _jti, ...withoutSessionId } = validClaims;
  assert.equal(verifyBearerToken(requestWithToken(token(withoutSessionId)), env, now), null);
  assert.equal(verifyBearerToken(requestWithToken(token({ ...validClaims, jti: " session-123 " })), env, now), null);
});

test("rejects tokens that are not active yet, malformed not-before claims, and missing expiration", () => {
  assert.equal(verifyBearerToken(requestWithToken(token({ ...validClaims, nbf: now + 1 })), env, now), null);
  assert.equal(verifyBearerToken(requestWithToken(token({ ...validClaims, nbf: "soon" })), env, now), null);
  const { exp: _exp, ...withoutExpiry } = validClaims;
  assert.equal(verifyBearerToken(requestWithToken(token(withoutExpiry)), env, now), null);
});

test("rejects the observed legacy token shape until an explicit issuer migration is complete", () => {
  const legacyClaims = {
    _id: "legacy-user-id",
    name: "legacy-user",
    username: "legacy-user",
    tokenVersion: 0,
    role: "0",
    exp: now + 60,
  };
  assert.equal(verifyBearerToken(requestWithToken(token(legacyClaims)), env, now), null);
});

test("fails clearly when configured secret is too short or issuer/audience are missing", () => {
  assert.throws(
    () => verifyBearerToken(requestWithToken(token(validClaims)), { ...env, AUTH_JWT_SECRET: "short" }, now),
    /at least 32 bytes/,
  );
  assert.throws(
    () => verifyBearerToken(requestWithToken(token(validClaims)), { AUTH_JWT_SECRET: env.AUTH_JWT_SECRET }, now),
    /ISSUER and AUTH_JWT_AUDIENCE are required/,
  );
});
