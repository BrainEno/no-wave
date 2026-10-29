import assert from "node:assert/strict";
import test from "node:test";
import { createNeonDatabaseHealthHandler } from "./health.ts";

test("Neon database health function answers a successful database probe", async () => {
  const handler = createNeonDatabaseHealthHandler({ query: async () => true });
  const response = await handler.fetch(new Request("https://health.example.test/health"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    status: "ok",
    service: "no-wave-neon-health",
    database: "ok",
  });
});

test("Neon database health function sanitizes database failures", async () => {
  const handler = createNeonDatabaseHealthHandler({
    query: async () => { throw new Error("secret connection string should not appear"); },
  });
  const response = await handler.fetch(new Request("https://health.example.test/"));
  const body = JSON.stringify(await response.json());
  assert.equal(response.status, 503);
  assert.match(body, /not_ready/);
  assert.doesNotMatch(body, /secret connection string|postgres:///i);
});

test("Neon database health function only supports GET / and GET /health", async () => {
  const handler = createNeonDatabaseHealthHandler({ query: async () => true });
  const methodResponse = await handler.fetch(new Request("https://health.example.test/health", { method: "POST" }));
  const pathResponse = await handler.fetch(new Request("https://health.example.test/private"));
  assert.equal(methodResponse.status, 405);
  assert.equal(methodResponse.headers.get("allow"), "GET");
  assert.equal(pathResponse.status, 404);
});
