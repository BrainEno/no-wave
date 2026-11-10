import assert from "node:assert/strict";
import test from "node:test";
import { fetchNotionImage, isTrustedNotionImageUrl, NOTION_IMAGE_MAX_BYTES } from "./notion-image-fetch.ts";

const good = "https://prod-files-secure.s3.us-west-2.amazonaws.com/file?signature=secret";

test("only the known HTTPS Notion file bucket is eligible", () => {
  for (const url of [good, "https://prod-files-secure.s3.amazonaws.com/file"]) assert.equal(isTrustedNotionImageUrl(url), true);
  for (const url of ["http://prod-files-secure.s3.amazonaws.com/file", "https://prod-files-secure.s3.amazonaws.com.evil.test/file", "https://127.0.0.1/file", "https://user@prod-files-secure.s3.amazonaws.com/file", "https://prod-files-secure.s3.amazonaws.com:444/file", "https://prod-files-secure.s3.amazonaws.com/file#x"]) assert.equal(isTrustedNotionImageUrl(url), false, url);
});

test("downloads bytes without following redirects and never discloses signed URLs in errors", async () => {
  let redirect: RequestRedirect | undefined;
  const success: typeof fetch = async (_url, init) => {
    redirect = init?.redirect;
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
  };
  const result = await fetchNotionImage(good, success);
  assert.deepEqual(result, { ok: true, bytes: Buffer.from([1, 2, 3]), contentType: "image/png" });
  assert.equal(redirect, "manual");
  const rejected = await fetchNotionImage(good, async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1" } }));
  assert.equal(rejected.ok, false);
  assert.doesNotMatch(JSON.stringify(rejected), /secret/);
});

test("bounds the actual body and rejects unsupported image types", async () => {
  const tooLarge = await fetchNotionImage(good, async () => new Response(new Uint8Array(NOTION_IMAGE_MAX_BYTES + 1), { headers: { "content-type": "image/png", "content-length": "1" } }));
  assert.equal(tooLarge.ok, false);
  const html = await fetchNotionImage(good, async () => new Response("not an image", { headers: { "content-type": "text/html" } }));
  assert.equal(html.ok, false);
});

test("untrusted URLs never reach the network, and network errors are sanitized", async () => {
  let calls = 0;
  const unreachable: typeof fetch = async () => { calls++; throw new Error(`secret ${good}`); };
  const rejected = await fetchNotionImage("https://127.0.0.1/internal", unreachable);
  assert.equal(rejected.ok, false);
  assert.equal(calls, 0);
  const failed = await fetchNotionImage(good, unreachable);
  assert.equal(calls, 1);
  assert.equal(failed.ok, false);
  assert.doesNotMatch(JSON.stringify(failed), /secret|amazonaws/);
});
