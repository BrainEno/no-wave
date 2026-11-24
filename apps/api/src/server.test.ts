/** Health, readiness, startup configuration and retired-route behaviour of the HTTP server. Split from server.test.ts (#357). */
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHttpObservability } from "./infrastructure/http-observability.ts";
import { authEnv, withServer } from "./test-support/rest-server-harness.ts";

test("health endpoint is explicit and not cacheable", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
    assert.deepEqual(await response.json(), { status: "ok", service: "api" });
  });
});

test("a request that fails before the handler's own error path drops one connection, never the process", async () => {
  // The listener is async; a throw before its try (here: observation setup) used
  // to be an unhandled rejection, which Node turns into process exit.
  const logs = [];
  const real = createHttpObservability({ logger: () => {} });
  const observability = Object.create(real, {
    beginRequest: { value: (request, response) => {
      if (request.url === "/explode") throw new TypeError("observation setup failed");
      return real.beginRequest(request, response);
    } },
  });
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await withServer(async (baseUrl) => {
      await assert.rejects(fetch(`${baseUrl}/explode`), "the failed connection is dropped, not answered");
      const health = await fetch(`${baseUrl}/health`);
      assert.equal(health.status, 200, "the server keeps serving");
    }, { observability, logger: (entry) => logs.push(entry) });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(unhandled, []);
  assert.deepEqual(logs.filter((entry) => entry.event === "api_request_handler_failed").map((entry) => entry.errorName), ["TypeError"]);
});

test("readiness returns 503 when PostgreSQL persistence is not configured", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/ready`);
    assert.equal(response.status, 503);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
    assert.deepEqual(await response.json(), {
      status: "not_ready", service: "api", persistence: "unavailable", auth: "ok",
      notifications: { status: "unavailable", pendingEvents: null, deadLetterEvents: null, oldestPendingAgeMs: null, sampledAt: null },
    });
  }, { env: authEnv });
});

test("readiness succeeds only when persistence health check succeeds", async () => {
  let checks = 0;
  const store = { async health() { checks += 1; return true; } };
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/ready`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.match(body.notifications.sampledAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(body, {
      status: "ready", service: "api", persistence: "ok", auth: "ok",
      notifications: { status: "ok", pendingEvents: 0, deadLetterEvents: 0, oldestPendingAgeMs: 0, sampledAt: body.notifications.sampledAt },
    });
    assert.equal(checks, 1);
  }, { store, env: authEnv });
});

test("readiness works when application services are injected directly", async () => {
  let checks = 0;
  const applicationServices = { async health() { checks += 1; return true; },
    async outboxBacklog() { return { pendingEvents: 0, deadLetterEvents: 0, oldestPendingAgeMs: 0 }; } };
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/ready`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.match(body.notifications.sampledAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(body, {
      status: "ready", service: "api", persistence: "ok", auth: "ok",
      notifications: { status: "ok", pendingEvents: 0, deadLetterEvents: 0, oldestPendingAgeMs: 0, sampledAt: body.notifications.sampledAt },
    });
    assert.equal(checks, 1);
  }, { applicationServices, env: authEnv });
});

test("readiness hides persistence exceptions and returns service unavailable", async () => {
  const store = { async health() { throw new Error("database credentials must not leak"); } };
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/ready`);
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.match(body, /not_ready/);
    assert.doesNotMatch(body, /credentials/);
  }, { store, env: authEnv });
});

test("readiness identifies bad auth configuration without leaking values or hiding database status", async () => {
  for (const env of [
    { ...authEnv, AUTH_JWT_SECRET: "bad-secret" },
    { ...authEnv, AUTH_JWT_SECRET: "" },
    { ...authEnv, AUTH_JWT_ISSUER: "" },
    { ...authEnv, AUTH_JWT_AUDIENCE: "" },
    { ...authEnv, AUTH_JWT_MAX_TTL_SECONDS: "invalid" },
  ]) {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/ready`);
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.match(body.notifications.sampledAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.deepEqual(body, { status: "not_ready", service: "api", persistence: "ok", auth: "unavailable",
        notifications: { status: "ok", pendingEvents: 0, deadLetterEvents: 0, oldestPendingAgeMs: 0, sampledAt: body.notifications.sampledAt } });
      assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
      const protectedResponse = await fetch(`${baseUrl}/api/v1/me`, { headers: { authorization: "Bearer a.b.c" } });
      assert.equal(protectedResponse.status, 503);
      const text = await protectedResponse.text();
      assert.match(text, /SERVICE_UNAVAILABLE/);
      assert.doesNotMatch(text, /bad-secret|AUTH_JWT/);
      for (const action of ["register", "login"]) {
        const auth = await fetch(`${baseUrl}/api/v1/auth/${action}`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "reader@example.test", password: "a-valid-password-123" }),
        });
        assert.equal(auth.status, 503, action);
        assert.match(await auth.text(), /SERVICE_UNAVAILABLE/);
      }
    }, { env, store: {} });
  }
});

test("API process fails before listening when authentication configuration is invalid", () => {
  const serverPath = fileURLToPath(new URL("./server.ts", import.meta.url));
  const cases = [
    [{ AUTH_JWT_SECRET: "short-secret" }, "AUTH_JWT_SECRET", "short-secret"],
    [{ AUTH_JWT_SECRET: "" }, "AUTH_JWT_SECRET", authEnv.AUTH_JWT_SECRET],
    [{ AUTH_JWT_ISSUER: "" }, "AUTH_JWT_ISSUER", authEnv.AUTH_JWT_SECRET],
    [{ AUTH_JWT_AUDIENCE: "" }, "AUTH_JWT_AUDIENCE", authEnv.AUTH_JWT_SECRET],
    [{ AUTH_JWT_MAX_TTL_SECONDS: "invalid" }, "AUTH_JWT_MAX_TTL_SECONDS", authEnv.AUTH_JWT_SECRET],
  ] as const;
  for (const [invalid, field, secret] of cases) {
    const child = spawnSync(process.execPath, [serverPath], {
      env: { ...process.env, ...authEnv, ...invalid, PORT: "0", DATABASE_PROVIDER: "sqlite", DATABASE_PATH: ":memory:" },
      encoding: "utf8", timeout: 15_000,
    });
    assert.equal(child.status, 1, `${field}: ${child.stderr} ${child.stdout}`);
    assert.match(child.stdout + child.stderr, new RegExp(field));
    assert.doesNotMatch(child.stdout + child.stderr, new RegExp(secret));
    assert.match(child.stdout + child.stderr, /api_startup_failed/);
  }
});

test("legacy GraphQL route is unavailable after the REST-only migration", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ health { status } }" }),
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: { code: "NOT_FOUND", message: "The requested route was not found." },
    });
  });
});

test("REST health endpoint is available independently of business routes", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/health`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    assert.deepEqual(await response.json(), {
      status: "ok", service: "api", version: "0.1.0",
    });
  });
});
