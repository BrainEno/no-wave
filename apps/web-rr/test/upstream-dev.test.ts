import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import test from "node:test";
import { startDevelopmentWeb } from "./support/development-web.ts";

test("real Vite ingress bounds exchanges, preserves the session lane and applies its native header deadline", { timeout: 30_000 }, async t => {
  let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  let finish: (() => void) | undefined;
  const api = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/api/v1/me/articles")) { finish = () => response.end('{"data":[]}'); enter(); }
    else response.end('{"data":{"id":"dev-reader"}}');
  });
  api.listen(0, "127.0.0.1"); await once(api, "listening");
  t.after(() => new Promise<void>(resolve => { api.closeAllConnections(); api.close(() => resolve()); }));
  const address = api.address(); assert.ok(address && typeof address !== "string");
  const web = await startDevelopmentWeb({ API_BASE_URL: `http://127.0.0.1:${address.port}`, WEB_REQUEST_CONCURRENCY: "1",
    WEB_UPSTREAM_CONCURRENCY: "1", WEB_UPSTREAM_QUEUE: "0", WEB_HEADERS_TIMEOUT_MS: "1000", WEB_REQUEST_TIMEOUT_MS: "1000" });
  t.after(() => web.close());
  const held = fetch(`${web.origin}/api/authoring/articles`);
  t.after(() => finish?.());
  await entered;
  const busy = await fetch(`${web.origin}/api/authoring/articles`);
  assert.equal(busy.status, 503); assert.equal((await busy.json()).error.code, "WEB_BUSY");
  const session = await fetch(`${web.origin}/api/authoring/session`, { headers: { cookie: "nw_access=dev-access" } });
  assert.equal(session.status, 200); assert.equal((await session.json()).data.id, "dev-reader");
  finish?.(); assert.equal((await held).status, 200);
  const socket = connect(Number(new URL(web.origin).port), "127.0.0.1");
  t.after(() => socket.destroy());
  const reply = new Promise<string>((resolve, reject) => {
    let text = "";
    socket.setTimeout(4000, () => { socket.destroy(); reject(new Error("Vite did not apply the configured native header deadline.")); });
    socket.on("data", chunk => { text += chunk.toString(); }); socket.once("error", reject); socket.once("close", () => resolve(text));
  });
  socket.write("GET /@vite/client HTTP/1.1\r\nHost: local");
  assert.match(await reply, /^HTTP\/1\.1 408 /);
  const client = await fetch(`${web.origin}/@vite/client`);
  assert.equal(client.status, 200); await client.text();
});
