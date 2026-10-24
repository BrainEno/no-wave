import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { createApiServer } from "./server.mjs";
import { persistencePortMethods } from "./application/persistence-ports.mjs";

const authEnv = {
  AUTH_JWT_SECRET: "test-only-secret-that-is-at-least-32-bytes",
  AUTH_JWT_ISSUER: "https://auth.example.test",
  AUTH_JWT_AUDIENCE: "bot-thk-api",
};

function signedToken(sub) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    sub,
    iss: authEnv.AUTH_JWT_ISSUER,
    aud: authEnv.AUTH_JWT_AUDIENCE,
    exp: Math.floor(Date.now() / 1000) + 60,
    jti: `session-${sub}`,
  });
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${createHmac("sha256", authEnv.AUTH_JWT_SECRET).update(unsigned).digest("base64url")}`;
}

function completeFakeAdapter(overrides = {}) {
  const adapter = { async health() { return true; } };
  for (const methods of Object.values(persistencePortMethods)) {
    for (const method of methods) {
      if (typeof adapter[method] !== "function") {
        adapter[method] = async () => null;
      }
    }
  }
  return Object.assign(adapter, overrides);
}

async function withServer(run, options = {}) {
  const serverOptions = options.store
    ? { ...options, store: completeFakeAdapter(options.store) }
    : options;
  const server = createApiServer(serverOptions);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("health endpoint is explicit and not cacheable", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
    assert.deepEqual(await response.json(), { status: "ok", service: "api" });
  });
});

test("readiness returns 503 when PostgreSQL persistence is not configured", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/ready`);
    assert.equal(response.status, 503);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
    assert.deepEqual(await response.json(), {
      status: "not_ready", service: "api", persistence: "unavailable",
    });
  });
});

test("readiness succeeds only when persistence health check succeeds", async () => {
  let checks = 0;
  const store = { async health() { checks += 1; return true; } };
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/ready`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "ready", service: "api", persistence: "ok",
    });
    assert.equal(checks, 1);
  }, { store });
});

test("readiness works when application services are injected directly", async () => {
  let checks = 0;
  const applicationServices = { async health() { checks += 1; return true; } };
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/ready`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "ready", service: "api", persistence: "ok",
    });
    assert.equal(checks, 1);
  }, { applicationServices });
});

test("readiness hides persistence exceptions and returns service unavailable", async () => {
  const store = { async health() { throw new Error("database credentials must not leak"); } };
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/ready`);
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.match(body, /not_ready/);
    assert.doesNotMatch(body, /credentials/);
  }, { store });
});

test("GraphQL endpoint serves a minimal health query", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ health { status version } }" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      data: { health: { status: "ok", version: "0.1.0" } },
    });
  });
});

test("GraphQL article contentBlocks serializes domain arrays at the field boundary", async () => {
  const store = {
    async getPublishedArticle() {
      return {
        id: "article-1",
        authorId: "author-1",
        slug: "hello-world",
        status: "published",
        locale: "zh-TW",
        title: "Hello",
        summary: "",
        contentBlocks: [{ id: "block-1", type: "paragraph", text: "Hello" }],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        publishedAt: "2026-01-01T00:00:00.000Z",
      };
    },
  };
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: '{ article(slug: "hello-world") { contentBlocks } }' }),
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(result, {
      data: {
        article: {
          contentBlocks: JSON.stringify([{ id: "block-1", type: "paragraph", text: "Hello" }]),
        },
      },
    });
  }, { store });
});

test("private viewer query fails closed without server-verified identity", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ viewer { id } }" }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.data.viewer, null);
    assert.equal(result.errors?.[0]?.message, "Authentication is required.");
    assert.equal(result.errors?.[0]?.extensions?.code, "UNAUTHENTICATED");
  });
});

test("viewer resolves only from a valid server-verified bearer token", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/graphql`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${signedToken("authenticated-user")}`,
      },
      body: JSON.stringify({ query: "{ viewer { id } }" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { viewer: { id: "authenticated-user" } } });
  }, { env: authEnv });
});

test("viewer rejects forged bearer token and client-supplied identity", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/graphql`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer forged.token.value",
        "x-user-id": "attacker",
      },
      body: JSON.stringify({ query: "{ viewer { id } }" }),
    });
    const result = await response.json();
    assert.equal(result.data.viewer, null);
    assert.equal(result.errors?.[0]?.extensions?.code, "UNAUTHENTICATED");
  }, { env: authEnv });
});

test("GraphQL rejects invalid fields instead of returning fabricated data", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ privateMessages }" }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.ok(Array.isArray(result.errors));
  });
});

test("current session can be revoked and subsequent requests fail closed", async () => {
  const revoked = new Set();
  let recordedExpiry = null;
  const store = {
    async isSessionRevoked(sessionId) { return revoked.has(sessionId); },
    async revokeSession({ sessionId, expiresAt }) {
      revoked.add(sessionId);
      recordedExpiry = expiresAt;
      return true;
    },
  };
  await withServer(async (baseUrl) => {
    const request = (query) => fetch(`${baseUrl}/graphql`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${signedToken("logout-user")}`,
      },
      body: JSON.stringify({ query }),
    });
    const logoutResponse = await request("mutation { revokeCurrentSession }");
    assert.deepEqual(await logoutResponse.json(), { data: { revokeCurrentSession: true } });
    assert.ok(recordedExpiry instanceof Date);
    assert.ok(recordedExpiry.getTime() > Date.now());

    const viewerResponse = await request("{ viewer { id } }");
    const viewerResult = await viewerResponse.json();
    assert.equal(viewerResult.data.viewer, null);
    assert.equal(viewerResult.errors?.[0]?.extensions?.code, "UNAUTHENTICATED");
  }, { env: authEnv, store });
});


test("createArticle reports malformed contentBlocks as a client input error", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/graphql`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${signedToken("article-author")}`,
      },
      body: JSON.stringify({
        query: 'mutation { createArticle(slug: "bad-json", title: "Bad JSON", contentBlocks: "not-json") { id } }',
      }),
    });
    const result = await response.json();
    assert.equal(result.data, null);
    assert.equal(result.errors?.[0]?.extensions?.code, "BAD_USER_INPUT");
    assert.equal(result.errors?.[0]?.message, "contentBlocks must be a valid JSON array.");
  }, { env: authEnv, store: { async isSessionRevoked() { return false; } } });
});

test("updateArticle reports malformed contentBlocks as a client input error", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/graphql`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${signedToken("article-author")}`,
      },
      body: JSON.stringify({
        query: 'mutation { updateArticle(articleId: "article-1", slug: "bad-json", title: "Bad JSON", contentBlocks: "not-json", publish: false) { id } }',
      }),
    });
    const result = await response.json();
    assert.equal(result.data, null);
    assert.equal(result.errors?.[0]?.extensions?.code, "BAD_USER_INPUT");
    assert.equal(result.errors?.[0]?.message, "contentBlocks must be a valid JSON array.");
  }, { env: authEnv, store: { async isSessionRevoked() { return false; } } });
});
