import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startProductionWeb } from "./support/production-web.ts";
import { htmlScripts, inlineScriptText } from "./support/html-scripts.ts";

let directory: string;
let web: Awaited<ReturnType<typeof startProductionWeb>>;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "nw-document-boundaries-"));
  const file = join(directory, "fixture.ts");
  // Only the route is synthetic. The compiled SSR entry, React streaming,
  // Router fallback and Node HTTP/compression stack are the actual distribution.
  await writeFile(file, `
    import * as compiled from ${JSON.stringify(new URL("../build/server/index.js", import.meta.url).href)};
    import { createElement as h, Suspense, use } from ${JSON.stringify(import.meta.resolve("react"))};
    import { Scripts, ScrollRestoration, useLocation } from ${JSON.stringify(import.meta.resolve("react-router"))};
    export * from ${JSON.stringify(new URL("../build/server/index.js", import.meta.url).href)};
    const never = new Promise(() => {});
    const delayed = new Map();
    function Late({ path }) {
      if (path === "/timeout") use(never);
      if (!delayed.has(path)) delayed.set(path, new Promise(resolve => setTimeout(() => resolve("late-complete"), 250)));
      const result = use(delayed.get(path));
      if (path === "/late-error") throw new Error("fixture-private-late-render-detail");
      return h("p", null, result);
    }
    function Shell() {
      const { pathname } = useLocation();
      const payload = pathname === "/oversize" ? "fixture-private-partial-canary".repeat(400000) : "complete-document";
      return h("html", null, h("head"), h("body", null, h("p", null, payload),
        pathname === "/untrusted" ? h("script", { dangerouslySetInnerHTML: { __html: "window.fixturePrivateAttack=true" } }) : null,
        pathname === "/late" || pathname === "/late-error" || pathname === "/timeout" ? h(Suspense, { fallback: h("p", null, "waiting-private-partial-canary") }, h(Late, { path: pathname })) : null,
        h(ScrollRestoration), h(Scripts)));
    }
    function Boundary() { return h("html", null, h("head"), h("body", null, h("h1", null, "safe-render-failure"), h(Scripts))); }
    export const assets = { ...compiled.assets, routes: { root: { ...compiled.assets.routes.root, hasLoader: false } } };
    export const routes = { root: { id: "root", path: "*", module: { default: Shell, ErrorBoundary: Boundary,
      headers({ errorHeaders }) { return { "cache-control": errorHeaders ? "no-store" : "public, s-maxage=60" }; } } } };
  `);
  web = await startProductionWeb({ RR_SERVER_BUILD_DIR: file, WEB_TRUSTED_PROXY_HOPS: "0", WEB_TRUSTED_PROXY_PEERS: "" });
});
after(async () => { await web?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });

function protectedDocument(response: Response, html: string) {
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  const policy = response.headers.get("content-security-policy") ?? "";
  assert.match(policy, /frame-ancestors 'none'/);
  assert.doesNotMatch(policy.split(";").find(value => value.trim().startsWith("script-src ")) ?? "", /unsafe-inline|unsafe-eval|nonce-/);
  for (const node of htmlScripts(html)) {
    if (node.attrs.some(attribute => attribute.name === "src")) continue;
    assert.ok(policy.includes(`'sha256-${createHash("sha256").update(inlineScriptText(node)).digest("base64")}'`));
  }
}

test("an internally streamed Suspense completion waits before headers and hashes the late React handoff", async () => {
  const started = performance.now();
  const response = await fetch(web.origin + "/late", { headers: { "accept-encoding": "identity" } });
  const firstByte = performance.now() - started;
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /late-complete/);
  assert.ok(firstByte >= 200, `headers arrived at ${firstByte} ms before the late script existed`);
  assert.ok(firstByte < 5000);
  protectedDocument(response, html);
  assert.match(response.headers.get("cache-control") ?? "", /public, s-maxage=60/);
  assert.ok(htmlScripts(html).length >= 4, "exercise the late React/Suspense script, not just Scripts");
});

test("an oversized real render returns only a protected no-store error, never its partial public shell", async () => {
  const response = await fetch(web.origin + "/oversize");
  const html = await response.text();
  assert.equal(response.status, 500, "oversized output is rejected before any shell is sent");
  protectedDocument(response, html);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.ok(Buffer.byteLength(html) < 64_000);
  assert.doesNotMatch(html, /fixture-private-partial-canary|DOCUMENT_TOO_LARGE|at protectHtmlResponse/);
  const health = await fetch(web.origin + "/healthz");
  assert.equal(health.status, 200);
  await health.body?.cancel();
});

test("a renderer-unmarked executable is not hashed and cannot escape through the Router error retry", async () => {
  const response = await fetch(web.origin + "/untrusted");
  assert.equal(response.status, 500);
  const html = await response.text();
  protectedDocument(response, html);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.doesNotMatch(html, /fixturePrivateAttack|UNTRUSTED_INLINE_SCRIPT/);
  assert.ok(!response.headers.get("content-security-policy")!.includes(createHash("sha256").update("window.fixturePrivateAttack=true").digest("base64")));
  assert.doesNotMatch(web.output(), /window.fixturePrivateAttack|waiting-private-partial-canary/);
});

test("a never-finishing real Suspense render is cancelled inside the six-second budget before any partial HTML", async () => {
  const started = performance.now();
  const response = await fetch(web.origin + "/timeout", { signal: AbortSignal.timeout(12_000) });
  const elapsed = performance.now() - started;
  assert.equal(response.status, 500);
  const html = await response.text();
  protectedDocument(response, html);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.ok(elapsed >= 5500 && elapsed < 10_000, `render finished at ${elapsed} ms`);
  assert.doesNotMatch(html, /waiting-private-partial-canary|complete-document|AbortError|Document rendering aborted/);
  const after = await fetch(web.origin + "/complete");
  assert.equal(after.status, 200);
  protectedDocument(after, await after.text());
});

test("a client disconnect aborts buffered rendering without poisoning later requests or exposing payloads", async () => {
  await new Promise<void>((resolve, reject) => {
    const request = httpRequest(web.origin + "/timeout", response => {
      response.resume(); reject(new Error("An unfinished render committed headers before cancellation."));
    });
    request.once("error", (error: NodeJS.ErrnoException) => error.code === "ECONNRESET" ? resolve() : reject(error));
    request.end();
    setTimeout(() => request.destroy(), 80);
  });
  const response = await fetch(web.origin + "/complete");
  assert.equal(response.status, 200);
  protectedDocument(response, await response.text());
  assert.doesNotMatch(web.output(), /waiting-private-partial-canary|fixture-private-partial-canary|UnhandledPromiseRejection|uncaughtException/);
});

test("shutdown's early 503 still has a fail-closed browser policy and no-store on a live pipelined socket", async () => {
  const draining = await startProductionWeb({ RR_SERVER_BUILD_DIR: join(directory, "fixture.ts"),
    WEB_TRUSTED_PROXY_HOPS: "0", WEB_TRUSTED_PROXY_PEERS: "" });
  try {
    const address = new URL(draining.origin);
    const socket = connect({ host: address.hostname, port: Number(address.port) });
    const result = new Promise<string>((resolve, reject) => {
      let wire = "";
      socket.setEncoding("utf8");
      socket.on("data", chunk => { wire += chunk; });
      socket.once("end", () => resolve(wire));
      socket.once("error", reject);
      socket.setTimeout(12_000, () => { socket.destroy(); reject(new Error("Shutdown did not close the pipelined connection.")); });
    });
    await new Promise<void>(resolve => socket.once("connect", resolve));
    socket.write(`GET /timeout HTTP/1.1\r\nHost: ${address.host}\r\n\r\n`);
    await delay(100);
    draining.signal("SIGTERM");
    await delay(50);
    socket.write(`GET /healthz HTTP/1.1\r\nHost: ${address.host}\r\nConnection: close\r\n\r\n`);
    const wire = await result;
    assert.match(wire, /HTTP\/1.1 503 Service Unavailable/);
    const lastResponse = wire.slice(wire.lastIndexOf("HTTP/1.1 503"));
    assert.match(lastResponse, /x-content-type-options: nosniff/i);
    assert.match(lastResponse, /x-frame-options: DENY/i);
    assert.match(lastResponse, /content-security-policy: default-src 'none'.*frame-ancestors 'none'/i);
    assert.match(lastResponse, /cache-control: no-store/i);
    assert.match(lastResponse, /retry-after: 1/i);
    assert.doesNotMatch(wire, /waiting-private-partial-canary|fixture-private-partial-canary/);
  } finally { await draining.close(); }
});

test("last-resort plain 500 responses retain the native baseline and never expose render details under a mislabelled NODE_ENV", async () => {
  const file = join(directory, "terminal.ts");
  await writeFile(file, `
    import * as fixture from ${JSON.stringify(pathToFileURL(join(directory, "fixture.ts")).href)};
    export * from ${JSON.stringify(pathToFileURL(join(directory, "fixture.ts")).href)};
    export const entry = { ...fixture.entry, module: { ...fixture.entry.module,
      default() { throw new Error("fixture-private-terminal-render-detail"); } } };
  `);
  for (const mode of ["production", "", "development"]) {
    const failed = await startProductionWeb({ RR_SERVER_BUILD_DIR: file, NODE_ENV: mode,
      WEB_TRUSTED_PROXY_HOPS: "0", WEB_TRUSTED_PROXY_PEERS: "" });
    try {
      for (const method of ["GET", "HEAD"]) {
        const response = await fetch(failed.origin + "/complete", { method });
        assert.equal(response.status, 500);
        assert.match(response.headers.get("content-type")!, /^text\/plain/);
        assert.equal(response.headers.get("x-content-type-options"), "nosniff");
        assert.equal(response.headers.get("x-frame-options"), "DENY");
        assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
        assert.match(response.headers.get("permissions-policy")!, /camera=\(\)/);
        assert.match(response.headers.get("content-security-policy")!, /default-src 'none'.*frame-ancestors 'none'/);
        assert.match(response.headers.get("cache-control")!, /no-store/);
        assert.equal(response.headers.get("strict-transport-security"), null);
        assert.deepEqual(response.headers.getSetCookie(), []);
        assert.equal(await response.text(), method === "HEAD" ? "" : "Unexpected Server Error", mode);
      }
      assert.doesNotMatch(failed.output(), /fixture-private-terminal-render-detail|at Object.default/);
      const health = await fetch(failed.origin + "/healthz");
      assert.equal(health.status, 200);
      await health.body?.cancel();
    } finally { await failed.close(); }
  }
});

test("a late renderer error rejects the buffered public shell instead of caching a client-render fallback as 200", async () => {
  const response = await fetch(web.origin + "/late-error", { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 500);
  const html = await response.text();
  protectedDocument(response, html);
  assert.match(response.headers.get("cache-control")!, /no-store/);
  assert.equal(response.headers.get("x-robots-tag"), "noindex");
  assert.match(html, /safe-render-failure/);
  assert.doesNotMatch(html, /waiting-private-partial-canary|complete-document|fixture-private-late-render-detail/);
  assert.doesNotMatch(web.output(), /fixture-private-late-render-detail|waiting-private-partial-canary/);
  const after = await fetch(web.origin + "/complete");
  assert.equal(after.status, 200);
  assert.match(after.headers.get("cache-control")!, /s-maxage=60/);
  protectedDocument(after, await after.text());
});
