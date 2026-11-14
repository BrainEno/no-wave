import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";
import { FIRST_CLIENT, callFrom, closeServer, listen, startEdge } from "./support/client-address-stack.ts";

test("the named ingress fixture cannot proxy an absolute or network-path request target to another origin", async (t) => {
  const intendedRequests: string[] = [], outsideRequests: string[] = [];
  const intended = createServer((request, response) => { intendedRequests.push(request.url ?? ""); response.end("intended fixture"); });
  const outside = createServer((request, response) => { outsideRequests.push(request.url ?? ""); response.end("outside fixture"); });
  t.after(async () => { await closeServer(intended); await closeServer(outside); });
  const intendedOrigin = await listen(intended), outsideOrigin = await listen(outside);
  const edge = await startEdge(intendedOrigin);
  t.after(() => edge.close());

  for (const target of [`${outsideOrigin}/stolen`, `${outsideOrigin}/stolen?via=absolute`, `//${new URL(outsideOrigin).host}/stolen`, `/\\${new URL(outsideOrigin).host}/stolen`]) {
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(edge.origin, { method: "GET", path: target, agent: false }, (response) => {
        response.once("error", reject);
        response.once("end", () => resolve(response.statusCode!));
        response.resume();
      });
      request.setTimeout(5000, () => request.destroy(new Error("Ingress rejection timed out.")));
      request.once("error", reject);
      request.end();
    });
    assert.equal(status, 400, "an origin-form rejection must happen before opening any upstream request");
  }
  assert.deepEqual(outsideRequests, []);
  assert.deepEqual(intendedRequests, []);
  const accepted = await callFrom(edge.origin, FIRST_CLIENT, "/legitimate?locale=en", { method: "GET" });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.text, "intended fixture");
  assert.deepEqual(intendedRequests, ["/legitimate?locale=en"]);
  assert.deepEqual(outsideRequests, []);
});
