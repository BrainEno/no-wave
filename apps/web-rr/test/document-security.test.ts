import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import { browserSecurityHeaders, DEVELOPMENT_CSP, documentContentSecurityPolicy, documentScriptHashes,
  DocumentSecurityError, MAX_DOCUMENT_BYTES, MAX_DOCUMENT_SCRIPT_HASHES, protectHtmlResponse, RESOURCE_CSP } from "../document-security.ts";

const marker = () => randomBytes(24).toString("base64url");
const hash = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
const script = (nonce: string, source: string) => `<script nonce="${nonce}">${source}</script>`;
function seal(html: string, nonce: string, headers = new Headers(), secure = false, status = 200) {
  return protectHtmlResponse(Readable.from([Buffer.from(html)]), { marker: nonce, signal: AbortSignal.timeout(2000), headers, secure, status });
}

test("only executable renderer-marked HTML scripts become hash sources", () => {
  const nonce = marker(), trusted = "window.boot = '安全';", attack = "window.injected = true;";
  const html = `<html><head>${script(nonce, trusted)}</head><body>
    <!-- ${script(nonce, attack)} -->
    <textarea>${script(nonce, attack)}</textarea>
    <title>${script(nonce, attack)}</title>
    <noscript>${script(nonce, attack)}</noscript>
    <template>${script(nonce, attack)}</template>
    <script type="application/json">{"untrusted":"data only"}</script>
    <script src="/assets/entry.js"></script>
    <svg><script nonce="${nonce}">${attack}</script></svg>
  </body></html>`;
  assert.deepEqual(documentScriptHashes(html, nonce), [hash(trusted)]);
  assert.ok(!documentContentSecurityPolicy(documentScriptHashes(html, nonce)).includes(hash(attack)));
});

test("an unmarked or differently marked executable script fails closed instead of being automatically blessed", () => {
  const nonce = marker();
  for (const untrusted of [
    "<script>attacker()</script>", `<script nonce="${marker()}">attacker()</script>`,
    `<script nonce="wrong" nonce="${nonce}">attacker()</script>`,
    '<script type="module">import("/untrusted.js")</script>',
    '<script type="importmap">{"imports":{"app":"/untrusted.js"}}</script>',
    '<script type="speculationrules">{}</script>',
  ]) {
    assert.throws(() => documentScriptHashes(script(nonce, "boot()") + untrusted, nonce),
      (error: unknown) => error instanceof DocumentSecurityError && error.code === "UNTRUSTED_INLINE_SCRIPT");
  }
  assert.throws(() => documentScriptHashes("<p>no scripts</p>", "unsafe\r\nheader"), /INVALID_RENDER_MARKER/);
});

test("HTML5 parsing respects case, quoted tag delimiters, duplicate attributes and entity-decoded provenance", () => {
  const nonce = "A".repeat(32), source = "window.value = '<not-a-tag>';";
  const html = `<ScRiPt data-note=">" NONCE="${nonce}" nonce="ignored">${source}</sCrIpT>`;
  assert.deepEqual(documentScriptHashes(html, nonce), [hash(source)]);
  assert.deepEqual(documentScriptHashes(`<script nonce="&#65;${nonce.slice(1)}">${source}</script>`, nonce), [hash(source)]);
  assert.deepEqual(documentScriptHashes(`<script type="application/ld+json">{"name":"data"}</script>`, nonce), []);
});

test("valid HTML end-tag whitespace cannot hide a following untrusted script from provenance checks", async () => {
  const nonce = marker(), source = "window.safeBoot='boundary';", attack = "window.afterEndTag=true;";
  for (const endTag of ["</script >", "</SCRIPT\t>", "</script\n>", "</script/>"]) {
    const html = `<script data-note=">" nonce="${nonce}">${source}${endTag}`;
    assert.deepEqual(documentScriptHashes(html, nonce), [hash(source)], endTag);
    const response = await seal(html, nonce);
    assert.equal(await response.text(), html, "sealing must preserve the bytes the browser parses");
    assert.ok(response.headers.get("content-security-policy")!.includes(hash(source)));
    assert.ok(!response.headers.get("content-security-policy")!.includes(hash(attack)));
    await assert.rejects(seal(`${html}<script>${attack}</script>`, nonce),
      (error: unknown) => error instanceof DocumentSecurityError && error.code === "UNTRUSTED_INLINE_SCRIPT");
  }
});

test("hashes use browser-normalized line endings, replacement characters and complete UTF-8 text", () => {
  const nonce = marker(), raw = "// 中文𠀀\r\nwindow.name='a\rb\0c';";
  assert.deepEqual(documentScriptHashes(script(nonce, raw), nonce), [hash("// 中文𠀀\nwindow.name='a\nb�c';")]);
  const a = script(nonce, "a()"), b = script(nonce, "b()");
  assert.deepEqual(documentScriptHashes(a + b + a, nonce), [hash("a()"), hash("b()")].sort());
  assert.deepEqual(documentScriptHashes(b + a, nonce), documentScriptHashes(a + b, nonce));
});

test("a cache-visible render marker never appears as a nonce-source or authorizes changed script bytes", async () => {
  const nonce = marker(), original = "window.original = true;";
  const response = await seal(script(nonce, original), nonce, new Headers({ "cache-control": "public, s-maxage=60" }));
  const policy = response.headers.get("content-security-policy")!;
  assert.ok((await response.text()).includes(nonce), "cached markup can reveal provenance safely");
  assert.ok(policy.includes(hash(original)));
  assert.ok(!policy.includes(hash("window.attacker = true;")));
  assert.ok(!policy.includes(nonce));
  assert.doesNotMatch(policy, /nonce-/);
  assert.equal(response.headers.get("cache-control"), "public, s-maxage=60");
});

test("script capabilities are strict while the documented style/image compatibility stays explicit", () => {
  const directives = new Map(documentContentSecurityPolicy([hash("boot()")]).split("; ").map(value => {
    const [name, ...sources] = value.split(" "); return [name, sources.join(" ")];
  }));
  assert.equal(directives.get("script-src"), `'self' ${hash("boot()")}`);
  assert.equal(directives.get("script-src-attr"), "'none'");
  assert.equal(directives.get("object-src"), "'none'");
  assert.equal(directives.get("frame-src"), "'none'");
  assert.equal(directives.get("frame-ancestors"), "'none'");
  assert.equal(directives.get("base-uri"), "'self'");
  assert.equal(directives.get("form-action"), "'self'");
  assert.equal(directives.get("connect-src"), "'self'");
  assert.equal(directives.get("font-src"), "'self'");
  assert.equal(directives.get("worker-src"), "'none'");
  assert.equal(directives.get("style-src"), "'self' 'unsafe-inline'");
  assert.equal(directives.get("img-src"), "'self' data: blob: https:");
  assert.doesNotMatch(directives.get("script-src")!, /unsafe-inline|unsafe-eval|\*|data:|blob:/);
  assert.doesNotMatch(documentContentSecurityPolicy([]), /localhost|ws:|report-only/i);
  assert.doesNotMatch(DEVELOPMENT_CSP, /script-src/);
});

test("invalid hash inputs and oversized hash lists cannot inject or overflow a response header", () => {
  for (const value of ["'unsafe-inline'", "'nonce-known'", "'sha256-short'", hash("x") + "; script-src *", hash("x") + "\r\nx-injected: yes"]) {
    assert.throws(() => documentContentSecurityPolicy([value]), TypeError);
  }
  assert.throws(() => documentContentSecurityPolicy(Array(MAX_DOCUMENT_SCRIPT_HASHES + 1).fill(hash("x"))), TypeError);
  const nonce = marker();
  const html = Array.from({ length: MAX_DOCUMENT_SCRIPT_HASHES + 1 }, (_, index) => script(nonce, `window.n=${index}`)).join("");
  assert.throws(() => documentScriptHashes(html, nonce), /TOO_MANY_SCRIPT_HASHES/);
  assert.deepEqual(documentScriptHashes(Array(100).fill(script(nonce, "same()")).join(""), nonce), [hash("same()")], "identical scripts spend one hash, not 100 header entries");
});

test("sealing retains status, cache, multiple cookies and Vary without exposing mutable header objects", async () => {
  const nonce = marker(), html = `<!doctype html><p>正文𠀀</p>${script(nonce, "boot()")}`;
  const headers = new Headers({ "cache-control": "no-store, max-age=0", vary: "Cookie", "x-robots-tag": "noindex",
    "content-length": "1", "strict-transport-security": "max-age=999", "content-security-policy-report-only": "script-src *" });
  headers.append("set-cookie", "fixture-a=one; HttpOnly");
  headers.append("set-cookie", "fixture-b=two; HttpOnly");
  const response = await seal(html, nonce, headers, false, 503);
  assert.equal(response.status, 503);
  assert.equal(await response.text(), html);
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.get("vary"), "Cookie");
  assert.deepEqual(response.headers.getSetCookie(), headers.getSetCookie());
  assert.equal(response.headers.get("x-robots-tag"), "noindex");
  assert.equal(response.headers.get("content-length"), null);
  assert.equal(response.headers.get("strict-transport-security"), null);
  assert.equal(response.headers.get("content-security-policy-report-only"), null);
  assert.equal(headers.get("content-length"), "1", "the caller's header object is not mutated");
  const secure = await seal(html, nonce, headers, true, 404);
  assert.equal(secure.headers.get("strict-transport-security"), "max-age=31536000");
  assert.equal(secure.status, 404);
  await secure.body?.cancel();
});

test("split UTF-8 stream chunks are collected without changing the document or its digest", async () => {
  const nonce = marker(), html = script(nonce, "window.title='中文𠀀';");
  const bytes = Buffer.from(html);
  const chunks = Array.from(bytes, value => Buffer.from([value]));
  const response = await protectHtmlResponse(Readable.from(chunks), { marker: nonce, signal: AbortSignal.timeout(2000), headers: new Headers(), status: 200, secure: false });
  assert.equal(await response.text(), html);
  assert.ok(response.headers.get("content-security-policy")!.includes(hash("window.title='中文𠀀';")));
});

test("document size is bounded before any response is returned, including a single oversized chunk", async () => {
  const nonce = marker();
  const exact = await seal("x".repeat(MAX_DOCUMENT_BYTES), nonce);
  assert.equal((await exact.arrayBuffer()).byteLength, MAX_DOCUMENT_BYTES);
  for (const chunks of [[Buffer.alloc(MAX_DOCUMENT_BYTES + 1)], [Buffer.alloc(MAX_DOCUMENT_BYTES), Buffer.from("private-canary")]]) {
    const body = Readable.from(chunks);
    await assert.rejects(protectHtmlResponse(body, { marker: nonce, signal: AbortSignal.timeout(2000), headers: new Headers(), status: 200, secure: false }),
      (error: unknown) => error instanceof DocumentSecurityError && error.code === "DOCUMENT_TOO_LARGE" && !error.message.includes("private-canary"));
    assert.equal(body.destroyed, true);
  }
});

test("a stalled or already-aborted document cannot outlive its rendering budget", async () => {
  for (const alreadyAborted of [false, true]) {
    const controller = new AbortController(), body = new PassThrough();
    if (alreadyAborted) controller.abort();
    const result = protectHtmlResponse(body, { marker: marker(), signal: controller.signal, headers: new Headers(), status: 200, secure: false });
    body.write("<p>partial, never committed</p>");
    if (!alreadyAborted) controller.abort();
    await assert.rejects(result, (error: unknown) => error instanceof Error && error.name === "AbortError");
    assert.equal(body.destroyed, true);
  }
});

test("producer failures and invalid UTF-8 never produce a partially protected response", async () => {
  const failure = new Error("fixture-private-source-detail"), nonce = marker();
  const body = Readable.from((async function* () { yield Buffer.from(script(nonce, "boot()")); throw failure; })());
  await assert.rejects(protectHtmlResponse(body, { marker: nonce, signal: AbortSignal.timeout(2000), headers: new Headers(), status: 200, secure: false }), error => error === failure);
  const malformed = Readable.from([Buffer.from([0xc3, 0x28])]);
  await assert.rejects(protectHtmlResponse(malformed, { marker: nonce, signal: AbortSignal.timeout(2000), headers: new Headers(), status: 200, secure: false }), /INVALID_UTF8/);
  assert.equal(body.destroyed, true);
  assert.equal(malformed.destroyed, true);
});

test("parallel private/public documents cannot share script grants, transport or cookies", async () => {
  const results = await Promise.all(Array.from({ length: 12 }, async (_, index) => {
    const nonce = marker(), source = `window.request=${index};`;
    const headers = new Headers({ "cache-control": index % 2 ? "no-store" : "public, s-maxage=60" });
    if (index % 2) headers.append("set-cookie", `fixture=${index}; HttpOnly`);
    const response = await seal(script(nonce, source), nonce, headers, index % 3 === 0);
    const policy = response.headers.get("content-security-policy")!;
    assert.ok(policy.includes(hash(source)));
    assert.equal(response.headers.has("strict-transport-security"), index % 3 === 0);
    assert.equal(response.headers.has("set-cookie"), index % 2 === 1);
    await response.body?.cancel();
    return policy;
  }));
  assert.equal(new Set(results).size, 12);
  assert.equal(browserSecurityHeaders(false)["strict-transport-security"], undefined);
  assert.equal(browserSecurityHeaders(false)["content-security-policy"], RESOURCE_CSP);
});

test("render retries and cookie-bearing HTML cannot inherit a public cache grant", async () => {
  const nonce = marker(), html = script(nonce, "boot()");
  for (const status of [400, 404, 429, 500, 503]) {
    const response = await seal(html, nonce, new Headers({ "cache-control": "public, s-maxage=60" }), false, status);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(response.headers.get("x-robots-tag"), "noindex");
    await response.body?.cancel();
  }
  const response = await seal(html, nonce, new Headers({ "cache-control": "public, s-maxage=60", "set-cookie": "fixture=one; HttpOnly" }));
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.deepEqual(response.headers.getSetCookie(), ["fixture=one; HttpOnly"]);
  await response.body?.cancel();
});
