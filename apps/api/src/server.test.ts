import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { request as httpRequest } from "node:http";
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
  const header = encode({ alg: "HS256", typ: "application/vnd.bot-thk.access+jwt" });
  const payload = encode({
    sub,
    iss: authEnv.AUTH_JWT_ISSUER,
    aud: authEnv.AUTH_JWT_AUDIENCE,
    iat: Math.floor(Date.now() / 1000),
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
        adapter[method] = method === "consumeRateLimit"
          ? async () => ({ allowed: true, resetAt: new Date(Date.now() + 60000).toISOString() })
          : async () => null;
      }
    }
  }
  return Object.assign(adapter, overrides);
}

async function withServer(run, options = {}) {
  const serverOptions = options.store
    ? { ...options, store: completeFakeAdapter(options.store) }
    : options;
  const server = createApiServer({ ...serverOptions, logger: serverOptions.logger ?? (() => {}) });
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

test("REST private article list derives the actor from the verified JWT", async () => {
  let received;
  const articles = [{ id: "article-1", authorId: "writer-123", slug: "my-work", locale: "zh-CN", title: "My work", author: null, categories: [], tags: [] }];
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/v1/me/articles?limit=10", {
      headers: { authorization: "Bearer " + signedToken("writer-123") },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: articles });
    assert.deepEqual(received, { actorId: "writer-123", locale: "zh-CN", limit: 10 });
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async listMyArticles(args) { received = args; return articles; },
    },
  });
});

test("REST article creation accepts JSON content blocks and never trusts a body authorId", async () => {
  let received;
  const contentBlocks = [{ id: "p1", type: "paragraph", text: "新作品" }];
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/v1/articles", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + signedToken("verified-writer"),
      },
      body: JSON.stringify({
        slug: "new-work", title: "新作品", summary: "简介", locale: "zh-CN",
        contentBlocks, publish: true, workType: "poetry", categoryIds: [], tagIds: [],
      }),
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), {
      data: { id: "created-article", authorId: "verified-writer", slug: "new-work", title: "新作品", locale: "zh-CN", contentBlocks, author: null, categories: [], tags: [] },
    });
    assert.deepEqual(received, {
      authorId: "verified-writer", slug: "new-work", title: "新作品", summary: "简介", locale: "zh-CN",
      contentBlocks, publish: true, workType: "poetry", categoryIds: [], tagIds: [],
    });

    const spoofed = await fetch(baseUrl + "/api/v1/articles", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + signedToken("verified-writer"),
      },
      body: JSON.stringify({ slug: "spoofed", title: "Spoofed", contentBlocks, authorId: "attacker" }),
    });
    assert.equal(spoofed.status, 400);
    assert.equal((await spoofed.json()).error.code, "BAD_USER_INPUT");
    assert.equal(received.slug, "new-work", "unsupported identity fields must not reach persistence");
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async createArticle(args) {
        received = args;
        return { id: "created-article", authorId: args.authorId, slug: args.slug, title: args.title, locale: args.locale, contentBlocks: args.contentBlocks };
      },
    },
  });
});

test("REST article writes normalize Lexical EditorState into the application-owned v1 content contract", async () => {
  let createdInput;
  let updatedInput;
  const articleId = "11111111-1111-4111-8111-111111111111";
  const editorState = {
    root: {
      children: [
        {
          children: [
            { detail: 0, format: 1, mode: "normal", style: "", text: "中文", type: "text", version: 1 },
            {
              children: [
                { detail: 0, format: 0, mode: "normal", style: "", text: "链接", type: "text", version: 1 },
              ],
              direction: null, format: "", indent: 0, type: "link",
              url: "/articles/example", rel: null, target: null, title: null, version: 1,
            },
          ],
          direction: null, format: "", indent: 0, type: "paragraph", version: 1,
        },
      ],
      direction: null, format: "", indent: 0, type: "root", version: 1,
    },
  };
  const expectedBlocks = [{
    id: "lexical-block-1",
    type: "paragraph",
    text: "中文链接",
    inlines: [
      { text: "中文", marks: ["bold"] },
      { text: "链接", href: "/articles/example" },
    ],
  }];

  await withServer(async (baseUrl) => {
    const created = await fetch(baseUrl + "/api/v1/articles", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + signedToken("verified-writer"),
      },
      body: JSON.stringify({
        slug: "lexical-work", title: "Lexical 作品", editorState, publish: true,
      }),
    });
    assert.equal(created.status, 201);
    assert.deepEqual(createdInput.contentBlocks, expectedBlocks);
    assert.equal(createdInput.contentBlocksVersion, 1);
    assert.equal(Object.hasOwn(createdInput, "editorState"), false);

    const updated = await fetch(baseUrl + "/api/v1/articles/" + articleId, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + signedToken("verified-writer"),
      },
      body: JSON.stringify({
        slug: "lexical-work-updated", title: "更新后的作品", editorState, contentBlocksVersion: 1, publish: false,
      }),
    });
    assert.equal(updated.status, 200);
    assert.deepEqual(updatedInput.contentBlocks, expectedBlocks);
    assert.equal(updatedInput.contentBlocksVersion, 1);
    assert.equal(Object.hasOwn(updatedInput, "editorState"), false);
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async createArticle(args) {
        createdInput = args;
        return { id: "created-article", authorId: args.authorId, slug: args.slug, title: args.title, locale: args.locale, contentBlocks: args.contentBlocks, contentBlocksVersion: args.contentBlocksVersion };
      },
      async updateArticle(args) {
        updatedInput = args;
        return { id: args.articleId, actorId: args.actorId, slug: args.slug, title: args.title, locale: args.locale, contentBlocks: args.contentBlocks, contentBlocksVersion: args.contentBlocksVersion };
      },
    },
  });
});

test("REST article writes reject ambiguous or unsupported Lexical editor payloads before persistence", async () => {
  let writes = 0;
  const editorState = {
    root: {
      children: [{
        children: [{ detail: 0, format: 0, mode: "normal", style: "", text: "Cover", type: "text", version: 1 }],
        direction: null, format: "", indent: 0, type: "image", version: 1, src: "/cover.png",
      }],
      direction: null, format: "", indent: 0, type: "root", version: 1,
    },
  };

  await withServer(async (baseUrl) => {
    const requests = [
      { slug: "mixed-input", title: "Mixed", editorState, contentBlocks: [{ id: "p", type: "paragraph", text: "text" }] },
      { slug: "unsupported-image", title: "Unsupported", editorState },
      { slug: "wrong-version", title: "Wrong version", editorState, contentBlocksVersion: 0 },
    ];
    for (const payload of requests) {
      const response = await fetch(baseUrl + "/api/v1/articles", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + signedToken("verified-writer"),
        },
        body: JSON.stringify(payload),
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, "BAD_USER_INPUT");
    }
    assert.equal(writes, 0);
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async createArticle() { writes += 1; return {}; },
    },
  });
});

test("REST article updates derive actorId from JWT and use the path article ID", async () => {
  let received;
  const contentBlocks = [{ id: "p1", type: "paragraph", text: "更新后的作品" }];
  const articleId = "11111111-1111-4111-8111-111111111111";
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/v1/articles/" + articleId, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + signedToken("verified-writer"),
      },
      body: JSON.stringify({
        slug: "updated-work", title: "更新后的作品", contentBlocks, publish: false, locale: "zh-CN",
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      data: { id: articleId, actorId: "verified-writer", slug: "updated-work", title: "更新后的作品", contentBlocks, author: null, categories: [], tags: [] },
    });
    assert.deepEqual(received, {
      articleId, actorId: "verified-writer", slug: "updated-work", title: "更新后的作品",
      contentBlocks, publish: false, locale: "zh-CN",
    });
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async updateArticle(args) {
        received = args;
        return { id: args.articleId, actorId: args.actorId, slug: args.slug, title: args.title, contentBlocks: args.contentBlocks };
      },
    },
  });
});

test("REST article writes require verified non-revoked authentication and a supported locale", async () => {
  let writes = 0;
  const contentBlocks = [{ id: "p1", type: "paragraph", text: "Text" }];
  await withServer(async (baseUrl) => {
    const unauthorized = await fetch(baseUrl + "/api/v1/articles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "private", title: "Private", contentBlocks }),
    });
    assert.equal(unauthorized.status, 401);
    assert.equal((await unauthorized.json()).error.code, "UNAUTHENTICATED");

    const unsupportedLocale = await fetch(baseUrl + "/api/v1/articles", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + signedToken("writer"),
      },
      body: JSON.stringify({ slug: "unsupported", title: "Unsupported", contentBlocks, locale: "fr" }),
    });
    assert.equal(unsupportedLocale.status, 400);
    assert.equal((await unsupportedLocale.json()).error.code, "BAD_USER_INPUT");

    const revoked = await fetch(baseUrl + "/api/v1/me/articles", {
      headers: { authorization: "Bearer " + signedToken("revoked-writer") },
    });
    assert.equal(revoked.status, 401);
    assert.equal((await revoked.json()).error.code, "UNAUTHENTICATED");
    assert.equal(writes, 0);
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked(sessionId) { return sessionId === "session-revoked-writer"; },
      async createArticle() { writes += 1; return {}; },
      async listMyArticles() { writes += 1; return []; },
    },
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
  const authorProfile = {
    userId: "user-123", displayName: "Writer", bio: "简介", avatarUrl: null, websiteUrl: null,
    locale: "zh-CN", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
    followerCount: 0, followingCount: 0, isFollowing: false,
  };
  const articles = [{ id: "article-1", authorId: "user-123", slug: "hello-world", locale: "zh-CN", title: "Hello", author: authorProfile, categories: [], tags: [] }];
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/authors/user-123/articles?query=hello&limit=10&offset=20`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: articles });
    assert.deepEqual(received, { authorId: "user-123", locale: "zh-CN", query: "hello", limit: 10, offset: 20 });
  }, {
    store: {
      async getAuthorProfile(args) {
        return { ...authorProfile, locale: args.locale };
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
    author: null, categories: [], tags: [],
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
      data: { id: "article-1", slug: "hello-world", locale: "zh-CN", title: "Hello", author: null, categories: [], tags: [] },
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
        return args.slug === "poetry" ? { id: "category-1", slug: args.slug, locale: args.locale, name: "诗歌" } : null;
      },
    },
  });
});

test("REST category articles verify category visibility and forward pagination", async () => {
  let received;
  let categoryLookups = 0;
  const articles = [{ id: "article-1", slug: "poem-one", locale: "zh-CN", title: "Poem One", author: null, categories: [], tags: [] }];
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
      data: { id: "tag-1", kind: "tag", slug: "ai-abc123", name: "人工智能", locale: "zh-CN", articleCount: 2 },
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
          ? { id: "tag-1", kind: "tag", slug: args.slug, name: "人工智能", locale: args.locale, articleCount: 2 }
          : null;
      },
    },
  });
});

test("REST tag articles verify localized tag visibility before listing and forward pagination", async () => {
  const calls = [];
  const articles = [{ id: "article-1", slug: "article-about-ai", locale: "zh-CN", title: "AI", author: null, categories: [], tags: [] }];
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
test("REST write rate limits return 429 and Retry-After before invoking a mutation", async () => {
  const calls = [];
  let writes = 0;
  const applicationServices = {
    async isSessionRevoked() { return false; },
    async consumeRateLimit(input) {
      calls.push(input);
      return {
        allowed: calls.length === 1,
        resetAt: new Date(Date.now() + 3200).toISOString(),
      };
    },
    async createArticle() { writes += 1; return {}; },
  };
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/v1/articles", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + signedToken("rate-limited-writer"),
        "x-forwarded-for": "203.0.113.99",
      },
      body: JSON.stringify({
        slug: "rate-limited",
        title: "Rate limited",
        contentBlocks: [{ id: "p1", type: "paragraph", text: "Test" }],
      }),
    });
    assert.equal(response.status, 429);
    assert.match(response.headers.get("retry-after") ?? "", /^[1-4]$/);
    assert.deepEqual(await response.json(), {
      error: { code: "RATE_LIMITED", message: "Too many requests. Try again later." },
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((call) => call.limit), [10, 30]);
    assert.ok(calls.every((call) => /^[a-f0-9]{64}$/.test(call.key)));
    assert.ok(calls.every((call) => !call.key.includes("203.0.113.99") && !call.key.includes("rate-limited-writer")));
    assert.equal(writes, 0);
  }, { env: authEnv, applicationServices });
});

test("REST write rate limiter ignores spoofed forwarding headers and uses the verified user", async () => {
  const calls = [];
  const applicationServices = {
    async isSessionRevoked() { return false; },
    async consumeRateLimit(input) {
      calls.push(input);
      return { allowed: true, resetAt: new Date(Date.now() + 60000).toISOString() };
    },
    async createArticle() { throw new Error("The rate-limit smoke test must not reach persistence."); },
  };
  await withServer(async (baseUrl) => {
    for (const forwardedFor of ["198.51.100.1", "198.51.100.2"]) {
      const response = await fetch(baseUrl + "/api/v1/articles", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + signedToken("same-writer"),
          "x-forwarded-for": forwardedFor,
        },
        body: "not json",
      });
      // The request passed throttling and then reached normal JSON validation.
      assert.equal(response.status, 400);
    }
    assert.equal(calls.length, 4);
    assert.equal(calls[0].key, calls[2].key, "verified user bucket must be stable");
    assert.equal(calls[1].key, calls[3].key, "IP bucket must use the socket peer, not X-Forwarded-For");
  }, { env: authEnv, applicationServices });
});

test("REST rejects unsupported locales, oversized search terms and offsets before persistence", async () => {
  let calls = 0;
  const oversizedQuery = "x".repeat(201);
  await withServer(async (baseUrl) => {
    for (const path of [
      "/api/v1/articles?locale=fr",
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

test("REST public content routes accept zh-CN, zh-TW and en without locale fallback", async () => {
  const calls: Array<[string, string]> = [];
  await withServer(async (baseUrl) => {
    for (const locale of ["zh-CN", "zh-TW", "en"]) {
      for (const path of [
        `/api/v1/articles?locale=${locale}`,
        `/api/v1/categories?locale=${locale}`,
        `/api/v1/tags?locale=${locale}`,
      ]) {
        const response = await fetch(baseUrl + path);
        assert.equal(response.status, 200, path);
        assert.deepEqual((await response.json()).data, [], path);
      }
    }
    assert.deepEqual(calls, [
      ["article", "zh-CN"], ["category", "zh-CN"], ["tag", "zh-CN"],
      ["article", "zh-TW"], ["category", "zh-TW"], ["tag", "zh-TW"],
      ["article", "en"], ["category", "en"], ["tag", "en"],
    ]);
  }, {
    store: {
      async listPublishedArticles(args) { calls.push(["article", args.locale]); return []; },
      async listTaxonomies(args) { calls.push([args.kind, args.locale]); return []; },
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
    const response = await fetch(baseUrl + "/api/v1/categories", { method: "POST" });
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




test("REST current user and profile reads require JWT and preserve all AuthorProfile fields", async () => {
  const profile = {
    userId: "me-user", displayName: "作者", bio: "个人简介",
    avatarUrl: "/media/avatar.png", websiteUrl: "https://example.test/",
    locale: "zh-CN", createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-02-01T00:00:00.000Z", followerCount: 7,
    followingCount: 4, isFollowing: true,
  };
  await withServer(async (baseUrl) => {
    const me = await fetch(baseUrl + "/api/v1/me", {
      headers: { authorization: "Bearer " + signedToken("me-user") },
    });
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), { data: { id: "me-user" } });

    const profileResponse = await fetch(baseUrl + "/api/v1/me/profile?locale=zh-CN", {
      headers: { authorization: "Bearer " + signedToken("me-user") },
    });
    assert.equal(profileResponse.status, 200);
    assert.deepEqual(await profileResponse.json(), { data: profile });
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async getAuthorProfile(args) {
        assert.deepEqual(args, { userId: "me-user", locale: "zh-CN", viewerId: "me-user" });
        return profile;
      },
    },
  });
});

test("REST user search and relationship lists preserve complete author fields", async () => {
  const calls = [];
  const profile = {
    userId: "target-user", displayName: "作者甲", bio: "简介",
    avatarUrl: null, websiteUrl: null, locale: "zh-CN",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
    followerCount: 5, followingCount: 2, isFollowing: false,
  };
  await withServer(async (baseUrl) => {
    const search = await fetch(baseUrl + "/api/v1/users?query=%E4%BD%9C%E8%80%85&limit=7&locale=zh-CN", {
      headers: { authorization: "Bearer " + signedToken("viewer-user") },
    });
    assert.equal(search.status, 200);
    assert.deepEqual(await search.json(), { data: [profile] });
    assert.deepEqual(calls[0], ["search", { query: "作者", locale: "zh-CN", limit: 7, viewerId: "viewer-user" }]);

    for (const relation of ["followers", "following"]) {
      const response = await fetch(baseUrl + "/api/v1/users/target-user/" + relation + "?limit=9", {
        headers: { authorization: "Bearer " + signedToken("viewer-user") },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { data: [profile] });
    }
    assert.deepEqual(calls[1], ["followers", { userId: "target-user", locale: "zh-CN", limit: 9, viewerId: "viewer-user" }]);
    assert.deepEqual(calls[2], ["following", { userId: "target-user", locale: "zh-CN", limit: 9, viewerId: "viewer-user" }]);
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async searchUsers(args) { calls.push(["search", args]); return [profile]; },
      async listFollowers(args) { calls.push(["followers", args]); return [profile]; },
      async listFollowing(args) { calls.push(["following", args]); return [profile]; },
    },
  });
});

test("REST liked articles, related articles, and article like info are available", async () => {
  const calls = [];
  const writerProfile = {
    userId: "writer-user", displayName: "作者", bio: "简介", avatarUrl: "/avatar.png",
    websiteUrl: "https://writer.example/", locale: "zh-CN",
    createdAt: "2025-12-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    followerCount: 4, followingCount: 3, isFollowing: true,
  };
  const category = { id: "category-1", kind: "category", slug: "poetry", name: "诗歌", description: "", locale: "zh-CN", createdBy: "admin-user", articleCount: 2 };
  const tag = { id: "tag-1", kind: "tag", slug: "modern-poetry", name: "现代诗", description: "", locale: "zh-CN", createdBy: "writer-user", articleCount: 7 };
  const article = {
    id: "article-1", authorId: "writer-user", slug: "poetry-work", workType: "poetry",
    status: "published", locale: "zh-CN", title: "诗", summary: "摘要",
    contentBlocks: [{ id: "p1", type: "paragraph", text: "正文" }],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
    publishedAt: "2026-01-02T00:00:00.000Z", author: writerProfile, categories: [category], tags: [tag],
  };
  const likeInfo = { articleId: "article-1", slug: "poetry-work", likeCount: 12, likedByViewer: true };
  await withServer(async (baseUrl) => {
    const liked = await fetch(baseUrl + "/api/v1/me/liked-articles?limit=8", {
      headers: { authorization: "Bearer " + signedToken("reader-user") },
    });
    assert.equal(liked.status, 200);
    assert.deepEqual(await liked.json(), { data: [article] });
    assert.deepEqual(calls[0], ["liked", { actorId: "reader-user", locale: "zh-CN", limit: 8 }]);

    const related = await fetch(baseUrl + "/api/v1/articles/poetry-work/related?limit=4", {
      headers: { authorization: "Bearer " + signedToken("reader-user") },
    });
    assert.equal(related.status, 200);
    assert.deepEqual(await related.json(), { data: [article] });
    assert.deepEqual(calls[1], ["related", { slug: "poetry-work", locale: "zh-CN", limit: 4 }]);

    const like = await fetch(baseUrl + "/api/v1/articles/poetry-work/like", {
      headers: { authorization: "Bearer " + signedToken("reader-user") },
    });
    assert.equal(like.status, 200);
    assert.deepEqual(await like.json(), { data: likeInfo });
    assert.deepEqual(calls[2], ["like", { slug: "poetry-work", locale: "zh-CN", actorId: "reader-user" }]);
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async listLikedArticles(args) { calls.push(["liked", args]); return [article]; },
      async listRelatedArticles(args) { calls.push(["related", args]); return [article]; },
      async getAuthorProfile(args) { return { ...writerProfile, isFollowing: args.viewerId === "reader-user" }; },
      async listArticleTaxonomies(args) { return args.kind === "category" ? [category] : [tag]; },
      async getArticleLikeInfo(args) { calls.push(["like", args]); return likeInfo; },
    },
  });
});

test("REST public author profile reflects the optional viewer follow state", async () => {
  let received;
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/v1/authors/target-user", {
      headers: { authorization: "Bearer " + signedToken("viewer-user") },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      data: {
        userId: "target-user", displayName: "目标作者", bio: "",
        avatarUrl: null, websiteUrl: null, locale: "zh-CN",
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
        followerCount: 2, followingCount: 1, isFollowing: true,
      },
    });
    assert.deepEqual(received, { userId: "target-user", locale: "zh-CN", viewerId: "viewer-user" });
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async getAuthorProfile(args) {
        received = args;
        return {
          userId: args.userId, displayName: "目标作者", bio: "",
          avatarUrl: null, websiteUrl: null, locale: args.locale,
          createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
          followerCount: 2, followingCount: 1, isFollowing: args.viewerId === "viewer-user",
        };
      },
    },
  });
});

test("REST current-session logout persists jti revocation through the token expiry", async () => {
  let received;
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/v1/me/session", {
      method: "DELETE",
      headers: { authorization: "Bearer " + signedToken("logout-user") },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: true });
    assert.equal(received.sessionId, "session-logout-user");
    assert.ok(received.expiresAt instanceof Date);
    assert.ok(received.expiresAt.getTime() > Date.now());
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async revokeSession(args) { received = args; return true; },
    },
  });
});

test("REST authentication fails closed if durable session revocation cannot be checked", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/v1/me/articles", {
      headers: { authorization: "Bearer " + signedToken("reader-user") },
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, "UNAUTHENTICATED");
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { throw new Error("database unavailable"); },
      async listMyArticles() { throw new Error("must not be called"); },
    },
  });
});

test("REST optional viewer authentication does not grant viewer state to revoked sessions", async () => {
  let received;
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/v1/articles/poetry-work/like", {
      headers: { authorization: "Bearer " + signedToken("revoked-viewer") },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(received, { slug: "poetry-work", locale: "zh-CN", actorId: null });
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked(sessionId) { return sessionId === "session-revoked-viewer"; },
      async getArticleLikeInfo(args) { received = args; return null; },
    },
  });
});

test("REST profile update derives userId from the JWT and rejects identity fields", async () => {
  const received: { upsert: Record<string, unknown> | null; read: Record<string, unknown> | null } = { upsert: null, read: null };
  const savedProfile = {
    userId: "profile-owner", displayName: "新名字", bio: "简介", avatarUrl: null,
    websiteUrl: "https://example.test/", locale: "zh-CN", followerCount: 0,
    followingCount: 0, isFollowing: false,
  };
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/v1/me/profile", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + signedToken("profile-owner"),
      },
      body: JSON.stringify({
        displayName: "新名字", bio: "简介", avatarUrl: null,
        websiteUrl: "https://example.test/", locale: "zh-CN",
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: savedProfile });
    assert.deepEqual(received.upsert, {
      userId: "profile-owner", displayName: "新名字", bio: "简介",
      avatarUrl: null, websiteUrl: "https://example.test/", locale: "zh-CN",
    });
    assert.deepEqual(received.read, { userId: "profile-owner", locale: "zh-CN", viewerId: "profile-owner" });

    const spoofed = await fetch(baseUrl + "/api/v1/me/profile", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + signedToken("profile-owner"),
      },
      body: JSON.stringify({ displayName: "冒名", userId: "victim" }),
    });
    assert.equal(spoofed.status, 400);
    assert.equal((await spoofed.json()).error.code, "BAD_USER_INPUT");
    assert.equal(received.upsert.userId, "profile-owner");
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async upsertAuthorProfile(args) { received.upsert = args; },
      async getAuthorProfile(args) {
        received.read = args;
        return { ...savedProfile, userId: args.userId, locale: args.locale };
      },
    },
  });
});

test("REST follow and unfollow use stable target userId and verified actor identity", async () => {
  const calls = [];
  let isFollowing = false;
  const getProfile = () => ({
    userId: "target-user", displayName: "目标作者", bio: "", avatarUrl: null, websiteUrl: null,
    locale: "zh-CN", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
    followerCount: isFollowing ? 1 : 0, followingCount: 0, isFollowing,
  });
  await withServer(async (baseUrl) => {
    const follow = await fetch(baseUrl + "/api/v1/users/target-user/follow", {
      method: "POST",
      headers: { authorization: "Bearer " + signedToken("follower-user") },
    });
    assert.equal(follow.status, 200);
    assert.deepEqual(await follow.json(), { data: getProfile() });

    const unfollow = await fetch(baseUrl + "/api/v1/users/target-user/follow", {
      method: "DELETE",
      headers: { authorization: "Bearer " + signedToken("follower-user") },
    });
    assert.equal(unfollow.status, 200);
    assert.deepEqual(await unfollow.json(), { data: getProfile() });
    assert.deepEqual(calls, [
      ["follow", { actorId: "follower-user", targetUserId: "target-user" }],
      ["unfollow", { actorId: "follower-user", targetUserId: "target-user" }],
    ]);
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async followUser(args) { calls.push(["follow", args]); isFollowing = true; },
      async unfollowUser(args) { calls.push(["unfollow", args]); isFollowing = false; },
      async getAuthorProfile(args) {
        assert.deepEqual(args, { userId: "target-user", locale: "zh-CN", viewerId: "follower-user" });
        return getProfile();
      },
    },
  });
});

test("REST article like endpoint sets an explicit idempotent state rather than toggling", async () => {
  const calls = [];
  await withServer(async (baseUrl) => {
    for (const liked of [true, true, false]) {
      const response = await fetch(baseUrl + "/api/v1/articles/poetry-work/like?locale=zh-CN", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + signedToken("reader-user"),
        },
        body: JSON.stringify({ liked }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.data.likedByViewer, liked);
      assert.equal(body.data.slug, "poetry-work");
    }
    const spoofed = await fetch(baseUrl + "/api/v1/articles/poetry-work/like", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + signedToken("reader-user"),
      },
      body: JSON.stringify({ liked: true, actorId: "attacker" }),
    });
    assert.equal(spoofed.status, 400);
    assert.equal((await spoofed.json()).error.code, "BAD_USER_INPUT");
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map((call) => call.liked), [true, true, false]);
    assert.ok(calls.every((call) => call.actorId === "reader-user"));
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async setArticleLike(args) {
        calls.push(args);
        return {
          articleId: "article-1", slug: args.slug, likeCount: args.liked ? 1 : 0,
          likedByViewer: args.liked,
        };
      },
    },
  });
});

test("REST article comments support public listing and authenticated replies", async () => {
  const calls = [];
  const parentCommentId = "11111111-1111-4111-8111-111111111111";
  const commenterProfile = {
    userId: "commenter-user", displayName: "评论者", bio: "简介", avatarUrl: null,
    websiteUrl: null, locale: "zh-CN",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
    followerCount: 2, followingCount: 5, isFollowing: false,
  };
  const rootComment = {
    id: parentCommentId, articleId: "article-1", authorId: "root-author",
    parentCommentId: null, content: "根评论", createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z", locale: "zh-CN", author: null, replies: [],
  };
  const comment = {
    id: "22222222-2222-4222-8222-222222222222", articleId: "article-1",
    authorId: "commenter-user", parentCommentId, content: "很好的观点",
    createdAt: "2026-01-03T00:00:00.000Z", updatedAt: "2026-01-03T00:00:00.000Z",
    locale: "zh-CN", author: commenterProfile, replies: [],
  };
  await withServer(async (baseUrl) => {
    const listed = await fetch(baseUrl + "/api/v1/articles/poetry-work/comments?limit=10");
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), { data: [rootComment] });
    assert.deepEqual(calls[0], { kind: "list", args: { slug: "poetry-work", locale: "zh-CN", limit: 10 } });

    const created = await fetch(baseUrl + "/api/v1/articles/poetry-work/comments", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + signedToken("commenter-user"),
      },
      body: JSON.stringify({ content: "很好的观点", parentCommentId }),
    });
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), { data: comment });
    assert.deepEqual(calls[1], {
      kind: "create",
      args: {
        slug: "poetry-work", locale: "zh-CN", actorId: "commenter-user",
        content: "很好的观点", contentBlocks: null, contentBlocksVersion: 0, parentCommentId,
      },
    });
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async listArticleComments(args) {
        calls.push({ kind: "list", args });
        return [rootComment];
      },
      async getAuthorProfile(args) {
        return args.userId === "commenter-user" ? commenterProfile : null;
      },
      async createArticleComment(args) {
        calls.push({ kind: "create", args });
        return comment;
      },
    },
  });
});

test("REST article comments normalize Lexical state to a versioned paragraph-only document", async () => {
  const received = [];
  const editorState = {
    root: {
      children: [
        { children: [
          { detail: 0, format: 1, mode: "normal", style: "", text: "重点", type: "text", version: 1 },
          { detail: 0, format: 0, mode: "normal", style: "", text: " ", type: "text", version: 1 },
          { children: [{ detail: 0, format: 0, mode: "normal", style: "", text: "链接", type: "text", version: 1 }],
            direction: null, format: "", indent: 0, type: "link", url: "/articles/example", rel: null, target: null, title: null, version: 1 },
        ], direction: null, format: "", indent: 0, type: "paragraph", version: 1 },
        { children: [{ detail: 0, format: 0, mode: "normal", style: "", text: "第二段", type: "text", version: 1 }],
          direction: null, format: "", indent: 0, type: "paragraph", version: 1 },
      ],
      direction: null, format: "", indent: 0, type: "root", version: 1,
    },
  };
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/v1/articles/poetry-work/comments", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + signedToken("commenter-user") },
      body: JSON.stringify({ editorState, parentCommentId: null }),
    });
    assert.equal(response.status, 201);
    assert.deepEqual(received[0], {
      slug: "poetry-work", locale: "zh-CN", actorId: "commenter-user",
      content: "重点 链接\n第二段",
      contentBlocks: [
        { id: "lexical-block-1", type: "paragraph", text: "重点 链接", inlines: [{ text: "重点", marks: ["bold"] }, { text: " " }, { text: "链接", href: "/articles/example" }] },
        { id: "lexical-block-2", type: "paragraph", text: "第二段" },
      ],
      contentBlocksVersion: 1, parentCommentId: null,
    });
    const responseBody = await response.json();
    assert.equal(responseBody.data.contentBlocksVersion, 1);
    assert.deepEqual(responseBody.data.contentBlocks, received[0].contentBlocks);
    for (const invalidPayload of [
      { editorState: { root: { type: "root", version: 1, children: [{ type: "image", version: 1, children: [], direction: null, format: "", indent: 0, src: "/x" }] } } },
      { content: "plain", editorState },
      { contentBlocks: [{ id: "h", type: "heading", level: 2, text: "Heading" }] },
      { editorState, contentBlocksVersion: 0 },
    ]) {
      const rejected = await fetch(baseUrl + "/api/v1/articles/poetry-work/comments", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + signedToken("commenter-user") },
        body: JSON.stringify(invalidPayload),
      });
      assert.equal(rejected.status, 400);
      assert.equal((await rejected.json()).error.code, "BAD_USER_INPUT");
    }
    assert.equal(received.length, 1);
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async getAuthorProfile() { return null; },
      async createArticleComment(args) {
        received.push(args);
        return { id: "rich-comment", articleId: "article-1", authorId: args.actorId, parentCommentId: args.parentCommentId, content: args.content, contentBlocks: args.contentBlocks, contentBlocksVersion: args.contentBlocksVersion, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", locale: args.locale, replies: [] };
      },
    },
  });
});

test("REST comment deletion derives actor identity from JWT and returns deletion state", async () => {
  const commentId = "22222222-2222-4222-8222-222222222222";
  let received;
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/v1/comments/" + commentId, {
      method: "DELETE",
      headers: { authorization: "Bearer " + signedToken("comment-author") },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { deleted: true } });
    assert.deepEqual(received, { commentId, actorId: "comment-author" });

    const unauthorized = await fetch(baseUrl + "/api/v1/comments/" + commentId, { method: "DELETE" });
    assert.equal(unauthorized.status, 401);
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async deleteArticleComment(args) { received = args; return true; },
    },
  });
});

test("REST profile and engagement routes enforce their declared HTTP methods", async () => {
  await withServer(async (baseUrl) => {
    const profile = await fetch(baseUrl + "/api/v1/me/profile", { method: "POST" });
    assert.equal(profile.status, 405);
    assert.equal(profile.headers.get("allow"), "GET, PUT");

    const follow = await fetch(baseUrl + "/api/v1/users/some-user/follow");
    assert.equal(follow.status, 405);
    assert.equal(follow.headers.get("allow"), "POST, DELETE");

    const like = await fetch(baseUrl + "/api/v1/articles/some-article/like", { method: "PATCH" });
    assert.equal(like.status, 405);
    assert.equal(like.headers.get("allow"), "GET, PUT");

    const comments = await fetch(baseUrl + "/api/v1/articles/some-article/comments", { method: "DELETE" });
    assert.equal(comments.status, 405);
    assert.equal(comments.headers.get("allow"), "GET, POST");
  });
});

test("REST rejects invalid UTF-8 rather than replacing bytes while parsing JSON", async () => {
  await withServer(async (baseUrl) => {
    // This would become syntactically valid JSON containing U+FFFD if the
    // request were decoded with Buffer.toString("utf8")'s replacement mode.
    const invalidUtf8Json = Buffer.from([
      0x7b, 0x22, 0x6e, 0x61, 0x6d, 0x65, 0x22, 0x3a, 0x22,
      0xff,
      0x22, 0x7d,
    ]);
    const response = await fetch(baseUrl + "/api/v1/tags", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: invalidUtf8Json,
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: { code: "BAD_USER_INPUT", message: "The request body must be valid JSON." },
    });
  }, { store: {} });
});

test("REST stops reading oversized chunked JSON bodies and closes the connection", async () => {
  await withServer(async (baseUrl) => {
    const parsedUrl = new URL(baseUrl);
    let clientRequest;
    const response = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        clientRequest?.destroy();
        reject(new Error("The API waited for the oversized request stream to finish instead of rejecting it."));
      }, 3000);
      clientRequest = httpRequest({
        hostname: parsedUrl.hostname,
        port: Number(parsedUrl.port),
        path: "/api/v1/tags",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "transfer-encoding": "chunked",
        },
      }, (incomingResponse) => {
        const chunks = [];
        incomingResponse.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        incomingResponse.on("end", () => {
          clearTimeout(timeout);
          resolve({
            status: incomingResponse.statusCode,
            connection: incomingResponse.headers.connection,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      });
      clientRequest.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      // Deliberately do not end the request. A bounded reader must reject the
      // chunked stream as soon as the byte limit is crossed, not wait for EOF.
      clientRequest.write(Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));
    });

    assert.equal(response.status, 413);
    assert.equal(response.connection, "close");
    assert.deepEqual(JSON.parse(response.body), {
      error: { code: "PAYLOAD_TOO_LARGE", message: "The JSON request body is too large." },
    });
  }, { store: {} });
});

test("REST taxonomy mutations preserve normalization inputs, creator identity, and ownership result", async () => {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const tag = {
    id: "99999999-9999-4999-8999-999999999999", kind: "tag", slug: "ai-abc123", name: "人工智能", description: "",
    locale: "zh-CN", createdBy: "writer-user", articleCount: 0,
  };
  const category = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind: "category", slug: "poetry", name: "诗歌", description: "诗歌分类",
    locale: "zh-CN", createdBy: "writer-user", articleCount: 2,
  };
  await withServer(async (baseUrl) => {
    const headers = { authorization: "Bearer " + signedToken("writer-user"), "content-type": "application/json" };
    const createdTag = await fetch(baseUrl + "/api/v1/tags", { method: "POST", headers, body: JSON.stringify({ name: "人工智能" }) });
    assert.equal(createdTag.status, 201);
    assert.deepEqual(await createdTag.json(), { data: tag });

    const createdCategory = await fetch(baseUrl + "/api/v1/taxonomies", {
      method: "POST", headers,
      body: JSON.stringify({ kind: "category", slug: "poetry", name: "诗歌", description: "诗歌分类" }),
    });
    assert.equal(createdCategory.status, 201);
    assert.deepEqual(await createdCategory.json(), { data: category });

    const deleted = await fetch(baseUrl + "/api/v1/taxonomies/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { method: "DELETE", headers: { authorization: headers.authorization } });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { data: true });

    const wrongLocale = await fetch(baseUrl + "/api/v1/taxonomies", {
      method: "POST", headers,
      body: JSON.stringify({ kind: "category", slug: "poetry", name: "诗歌", locale: "fr" }),
    });
    assert.equal(wrongLocale.status, 400);
    assert.equal((await wrongLocale.json()).error.code, "BAD_USER_INPUT");

    const unsupported = await fetch(baseUrl + "/api/v1/tags", {
      method: "POST", headers, body: JSON.stringify({ name: "tag", actorId: "attacker" }),
    });
    assert.equal(unsupported.status, 400);

    const unauthenticated = await fetch(baseUrl + "/api/v1/tags", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "tag" }),
    });
    assert.equal(unauthenticated.status, 401);
  }, {
    env: authEnv,
    store: {
      async createTag(args) { calls.push({ method: "createTag", args }); return tag; },
      async createTaxonomy(args) { calls.push({ method: "createTaxonomy", args }); return category; },
      async deleteTaxonomy(args) { calls.push({ method: "deleteTaxonomy", args }); return true; },
    },
  });
  assert.deepEqual(calls, [
    { method: "createTag", args: { actorId: "writer-user", name: "人工智能", locale: "zh-CN" } },
    { method: "createTaxonomy", args: { kind: "category", slug: "poetry", name: "诗歌", description: "诗歌分类", locale: "zh-CN", actorId: "writer-user" } },
    { method: "deleteTaxonomy", args: { taxonomyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", actorId: "writer-user" } },
  ]);
});

test("REST conversation and message routes preserve full fields, cursor order contract, membership context, and idempotency", async () => {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const conversation = {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", createdBy: "writer-user", participantIds: ["reader-user", "writer-user"],
    createdAt: "2026-01-01T00:00:00.000Z", lastActivityAt: "2026-01-02T00:00:00.000Z",
    unreadCount: 2,
    lastMessage: { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", senderId: "reader-user", body: "收到", createdAt: "2026-01-02T00:00:00.000Z" },
  };
  const message = { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", senderId: "writer-user", body: "你好", createdAt: "2026-01-03T00:00:00.000Z" };
  await withServer(async (baseUrl) => {
    const authorization = "Bearer " + signedToken("writer-user");
    const jsonHeaders = { authorization, "content-type": "application/json" };

    const created = await fetch(baseUrl + "/api/v1/conversations", {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ participantIds: ["reader-user"] }),
    });
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), { data: conversation });

    const listed = await fetch(baseUrl + "/api/v1/conversations?limit=5", { headers: { authorization } });
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), { data: [conversation] });

    const history = await fetch(baseUrl + "/api/v1/conversations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/messages?limit=2&before=eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", { headers: { authorization } });
    assert.equal(history.status, 200);
    assert.deepEqual(await history.json(), { data: [message] });

    const sent = await fetch(baseUrl + "/api/v1/conversations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/messages", {
      method: "POST", headers: { ...jsonHeaders, "idempotency-key": "send-once-1" }, body: JSON.stringify({ body: "你好" }),
    });
    assert.equal(sent.status, 201);
    assert.deepEqual(await sent.json(), { data: message });

    const bodyIdentityRejected = await fetch(baseUrl + "/api/v1/conversations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/messages", {
      method: "POST", headers: { ...jsonHeaders, "idempotency-key": "send-once-2" },
      body: JSON.stringify({ body: "你好", senderId: "admin-user" }),
    });
    assert.equal(bodyIdentityRejected.status, 400);

    const missingKeyRejected = await fetch(baseUrl + "/api/v1/conversations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/messages", {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ body: "另一条消息" }),
    });
    assert.equal(missingKeyRejected.status, 400);

    const updated = await fetch(baseUrl + "/api/v1/conversations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/participants", {
      method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ addUserIds: ["third-user"], removeUserIds: [] }),
    });
    assert.equal(updated.status, 200);
    assert.deepEqual(await updated.json(), { data: conversation });

    const markedRead = await fetch(baseUrl + "/api/v1/conversations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/read", { method: "PUT", headers: { authorization } });
    assert.equal(markedRead.status, 200);
    assert.deepEqual(await markedRead.json(), { data: true });

    const deleted = await fetch(baseUrl + "/api/v1/conversations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", { method: "DELETE", headers: { authorization } });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { data: true });

    const unauthenticated = await fetch(baseUrl + "/api/v1/conversations");
    assert.equal(unauthenticated.status, 401);
  }, {
    env: authEnv,
    store: {
      async createConversation(args) { calls.push({ method: "createConversation", args }); return conversation; },
      async listConversations(args) { calls.push({ method: "listConversations", args }); return [conversation]; },
      async listConversationMessages(args) { calls.push({ method: "listConversationMessages", args }); return [message]; },
      async persistMessage(args) { calls.push({ method: "persistMessage", args }); return message; },
      async getConversation(args) { calls.push({ method: "getConversation", args }); return conversation; },
      async updateConversationParticipants(args) { calls.push({ method: "updateConversationParticipants", args }); return ["reader-user", "third-user", "writer-user"]; },
      async markConversationAsRead(args) { calls.push({ method: "markConversationAsRead", args }); return true; },
      async deleteConversation(args) { calls.push({ method: "deleteConversation", args }); return true; },
    },
  });

  assert.deepEqual(calls[0], { method: "createConversation", args: { actorId: "writer-user", participantIds: ["reader-user"] } });
  assert.deepEqual(calls.find((call) => call.method === "listConversationMessages"), {
    method: "listConversationMessages",
    args: { conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", actorId: "writer-user", limit: 2, before: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
  });
  assert.deepEqual(calls.find((call) => call.method === "persistMessage"), {
    method: "persistMessage",
    args: { conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", senderId: "writer-user", body: "你好", idempotencyKey: "send-once-1" },
  });
  assert.deepEqual(calls.find((call) => call.method === "updateConversationParticipants"), {
    method: "updateConversationParticipants",
    args: { conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", actorId: "writer-user", addUserIds: ["third-user"], removeUserIds: [] },
  });
  assert.deepEqual(calls.find((call) => call.method === "getConversation"), {
    method: "getConversation",
    args: { conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", actorId: "writer-user" },
  });
  assert.equal(calls.filter((call) => call.method === "listConversations").length, 1,
    "the participant update response must not depend on the first 100 conversation list entries");
  assert.deepEqual(calls.find((call) => call.method === "markConversationAsRead"), {
    method: "markConversationAsRead", args: { conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", actorId: "writer-user" },
  });
  assert.deepEqual(calls.find((call) => call.method === "deleteConversation"), {
    method: "deleteConversation", args: { conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", actorId: "writer-user" },
  });
});

test("REST notification routes are recipient-scoped and preserve their JSON-string payload contract", async () => {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const notification = {
    id: "ffffffff-ffff-4fff-8fff-ffffffffffff", userId: "reader-user", eventKey: "message.created",
    payload: { conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", messageId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", type: "message.created" },
    createdAt: "2026-01-01T00:00:00.000Z", readAt: null,
  };
  const publicShape = {
    id: "ffffffff-ffff-4fff-8fff-ffffffffffff", eventKey: "message.created", payload: JSON.stringify(notification.payload),
    createdAt: notification.createdAt, readAt: null,
  };
  await withServer(async (baseUrl) => {
    const authorization = "Bearer " + signedToken("reader-user");
    const listed = await fetch(baseUrl + "/api/v1/me/notifications?limit=10", { headers: { authorization } });
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), { data: [publicShape] });

    const unread = await fetch(baseUrl + "/api/v1/me/notifications/unread-count", { headers: { authorization } });
    assert.equal(unread.status, 200);
    assert.deepEqual(await unread.json(), { data: 4 });

    const marked = await fetch(baseUrl + "/api/v1/me/notifications/ffffffff-ffff-4fff-8fff-ffffffffffff/read", { method: "PUT", headers: { authorization } });
    assert.equal(marked.status, 200);
    assert.deepEqual(await marked.json(), { data: { ...publicShape, readAt: "2026-01-02T00:00:00.000Z" } });

    const all = await fetch(baseUrl + "/api/v1/me/notifications/read-all", { method: "POST", headers: { authorization } });
    assert.equal(all.status, 200);
    assert.deepEqual(await all.json(), { data: 3 });

    const unauthorized = await fetch(baseUrl + "/api/v1/me/notifications");
    assert.equal(unauthorized.status, 401);
  }, {
    env: authEnv,
    store: {
      async listNotifications(args) { calls.push({ method: "listNotifications", args }); return [notification]; },
      async getUnreadNotificationCount(args) { calls.push({ method: "getUnreadNotificationCount", args }); return 4; },
      async markNotificationRead(args) { calls.push({ method: "markNotificationRead", args }); return { ...notification, readAt: "2026-01-02T00:00:00.000Z" }; },
      async markAllNotificationsRead(args) { calls.push({ method: "markAllNotificationsRead", args }); return 3; },
    },
  });

  assert.deepEqual(calls, [
    { method: "listNotifications", args: { actorId: "reader-user", limit: 10 } },
    { method: "getUnreadNotificationCount", args: { actorId: "reader-user" } },
    { method: "markNotificationRead", args: { notificationId: "ffffffff-ffff-4fff-8fff-ffffffffffff", actorId: "reader-user" } },
    { method: "markAllNotificationsRead", args: { actorId: "reader-user" } },
  ]);
});

test("REST rejects duplicated query parameters before reading or writing route data", async () => {
  await withServer(async (baseUrl) => {
    const readResponse = await fetch(
      `${baseUrl}/api/v1/articles?locale=zh-CN&locale=zh-TW&limit=1&limit=100`,
    );
    assert.equal(readResponse.status, 400);
    assert.deepEqual(await readResponse.json(), {
      error: { code: "BAD_USER_INPUT", message: "Query parameters must not be repeated." },
    });
    assert.equal(readResponse.headers.get("connection"), "close");

    const writeResponse = await fetch(
      `${baseUrl}/api/v1/articles?locale=zh-CN&locale=zh-TW`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: "duplicate-query-test",
          title: "Must not be written",
          contentBlocks: [],
          publish: false,
        }),
      },
    );
    assert.equal(writeResponse.status, 400);
    assert.deepEqual(await writeResponse.json(), {
      error: { code: "BAD_USER_INPUT", message: "Query parameters must not be repeated." },
    });
    assert.equal(writeResponse.headers.get("connection"), "close");
  });
});



test("HTTP requests include a correlation ID and logs exclude URL, query, and credential values", async () => {
  const logs = [];
  const secret = "sensitive-token-value";
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/graphql/private-path?access_token=" + secret, {
      headers: {
        authorization: "Bearer " + secret,
        cookie: "session=" + secret,
        traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
      },
    });
    assert.equal(response.status, 404);
    assert.match(response.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/i);
    await response.text();
  }, { logger: (record) => logs.push(record) });

  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, "http_request_completed");
  assert.equal(logs[0].traceId, "0123456789abcdef0123456789abcdef");
  assert.equal(logs[0].route, "/not_found");
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("private-path"), false);
  assert.equal(serialized.includes("access_token"), false);
});

test("Prometheus metrics endpoint exposes bounded HTTP and authentication metrics", async () => {
  await withServer(async (baseUrl) => {
    const health = await fetch(baseUrl + "/health");
    await health.text();

    const unauthenticated = await fetch(baseUrl + "/api/v1/me/profile?secret=not-for-metrics");
    assert.equal(unauthenticated.status, 401);
    await unauthenticated.text();

    const response = await fetch(baseUrl + "/metrics");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/plain.*version=0\.0\.4/i);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
    const metrics = await response.text();
    assert.match(metrics, /api_http_requests_total\{method="GET",route="\/health",status="200"\} 1/);
    assert.match(metrics, /api_http_request_duration_ms_bucket/);
    assert.match(metrics, /api_http_auth_failures_total\{method="GET",status="401"\} 1/);
    assert.match(metrics, /api_http_active_requests 1|api_http_active_requests 0/);
    assert.equal(metrics.includes("not-for-metrics"), false);
    assert.equal(metrics.includes("secret="), false);
  }, { env: { API_METRICS_ENABLED: "true" } });
});

test("metrics endpoint is disabled by default to avoid public operational-data exposure", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/metrics");
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: { code: "NOT_FOUND", message: "The requested route was not found." },
    });
  });
});
