import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { createApiServer } from "./server.ts";
import { persistencePortMethods } from "./application/persistence-ports.ts";
import { ArticleAuthorizationError, ArticleInputError, ArticleNotFoundError, ArticleSlugConflictError, DomainError, IdempotencyConflictError } from "./domain/errors.ts";

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

test("public article query forwards pagination arguments to persistence", async () => {
  let received;
  const store = {
    async listPublishedArticles(args) {
      received = args;
      return [];
    },
  };
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: '{ articles(locale: "en", query: "poetry", limit: 10, offset: 20) { id slug } }',
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { articles: [] } });
    assert.deepEqual(received, { locale: "en", query: "poetry", limit: 10, offset: 20 });
  }, { store });
});


test("public taxonomy query forwards pagination arguments to persistence", async () => {
  let received;
  const store = {
    async listTaxonomies(args) {
      received = args;
      return [];
    },
  };
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: '{ taxonomies(kind: "category", locale: "en", query: "poetry", limit: 10, offset: 20) { id slug } }',
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { taxonomies: [] } });
    assert.deepEqual(received, { kind: "category", locale: "en", query: "poetry", limit: 10, offset: 20 });
  }, { store });
});

test("REST health endpoint is available independently of GraphQL", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/health`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    assert.deepEqual(await response.json(), {
      status: "ok", service: "api", version: "0.1.0",
    });
  });
});

test("REST public author profile uses stable userId and returns 404 for missing authors", async () => {
  let received;
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/authors/user-123`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      data: { userId: "user-123", displayName: "Writer", bio: "简介", locale: "zh-CN" },
    });
    assert.deepEqual(received, { userId: "user-123", locale: "zh-CN", viewerId: null });

    const missing = await fetch(`${baseUrl}/api/v1/authors/missing-user`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), {
      error: { code: "NOT_FOUND", message: "The author was not found." },
    });
  }, {
    store: {
      async getAuthorProfile(args) {
        received = args;
        return args.userId === "user-123"
          ? { userId: args.userId, displayName: "Writer", bio: "简介", locale: args.locale }
          : null;
      },
    },
  });
});

test("REST author article listing forwards userId to persistence before pagination", async () => {
  let received;
  const articles = [{ id: "article-1", authorId: "user-123", slug: "hello-world", locale: "zh-CN", title: "Hello" }];
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/authors/user-123/articles?query=hello&limit=10&offset=20`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: articles });
    assert.deepEqual(received, { authorId: "user-123", locale: "zh-CN", query: "hello", limit: 10, offset: 20 });
  }, {
    store: {
      async getAuthorProfile(args) {
        return { userId: args.userId, displayName: "Writer", bio: "简介", locale: args.locale };
      },
      async listPublishedArticles(args) {
        received = args;
        return articles;
      },
    },
  });
});

test("REST public article list calls the shared application service with validated query options", async () => {
  let received;
  const articles = [{
    id: "article-1", slug: "hello-world", locale: "zh-CN", title: "Hello",
    summary: "Summary", contentBlocks: [{ type: "paragraph", text: "Hello" }],
  }];
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/articles?locale=zh-CN&query=poetry&limit=10&offset=20`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: articles });
    assert.deepEqual(received, { locale: "zh-CN", query: "poetry", limit: 10, offset: 20 });
  }, {
    store: {
      async listPublishedArticles(args) { received = args; return articles; },
    },
  });
});

test("REST public article detail calls the same service and returns 404 for missing articles", async () => {
  let received;
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/articles/hello-world?locale=zh-CN`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      data: { id: "article-1", slug: "hello-world", locale: "zh-CN", title: "Hello" },
    });
    assert.deepEqual(received, { slug: "hello-world", locale: "zh-CN" });

    const missing = await fetch(`${baseUrl}/api/v1/articles/missing`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), {
      error: { code: "NOT_FOUND", message: "The article was not found." },
    });
  }, {
    store: {
      async getPublishedArticle(args) {
        received = args;
        return args.slug === "hello-world"
          ? { id: "article-1", slug: args.slug, locale: args.locale, title: "Hello" }
          : null;
      },
    },
  });
});


test("REST category index uses the shared taxonomy service and forwards bounded pagination", async () => {
  let received;
  const categories = [{ id: "category-1", kind: "category", slug: "poetry", name: "Poetry", locale: "zh-CN", articleCount: 3 }];
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/categories?locale=zh-CN&query=poe&limit=10&offset=20`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: categories });
    assert.deepEqual(received, { kind: "category", locale: "zh-CN", query: "poe", limit: 10, offset: 20 });
  }, {
    store: {
      async listTaxonomies(args) { received = args; return categories; },
    },
  });
});

test("REST category detail is localized and returns a stable 404 when absent", async () => {
  let received;
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/categories/poetry?locale=zh-CN`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { id: "category-1", slug: "poetry", locale: "zh-CN", name: "诗歌" } });
    assert.deepEqual(received, { kind: "category", slug: "poetry", locale: "zh-CN" });

    const missing = await fetch(`${baseUrl}/api/v1/categories/missing?locale=zh-CN`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), {
      error: { code: "NOT_FOUND", message: "The category was not found." },
    });
  }, {
    store: {
      async getTaxonomyBySlug(args) {
        received = args;
        return args.slug === "poetry" ? { id: "category-1", slug: args.slug, locale: args.locale, name: args."诗歌" } : null;
      },
    },
  });
});

test("REST category articles verify category visibility and forward pagination", async () => {
  let received;
  let categoryLookups = 0;
  const articles = [{ id: "article-1", slug: "poem-one", locale: "zh-CN", title: "Poem One" }];
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/categories/poetry/articles?locale=zh-CN&limit=5&offset=10`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: articles });
    assert.deepEqual(received, { kind: "category", slug: "poetry", locale: "zh-CN", limit: 5, offset: 10 });

    const missing = await fetch(`${baseUrl}/api/v1/categories/missing/articles?locale=zh-CN`);
    assert.equal(missing.status, 404);
    assert.equal(categoryLookups, 2);
  }, {
    store: {
      async getTaxonomyBySlug(args) { categoryLookups += 1; return args.slug === "poetry" ? { id: "category-1", slug: args.slug } : null; },
      async listTaxonomyArticles(args) { received = args; return articles; },
    },
  });
});

test("REST tag index reuses the taxonomy service and forwards bounded pagination", async () => {
  let received;
  const tags = [{ id: "tag-1", kind: "tag", slug: "ai-abc123", name: "人工智能", locale: "zh-CN", articleCount: 3 }];
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/v1/tags?locale=zh-CN&query=人工&limit=10&offset=20");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
    assert.deepEqual(await response.json(), { data: tags });
    assert.deepEqual(received, { kind: "tag", locale: "zh-CN", query: "人工", limit: 10, offset: 20 });
  }, {
    store: {
      async listTaxonomies(args) { received = args; return tags; },
    },
  });
});

test("REST tag detail is localized and returns a stable 404 when absent", async () => {
  const received = [];
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/v1/tags/ai-abc123?locale=zh-CN");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      data: { id: "tag-1", kind: "tag", slug: "ai-abc123", name: "AI", locale: "zh-CN", articleCount: 2 },
    });
    assert.deepEqual(received[0], { kind: "tag", slug: "ai-abc123", locale: "zh-CN" });

    const missing = await fetch(baseUrl + "/api/v1/tags/missing-tag?locale=zh-CN");
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), {
      error: { code: "NOT_FOUND", message: "The tag was not found." },
    });
    assert.deepEqual(received[1], { kind: "tag", slug: "missing-tag", locale: "zh-CN" });
  }, {
    store: {
      async getTaxonomyBySlug(args) {
        received.push(args);
        return args.slug === "ai-abc123"
          ? { id: "tag-1", kind: "tag", slug: args.slug, name: args.locale === "en" ? "AI" : "人工智慧", locale: args.locale, articleCount: 2 }
          : null;
      },
    },
  });
});

test("REST tag articles verify localized tag visibility before listing and forward pagination", async () => {
  const calls = [];
  const articles = [{ id: "article-1", slug: "article-about-ai", locale: "zh-CN", title: "AI" }];
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/v1/tags/ai-abc123/articles?locale=zh-CN&limit=5&offset=10");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: articles });
    assert.deepEqual(calls.slice(0, 2), [
      ["lookup", { kind: "tag", slug: "ai-abc123", locale: "zh-CN" }],
      ["articles", { kind: "tag", slug: "ai-abc123", locale: "zh-CN", limit: 5, offset: 10 }],
    ]);

    const missing = await fetch(baseUrl + "/api/v1/tags/missing-tag/articles?locale=zh-CN");
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), {
      error: { code: "NOT_FOUND", message: "The tag was not found." },
    });
    assert.deepEqual(calls[2], ["lookup", { kind: "tag", slug: "missing-tag", locale: "zh-CN" }]);
    assert.equal(calls.length, 3, "missing tags must not trigger an article query");
  }, {
    store: {
      async getTaxonomyBySlug(args) {
        calls.push(["lookup", args]);
        return args.slug === "ai-abc123" ? { id: "tag-1", slug: args.slug } : null;
      },
      async listTaxonomyArticles(args) {
        calls.push(["articles", args]);
        return articles;
      },
    },
  });
});
test("REST rejects unsupported locales, oversized search terms and offsets before persistence", async () => {
  let calls = 0;
  const oversizedQuery = "x".repeat(201);
  await withServer(async (baseUrl) => {
    for (const path of [
      "/api/v1/articles?locale=fr",
      "/api/v1/articles?locale=en",
      "/api/v1/articles?locale=zh-TW",
      `/api/v1/articles?query=${oversizedQuery}`,
      "/api/v1/articles?offset=100001",
      "/api/v1/categories?locale=fr",
      `/api/v1/categories?query=${oversizedQuery}`,
      "/api/v1/categories?offset=1000001",
      "/api/v1/tags?locale=fr",
      `/api/v1/tags?query=${oversizedQuery}`,
      "/api/v1/tags?offset=1000001",
    ]) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 400, path);
      assert.equal((await response.json()).error.code, "BAD_USER_INPUT");
    }
    const malformedSlug = await fetch(`${baseUrl}/api/v1/categories/%E0%A4%A`);
    assert.equal(malformedSlug.status, 400);
    assert.equal((await malformedSlug.json()).error.code, "BAD_USER_INPUT");
    const malformedTagSlug = await fetch(`${baseUrl}/api/v1/tags/%E0%A4%A`);
    assert.equal(malformedTagSlug.status, 400);
    assert.equal((await malformedTagSlug.json()).error.code, "BAD_USER_INPUT");
    const malformedTagArticlesSlug = await fetch(`${baseUrl}/api/v1/tags/%E0%A4%A/articles`);
    assert.equal(malformedTagArticlesSlug.status, 400);
    assert.equal((await malformedTagArticlesSlug.json()).error.code, "BAD_USER_INPUT");
    assert.equal(calls, 0);
  }, {
    store: {
      async listPublishedArticles() { calls += 1; return []; },
      async listTaxonomies() { calls += 1; return []; },
      async getTaxonomyBySlug() { calls += 1; return null; },
    },
  });
});

test("REST rejects invalid pagination instead of silently coercing values", async () => {
  await withServer(async (baseUrl) => {
    for (const query of ["?limit=0", "?limit=1.5", "?offset=-1", "?limit=101"]) {
      const response = await fetch(`${baseUrl}/api/v1/articles${query}`);
      assert.equal(response.status, 400, query);
      assert.equal((await response.json()).error.code, "BAD_USER_INPUT");
    }
  }, { store: { async listPublishedArticles() { throw new Error("must not be called"); } } });
});

test("REST reports unavailable services and unknown API routes as JSON errors", async () => {
  await withServer(async (baseUrl) => {
    const unavailable = await fetch(`${baseUrl}/api/v1/articles`);
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).error.code, "SERVICE_UNAVAILABLE");

    const missing = await fetch(`${baseUrl}/api/v1/unknown`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "NOT_FOUND");
  });
});

test("REST rejects unsupported methods with an Allow header", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/articles`, { method: "POST" });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET");
    assert.equal((await response.json()).error.code, "METHOD_NOT_ALLOWED");
  });
});

test("REST maps domain errors to stable HTTP statuses and sanitized messages", async () => {
  const scenarios = [
    {
      error: new ArticleInputError("password=must-not-leak"),
      status: 400,
      code: "BAD_USER_INPUT",
      message: "The request input is invalid.",
    },
    {
      error: new ArticleAuthorizationError("private owner id must not leak"),
      status: 403,
      code: "FORBIDDEN",
      message: "You are not allowed to access this resource.",
    },
    {
      error: new ArticleNotFoundError("internal row details must not leak"),
      status: 404,
      code: "NOT_FOUND",
      message: "The requested resource was not found.",
    },
    {
      error: new ArticleSlugConflictError("database constraint name must not leak"),
      status: 409,
      code: "CONFLICT",
      message: "The request conflicts with the current resource state.",
    },
    {
      error: new IdempotencyConflictError("raw payload must not leak"),
      status: 409,
      code: "IDEMPOTENCY_CONFLICT",
      message: "The idempotency key was already used for a different request.",
    },
    {
      error: new DomainError("UnexpectedServiceError", "PRIVATE_INTERNAL_CODE", "private implementation detail"),
      status: 500,
      code: "INTERNAL_SERVER_ERROR",
      message: "The request could not be completed.",
    },
    {
      error: new Error("database password and stack details must not leak"),
      status: 500,
      code: "INTERNAL_SERVER_ERROR",
      message: "The request could not be completed.",
    },
  ];

  for (const scenario of scenarios) {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/articles`);
      assert.equal(response.status, scenario.status);
      assert.deepEqual(await response.json(), {
        error: { code: scenario.code, message: scenario.message },
      });
    }, {
      applicationServices: {
        async listPublishedArticles() {
          throw scenario.error;
        },
      },
    });
  }
});
