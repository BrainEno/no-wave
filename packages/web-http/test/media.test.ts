import assert from "node:assert/strict";
import test from "node:test";

import {
  MEDIA_IMMUTABLE_CACHE,
  MEDIA_MAX_BYTES,
  handleMediaUploadRequest,
  handlePublicMediaRequest,
} from "../src/media.ts";
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from "../src/policy.ts";
import { API_BASE, TOKENS, json, request, stubFetch } from "./helpers.ts";

/**
 * Media adapter contract.
 *
 * The properties under test are the ones the storage boundary depends on: the
 * object store is private (no credentials, no bucket URL and no upstream error
 * text may reach the browser), objects are content-addressed (immutable caching
 * and ETag revalidation are correct), and both directions are bounded so a
 * storage outage cannot turn into an unbounded buffer in the web process.
 */

const MEDIA_ID = "3f7c1d90-8a2b-4c1e-9f3a-6c5b2e8d1a44";
const SHA256_ETAG = `"${"a".repeat(64)}"`;
const WEBP = new Uint8Array(new ArrayBuffer(12));
WEBP.set([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);

function mediaResponse(bytes: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}): Response {
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": "image/webp", "content-length": String(bytes.byteLength), etag: SHA256_ETAG, ...headers },
  });
}

function publicRequest(headers: Record<string, string> = {}): Request {
  return new Request(`https://no-wave.test/api/media/${MEDIA_ID}`, { method: "GET", headers });
}

test("a stored object is relayed with immutable caching, its ETag and a locked-down content type", async () => {
  const stub = stubFetch({ "api/v1/media/": () => mediaResponse(WEBP) });
  const response = await handlePublicMediaRequest(publicRequest(), MEDIA_ID, {
    apiBaseUrl: API_BASE,
    fetchImpl: stub.fetchImpl,
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/webp");
  assert.equal(response.headers.get("cache-control"), MEDIA_IMMUTABLE_CACHE);
  assert.equal(response.headers.get("etag"), SHA256_ETAG);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assert.equal(response.headers.get("content-length"), String(WEBP.byteLength));
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), WEBP);
  // Only the normalized type may pass through; anything else is octet-stream.
  const other = stubFetch({ "api/v1/media/": () => mediaResponse(WEBP, { "content-type": "text/html" }) });
  const html = await handlePublicMediaRequest(publicRequest(), MEDIA_ID, {
    apiBaseUrl: API_BASE,
    fetchImpl: other.fetchImpl,
  });
  assert.equal(html.headers.get("content-type"), "application/octet-stream");
});

test("a conditional request is forwarded and a 304 is passed through with its ETag", async () => {
  const stub = stubFetch({ "api/v1/media/": () => new Response(null, { status: 304, headers: { etag: SHA256_ETAG } }) });
  const response = await handlePublicMediaRequest(publicRequest({ "if-none-match": SHA256_ETAG }), MEDIA_ID, {
    apiBaseUrl: API_BASE,
    fetchImpl: stub.fetchImpl,
  });

  assert.equal(response.status, 304);
  assert.equal(response.headers.get("etag"), SHA256_ETAG);
  assert.equal(response.headers.get("cache-control"), MEDIA_IMMUTABLE_CACHE);
  assert.equal(new Headers(stub.calls[0]?.init?.headers).get("if-none-match"), SHA256_ETAG);

  // A malformed ETag is not forwarded rather than being echoed into the cache key.
  const strict = stubFetch({ "api/v1/media/": () => mediaResponse(WEBP) });
  await handlePublicMediaRequest(publicRequest({ "if-none-match": "\"not-a-hash\"" }), MEDIA_ID, {
    apiBaseUrl: API_BASE,
    fetchImpl: strict.fetchImpl,
  });
  assert.equal(new Headers(strict.calls[0]?.init?.headers).get("if-none-match"), null);
});

test("an id that is not a UUID is rejected locally, without calling the API", async () => {
  const stub = stubFetch({ "api/v1/media/": () => mediaResponse(WEBP) });
  for (const id of ["not-a-uuid", "../secrets", ""]) {
    const response = await handlePublicMediaRequest(publicRequest(), id, { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
    assert.equal(response.status, 404);
    assert.match(await response.text(), /NOT_FOUND/);
  }
  assert.equal(stub.calls.length, 0);
});

test("a misconfigured or unreachable API never leaks the reason to the browser", async () => {
  const unconfigured = await handlePublicMediaRequest(publicRequest(), MEDIA_ID, { apiBaseUrl: undefined });
  assert.equal(unconfigured.status, 503);
  assert.match(await unconfigured.text(), /SERVICE_UNAVAILABLE/);

  const broken = await handlePublicMediaRequest(publicRequest(), MEDIA_ID, {
    apiBaseUrl: API_BASE,
    fetchImpl: () => Promise.reject(new Error("ECONNREFUSED 10.0.0.4:5432")),
  });
  assert.equal(broken.status, 502);
  const brokenBody = await broken.text();
  assert.match(brokenBody, /SERVICE_UNAVAILABLE/);
  assert.doesNotMatch(brokenBody, /ECONNREFUSED|10\.0\.0\.4/);
});

test("upstream failures are collapsed to 404 or 503 with no upstream text", async () => {
  const missing = stubFetch({ "api/v1/media/": () => json({ error: { code: "NOT_FOUND", message: "gone" } }, 404) });
  const notFound = await handlePublicMediaRequest(publicRequest(), MEDIA_ID, { apiBaseUrl: API_BASE, fetchImpl: missing.fetchImpl });
  assert.equal(notFound.status, 404);

  const failing = stubFetch({ "api/v1/media/": () => json({ error: { code: "S3_ERROR", message: "bucket key leaked" } }, 500) });
  const unavailable = await handlePublicMediaRequest(publicRequest(), MEDIA_ID, { apiBaseUrl: API_BASE, fetchImpl: failing.fetchImpl });
  assert.equal(unavailable.status, 503);
  const body = await unavailable.text();
  assert.match(body, /MEDIA_STORAGE_UNAVAILABLE/);
  assert.doesNotMatch(body, /bucket|S3_ERROR/);
});

test("an oversized object is abandoned, not buffered", async () => {
  const declared = stubFetch({
    "api/v1/media/": () => mediaResponse(WEBP, { "content-length": String(MEDIA_MAX_BYTES + 1) }),
  });
  const byLength = await handlePublicMediaRequest(publicRequest(), MEDIA_ID, { apiBaseUrl: API_BASE, fetchImpl: declared.fetchImpl });
  assert.equal(byLength.status, 502);
  assert.match(await byLength.text(), /exceeded the response limit/);

  // A lying content-length: the ceiling is still enforced on the bytes read.
  const lying = stubFetch({
    "api/v1/media/": () => mediaResponse(new Uint8Array(MEDIA_MAX_BYTES + 4096), { "content-length": "12" }),
  });
  const byBytes = await handlePublicMediaRequest(publicRequest(), MEDIA_ID, { apiBaseUrl: API_BASE, fetchImpl: lying.fetchImpl });
  assert.equal(byBytes.status, 502);
});

test("an upload is origin-checked and type-checked before its body is read", async () => {
  const crossOrigin = await handleMediaUploadRequest(
    new Request("https://no-wave.test/api/authoring/media", {
      method: "POST",
      headers: { origin: "https://attacker.test", "content-type": "image/png" },
      body: new Uint8Array(new ArrayBuffer(3)),
    }),
    { apiBaseUrl: API_BASE },
  );
  assert.equal(crossOrigin.status, 403);
  assert.match(await crossOrigin.text(), /ORIGIN_REJECTED/);

  const wrongType = await handleMediaUploadRequest(
    request("/api/authoring/media", { method: "POST", headers: { "content-type": "application/x-sh" }, body: "x" }),
    { apiBaseUrl: API_BASE },
  );
  assert.equal(wrongType.status, 415);
  assert.match(await wrongType.text(), /UNSUPPORTED_MEDIA_TYPE/);

  const empty = await handleMediaUploadRequest(
    request("/api/authoring/media", { method: "POST", headers: { "content-type": "image/png" } }),
    { apiBaseUrl: API_BASE },
  );
  assert.equal(empty.status, 400);
});

test("a valid upload is forwarded with the cookie-held bearer token and stays private", async () => {
  const stub = stubFetch({
    "api/v1/me/media": () => json({ data: { id: MEDIA_ID, contentType: "image/webp", byteSize: WEBP.byteLength } }, 201),
  });
  const response = await handleMediaUploadRequest(
    new Request("https://no-wave.test/api/authoring/media", {
      method: "POST",
      headers: {
        origin: "https://no-wave.test",
        "content-type": "image/png",
        cookie: `${ACCESS_TOKEN_COOKIE}=${TOKENS.accessToken}; ${REFRESH_TOKEN_COOKIE}=${TOKENS.refreshToken}`,
      },
      body: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
    }),
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );

  assert.equal(response.status, 201);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  const body = await response.text();
  assert.match(body, new RegExp(MEDIA_ID));
  const headers = new Headers(stub.calls[0]?.init?.headers);
  assert.equal(headers.get("authorization"), `Bearer ${TOKENS.accessToken}`);
  assert.equal(headers.get("content-type"), "image/png");
  assert.match(String(stub.calls[0]?.url), /api\/v1\/me\/media$/);
  // The token must never be echoed back to the browser.
  assert.doesNotMatch(body, new RegExp(TOKENS.accessToken));
});
