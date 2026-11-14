import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { createBffClientAddressResolver } from "../../api/src/transport/rest/bff-client-address.ts";
import { startDevelopmentWeb } from "./support/development-web.ts";
import { BRIDGE_SECRET, EDGE_PEER, FIRST_CLIENT, SECOND_CLIENT, callFrom, closeServer, listen, startEdge } from "./support/client-address-stack.ts";

type Call = { address: string; target: string; method: string; headers: Headers; body: string };
const calls: Call[] = [];
const resolveAddress = createBffClientAddressResolver({ BFF_CLIENT_ADDRESS_SECRET: BRIDGE_SECRET });
const api = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const headers = new Headers();
  for (let index = 0; index < request.rawHeaders.length; index += 2) headers.append(request.rawHeaders[index]!, request.rawHeaders[index + 1]!);
  const address = resolveAddress(request);
  calls.push({ address, target: request.url!, method: request.method!, headers, body: Buffer.concat(chunks).toString("utf8") });
  // Yield beyond the ingress callback so a process-global address is observable.
  await new Promise<void>((resolve) => setImmediate(resolve));
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ data: { address, counted: true, viewCount: calls.length } }));
});
let web: Awaited<ReturnType<typeof startDevelopmentWeb>>;
before(async () => {
  const origin = await listen(api);
  web = await startDevelopmentWeb({ API_BASE_URL: origin, BFF_CLIENT_ADDRESS_SECRET: BRIDGE_SECRET,
    WEB_TRUSTED_PROXY_HOPS: "1", WEB_TRUSTED_PROXY_PEERS: EDGE_PEER });
});
after(async () => { await web?.close(); await closeServer(api); });

test("the actual development SSR loader shares native ingress context across independent TCP clients", async () => {
  calls.length = 0;
  const first = await callFrom(web.origin, FIRST_CLIENT, "/api/articles/dev-reader/views?locale=en");
  assert.equal(first.status, 200);
  assert.equal(JSON.parse(first.text).data.address, FIRST_CLIENT);
  const second = await callFrom(web.origin, SECOND_CLIENT, "/api/articles/dev-reader/views?locale=en");
  assert.equal(second.status, 200);
  assert.equal(JSON.parse(second.text).data.address, SECOND_CLIENT);
  assert.deepEqual(calls.map(({ address, target, method }) => [address, target, method]), [
    [FIRST_CLIENT, "/api/v1/articles/dev-reader/views?locale=en", "POST"],
    [SECOND_CLIENT, "/api/v1/articles/dev-reader/views?locale=en", "POST"],
  ]);
  for (const call of calls) {
    assert.equal(call.body, "");
    assert.match(call.headers.get("x-nw-client-address-proof") ?? "", /^v1\.[0-9]+\.[0-9a-f]{64}$/);
    assert.equal(call.headers.get("x-forwarded-for"), null);
  }
  assert.match(first.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(first.headers.get("x-nw-client-address-proof"), null);
});

test("development ingress ignores forged direct headers but honors an explicitly named appending proxy", async (t) => {
  calls.length = 0;
  const forged = { "x-forwarded-for": "192.0.2.44", "x-real-ip": "192.0.2.44", forwarded: "for=192.0.2.44",
    "x-nw-client-address": "192.0.2.44", "x-nw-client-address-proof": "v1.1.forged" };
  const direct = await callFrom(web.origin, FIRST_CLIENT, "/api/authoring/articles/dev-reader/views?locale=en", { headers: forged });
  assert.equal(direct.status, 200);
  assert.equal(JSON.parse(direct.text).data.address, FIRST_CLIENT);
  const edge = await startEdge(web.origin);
  t.after(() => edge.close());
  const proxied = await callFrom(edge.origin, SECOND_CLIENT, "/api/authoring/articles/dev-reader/views?locale=en", { headers: forged });
  assert.equal(proxied.status, 200);
  assert.equal(JSON.parse(proxied.text).data.address, SECOND_CLIENT);
  assert.deepEqual(calls.map(({ address }) => address), [FIRST_CLIENT, SECOND_CLIENT]);
  for (const call of calls) {
    assert.equal(call.headers.get("x-real-ip"), null);
    assert.equal(call.headers.get("forwarded"), null);
    assert.notEqual(call.headers.get("x-nw-client-address-proof"), forged["x-nw-client-address-proof"]);
    assert.equal(call.headers.get("cookie"), null);
  }
});

test("development-origin and method refusals never invoke upstream signing or consume an API bucket", async () => {
  calls.length = 0;
  const external = await callFrom(web.origin, FIRST_CLIENT, "/api/authoring/articles/dev-reader/views?locale=en", { headers: { origin: "https://outside.example.test" } });
  assert.equal(external.status, 403);
  assert.equal(JSON.parse(external.text).error.code, "ORIGIN_REJECTED");
  const wrongMethod = await callFrom(web.origin, FIRST_CLIENT, "/api/auth/login", { method: "GET" });
  assert.equal(wrongMethod.status, 405);
  assert.equal(JSON.parse(wrongMethod.text).error.code, "METHOD_NOT_ALLOWED");
  assert.equal(calls.length, 0);
  assert.equal(external.headers.get("x-nw-client-address"), null);
  const following = await callFrom(web.origin, SECOND_CLIENT, "/api/articles/dev-reader/views?locale=zh-TW");
  assert.equal(following.status, 200);
  assert.equal(JSON.parse(following.text).data.address, SECOND_CLIENT);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.target, "/api/v1/articles/dev-reader/views?locale=zh-TW");
});

test("overlapping development resource routes keep a separate verified address after an await", async () => {
  calls.length = 0;
  const peers = ["127.0.2.1", "127.0.2.2", "127.0.2.3", "127.0.2.4"];
  const results = await Promise.all(peers.map((peer) => callFrom(web.origin, peer, "/api/articles/dev-overlap/views?locale=en", {
    headers: { "x-forwarded-for": "198.51.100.55" },
  })));
  assert.ok(results.every(({ status }) => status === 200));
  assert.deepEqual(results.map(({ text }) => JSON.parse(text).data.address), peers);
  assert.deepEqual(calls.map(({ address }) => address).sort(), peers);
  assert.equal(calls.length, peers.length);
  for (let index = 0; index < results.length; index++) {
    assert.match(results[index]!.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(results[index]!.text.includes(BRIDGE_SECRET), false);
    assert.equal(results[index]!.headers.get("x-nw-client-address-proof"), null);
  }
});
