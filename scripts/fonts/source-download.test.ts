import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { FONT_SOURCES } from "./font-sources.ts";
import {
  downloadPinnedFontBlob,
  type FontSourceFetch,
} from "./source-download.ts";

const blob = FONT_SOURCES[0]!.blob;
const bytes = Buffer.from("immutable upstream font fixture");
const expected = createHash("sha256").update(bytes).digest("hex");
const raw =
  "https://raw.githubusercontent.com/google/fonts/cc5661d43cd4f9aad5567033a8e15ca28dc35c86/ofl/instrumentserif/InstrumentSerif-Regular.ttf";
const api = `https://api.github.com/repos/google/fonts/git/blobs/${blob}`;
const gitResponse = (change: Record<string, unknown> = {}) =>
  Response.json({
    sha: blob,
    size: bytes.length,
    encoding: "base64",
    content: bytes.toString("base64"),
    ...change,
  });

function observe(handler: FontSourceFetch) {
  const calls: Array<{ url: string; options: RequestInit }> = [];
  const request: FontSourceFetch = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options);
  };
  return { calls, request };
}

test("a cold pinned download succeeds without consuming the rate-limited Git API", async () => {
  const f = observe(async (url) =>
    url === raw ? new Response(bytes) : new Response(null, { status: 403 }),
  );
  assert.deepEqual(
    await downloadPinnedFontBlob(blob, expected, f.request),
    bytes,
  );
  assert.deepEqual(
    f.calls.map((call) => call.url),
    [raw],
  );
  assert.equal(f.calls[0]!.options.redirect, "error");
  assert.ok(f.calls[0]!.options.signal instanceof AbortSignal);
  assert.equal(
    new Headers(f.calls[0]!.options.headers).get("Authorization"),
    null,
  );
});

test("all catalog fonts and licenses resolve under the same immutable revision, never main", async () => {
  const paths = new Map([
    [FONT_SOURCES[0]!.blob, "instrumentserif/InstrumentSerif-Regular.ttf"],
    [FONT_SOURCES[1]!.blob, "instrumentserif/InstrumentSerif-Italic.ttf"],
    [FONT_SOURCES[2]!.blob, "intertight/InterTight[wght].ttf"],
    [FONT_SOURCES[3]!.blob, "notoserifsc/NotoSerifSC[wght].ttf"],
    [FONT_SOURCES[4]!.blob, "notosanssc/NotoSansSC[wght].ttf"],
    [FONT_SOURCES[0]!.licenseBlob, "instrumentserif/OFL.txt"],
    [FONT_SOURCES[2]!.licenseBlob, "intertight/OFL.txt"],
    [FONT_SOURCES[3]!.licenseBlob, "notoserifsc/OFL.txt"],
    [FONT_SOURCES[4]!.licenseBlob, "notosanssc/OFL.txt"],
  ]);
  assert.equal(paths.size, 9);
  for (const [id, path] of paths) {
    const f = observe(async () => new Response(bytes));
    await downloadPinnedFontBlob(id, expected, f.request);
    assert.equal(f.calls.length, 1);
    const url = new URL(f.calls[0]!.url);
    assert.equal(url.origin, "https://raw.githubusercontent.com");
    assert.equal(
      decodeURIComponent(url.pathname),
      `/google/fonts/cc5661d43cd4f9aad5567033a8e15ca28dc35c86/ofl/${path}`,
    );
    assert.equal(url.search + url.hash, "");
  }
});

test("a restricted-network transport failure falls back once to the exact reviewed Git blob", async () => {
  for (const status of [null, 403, 408, 429, 503]) {
    const f = observe(async (url) => {
      if (url === api) return gitResponse();
      if (status === null) throw new TypeError("network unreachable");
      return new Response(null, { status });
    });
    assert.deepEqual(
      await downloadPinnedFontBlob(blob, expected, f.request),
      bytes,
    );
    assert.deepEqual(
      f.calls.map((call) => call.url),
      [raw, api],
    );
    for (const call of f.calls) {
      assert.equal(call.options.redirect, "error");
      assert.equal(
        new Headers(call.options.headers).get("Authorization"),
        null,
      );
      assert.ok(call.options.signal instanceof AbortSignal);
    }
  }
});

test("bad raw bytes, an empty body, a missing path or a redirect cannot silently choose other bytes", async () => {
  for (const response of [
    new Response("changed"),
    new Response(null),
    new Response(null, { status: 404 }),
    new Response(null, {
      status: 302,
      headers: { location: "https://attacker.invalid/file" },
    }),
  ]) {
    const f = observe(async (url) => (url === raw ? response : gitResponse()));
    await assert.rejects(
      downloadPinnedFontBlob(blob, expected, f.request),
      /checksum|download|empty/i,
    );
    assert.deepEqual(
      f.calls.map((call) => call.url),
      [raw],
    );
  }
});

test("advertised or streamed oversize responses are cancelled before decoding or a fallback", async () => {
  let pulls = 0;
  let cancelled = 0;
  const streamed = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel() {
        cancelled++;
      },
    }),
  );
  const advertised = new Response("small", {
    headers: { "Content-Length": String(32 * 1024 * 1024 + 1) },
  });
  for (const response of [advertised, streamed]) {
    const f = observe(async (url) => (url === raw ? response : gitResponse()));
    await assert.rejects(
      downloadPinnedFontBlob(blob, expected, f.request),
      /limit|large|size/i,
    );
    assert.deepEqual(
      f.calls.map((call) => call.url),
      [raw],
    );
  }
  assert.ok(pulls <= 35);
  assert.equal(cancelled, 1);
});

test("the bounded API fallback still rejects rate limits, false identity, malformed encoding and changed bytes", async () => {
  for (const response of [
    new Response(null, { status: 403 }),
    new Response(null, {
      status: 302,
      headers: { location: "https://attacker.invalid" },
    }),
    gitResponse({ sha: "0".repeat(40) }),
    gitResponse({ size: 1 }),
    gitResponse({ encoding: "utf-8" }),
    gitResponse({ content: "Y2hhbmdlZA==" }),
    gitResponse({ content: "" }),
    Response.json(null),
    new Response("not JSON"),
    new Response("{}", {
      headers: { "Content-Length": String(64 * 1024 * 1024) },
    }),
  ]) {
    const f = observe(async (url) =>
      url === raw ? new Response(null, { status: 403 }) : response,
    );
    await assert.rejects(downloadPinnedFontBlob(blob, expected, f.request));
    assert.deepEqual(
      f.calls.map((call) => call.url),
      [raw, api],
    );
  }
});

test("unknown blob and malformed checksum inputs fail before starting any request", async () => {
  const f = observe(async () => {
    throw new Error("must not fetch");
  });
  for (const [id, hash] of [
    ["../outside", expected],
    ["0".repeat(40), expected],
    [blob, "bad"],
    [blob, expected.toUpperCase()],
  ]) {
    await assert.rejects(
      downloadPinnedFontBlob(id!, hash!, f.request),
      /pinned|source|checksum/i,
    );
  }
  assert.equal(f.calls.length, 0);
});
