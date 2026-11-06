import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import test from "node:test";
import { request as httpRequest } from "node:http";
import { createApiServer } from "./server.ts";
import { persistencePortMethods } from "./application/persistence-ports.ts";
import { createSqliteClient, runSqliteMigrations } from "./persistence/sqlite.ts";
import { createSqliteStore } from "./persistence/sqlite-store.ts";
import { ArticleAuthorizationError, ArticleInputError, ArticleNotFoundError, ArticleSlugConflictError, DomainError, IdempotencyConflictError, IdentityConflictError, ProfileInputError, ProfileNotFoundError } from "./domain/errors.ts";
import { isUuid } from "./domain/validation.ts";
import { hashPassword, verifyPassword } from "./security/passwords.ts";
import { MediaAssetInUseError, MediaAssetNotFoundError } from "./application/media-assets.ts";

/**
 * Mail is enabled for this suite: the recovery and verification tests below are
 * about what those endpoints do when they work. The switch itself — off unless
 * an operator turns it on, and 503 while it is off — has its own test.
 */
const authEnv = {
  AUTH_JWT_SECRET: "test-only-secret-that-is-at-least-32-bytes",
  AUTH_JWT_ISSUER: "https://auth.example.test",
  AUTH_JWT_AUDIENCE: "bot-thk-api",
  MAIL_ENABLED: "true",
  // Media deletion is off by default since #156; these tests exercise the delete
  // path itself, so they opt in. The default and the rejection have their own
  // test below — opting in everywhere without one would leave the switch
  // unverified.
  MEDIA_DELETE_ENABLED: "true",
};

/**
 * A token with two *different* identifiers, the way the API issues them: `sid`
 * is the session the token was minted from, `jti` is this individual token.
 * A test that mixes them up then fails instead of passing by coincidence.
 */
function signedToken(sub) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "application/vnd.bot-thk.access+jwt" });
  const payload = encode({
    sub,
    iss: authEnv.AUTH_JWT_ISSUER,
    aud: authEnv.AUTH_JWT_AUDIENCE,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60,
    sid: `session-${sub}`,
    jti: `token-${sub}`,
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
      contentBlocks, publish: true, workType: "poetry", categoryIds: [], tagIds: [], idempotencyKey: null,
      requestedSlug: "new-work",
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

    // A retried publish is the most likely duplicate write on the desk, so the
    // caller's key travels with the create instead of being dropped by the
    // slug uniquifier on the way to persistence.
    const keyed = await fetch(baseUrl + "/api/v1/articles", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + signedToken("verified-writer"),
        "idempotency-key": "publish-once-1",
      },
      body: JSON.stringify({ slug: "keyed-work", title: "带键作品", contentBlocks }),
    });
    assert.equal(keyed.status, 201);
    assert.equal(received.idempotencyKey, "publish-once-1");
    assert.equal(received.requestedSlug, "keyed-work");

    const malformed = await fetch(baseUrl + "/api/v1/articles", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + signedToken("verified-writer"),
        "idempotency-key": "k".repeat(301),
      },
      body: JSON.stringify({ slug: "malformed-key", title: "坏键作品", contentBlocks }),
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, "BAD_USER_INPUT");
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

/**
 * Issues #137 / #157: the first keyed create had to use a suffixed auto slug;
 * replaying the identical request used to compare that suffix against the first
 * candidate and answer 409 instead of returning the work already published.
 */
test("REST replays a keyed create after its auto-generated slug was uniquified", async () => {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  await runSqliteMigrations(db);
  const sqliteStore = createSqliteStore(db);
  const body = {
    title: "Synthetic duplicate title",
    contentBlocks: [{ id: "p1", type: "paragraph", text: "A replayable draft." }],
    contentBlocksVersion: 1,
    publish: false,
  };
  const post = (payload: Record<string, unknown>, key?: string) => ({
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + signedToken("verified-writer"),
      ...(key ? { "idempotency-key": key } : {}),
    },
    body: JSON.stringify(payload),
  });

  try {
    await withServer(async (baseUrl) => {
      // Occupy the base slug with an unkeyed work so the keyed write lands on -2.
      const occupying = await fetch(baseUrl + "/api/v1/articles", post(body));
      assert.equal(occupying.status, 201);
      const occupied = (await occupying.json()).data;
      assert.equal(occupied.slug, "synthetic-duplicate-title");

      const created = await fetch(baseUrl + "/api/v1/articles", post(body, "collision-key"));
      assert.equal(created.status, 201);
      const first = (await created.json()).data;
      assert.notEqual(first.slug, occupied.slug, "the uniquifier should have moved past the occupied slug");

      const replay = await fetch(baseUrl + "/api/v1/articles", post(body, "collision-key"));
      assert.equal(replay.status, 201, "an exact retry must be a replay, not a conflict");
      const replayed = (await replay.json()).data;
      assert.equal(replayed.id, first.id);
      assert.equal(replayed.slug, first.slug);

      const conflict = await fetch(baseUrl + "/api/v1/articles", post({ ...body, slug: "explicit-different" }, "collision-key"));
      assert.equal(conflict.status, 409);
      assert.equal((await conflict.json()).error.code, "IDEMPOTENCY_CONFLICT");

      const mine = await sqliteStore.listMyArticles({ actorId: "verified-writer", locale: "zh-CN", limit: 100 });
      assert.equal(
        mine.filter((article) => article.slug.startsWith("synthetic-duplicate-title")).length,
        2,
        "the replay must not leave a second article behind",
      );
    }, { env: authEnv, store: sqliteStore });
  } finally {
    db.close();
  }
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
      // No summary was supplied, so the transport derived one from the body.
      summary: "更新后的作品",
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
      // Revocation is recorded against the access token, not the session.
      async isSessionRevoked(tokenId) { return tokenId === "token-revoked-writer"; },
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
    assert.deepEqual(received, { authorId: "user-123", locale: "zh-CN", query: "hello", sort: "latest", limit: 10, offset: 20 });
  }, {
    store: {
      async getAuthorProfile(args) {
        return { ...authorProfile, locale: args.locale };
      },
      // The page serializer asks for the distinct author set once (#162); the
      // per-article accessor above stays because other routes still use it.
      async getAuthorProfilesByIds({ userIds, locale }) {
        return Object.fromEntries(userIds.map((userId) => [userId, { ...authorProfile, locale }]));
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
    assert.deepEqual(received, { locale: "zh-CN", query: "poetry", sort: "latest", limit: 10, offset: 20 });
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

/**
 * The author directory, at the transport boundary (ADR 0024).
 *
 * What a client can observe: the collection is a plain read with no session,
 * every filter is forwarded to the service rather than re-implemented here, the
 * defaults are the directory's own, and a bad parameter is a 400 rather than an
 * empty page — a reader who mistypes `limmit` should be told, not shown nothing.
 */
test("REST author directory is a public read that forwards bounded pagination", async () => {
  let received;
  const authors = [{
    userId: "11111111-1111-4111-8111-111111111111",
    displayName: "林晚", bio: "写小说", locale: "zh-CN", followerCount: 3, workCount: 2,
  }];
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/authors?locale=zh-CN&query=林&limit=10&offset=20`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: authors });
    assert.deepEqual(received, { locale: "zh-CN", query: "林", limit: 10, offset: 20 });

    // No query is the directory itself, with the service's own defaults.
    const directory = await fetch(`${baseUrl}/api/v1/authors`);
    assert.equal(directory.status, 200);
    assert.deepEqual(received, { locale: "zh-CN", query: "", limit: 20, offset: 0 });
    assert.deepEqual(await directory.json(), { data: authors });

    // Nothing here is per-reader: the response is the same for everybody, so it
    // can be cached by whoever sits in front of it.
    const anonymous = await fetch(`${baseUrl}/api/v1/authors?locale=zh-CN`);
    assert.equal(anonymous.status, 200);

    for (const params of ["locale=xx", "limit=0", "limit=101", "offset=-1", "offset=100001", "limit=abc"]) {
      const bad = await fetch(`${baseUrl}/api/v1/authors?${params}`);
      assert.equal(bad.status, 400, `${params} is a bad request, not an empty page`);
      assert.match((await bad.json()).error.message, /Invalid locale, query, limit, or offset/);
    }

    // A directory is a read: writing to it is not a thing.
    const wrongMethod = await fetch(`${baseUrl}/api/v1/authors`, { method: "POST" });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "GET");
  }, {
    store: {
      async searchAuthors(args) { received = args; return authors; },
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

test("REST deletes the author's own work and refuses everyone else", async () => {
  const articleId = "3f7c1d90-8a2b-4c1e-9f3a-6c5b2e8d1a44";
  const deletedAt = "2026-01-02T03:04:05.678Z";
  let received;
  await withServer(async (baseUrl) => {
    const bearer = (userId: string) => ({ authorization: "Bearer " + signedToken(userId) });

    // No session, no delete — and the id is not looked at before that.
    const anonymous = await fetch(`${baseUrl}/api/v1/articles/${articleId}`, { method: "DELETE" });
    assert.equal(anonymous.status, 401);

    const malformed = await fetch(`${baseUrl}/api/v1/articles/not-a-uuid`, { method: "DELETE", headers: bearer("owner") });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, "BAD_USER_INPUT");

    // A work that is not yours is a 403, never a 404: the second would tell a
    // caller which ids exist.
    const foreign = await fetch(`${baseUrl}/api/v1/articles/${articleId}`, { method: "DELETE", headers: bearer("intruder") });
    assert.equal(foreign.status, 403);
    assert.equal((await foreign.json()).error.code, "FORBIDDEN");

    const deleted = await fetch(`${baseUrl}/api/v1/articles/${articleId}`, { method: "DELETE", headers: bearer("owner") });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { data: { id: articleId, deletedAt } });
    // The actor comes from the session, so a body cannot name the author.
    assert.deepEqual(received, { articleId, actorId: "owner" });
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async deleteArticle(args) {
        received = args;
        // The route hands the id over unchanged; the shape check is the store's,
        // exactly as it is for an update.
        if (!isUuid(args.articleId)) throw new ArticleInputError("articleId must be a valid article ID.");
        if (args.actorId !== "owner") throw new ArticleAuthorizationError("private owner id must not leak");
        return { id: args.articleId, deletedAt };
      },
    },
  });
});

test("REST lists the author's deleted works with the moment the sweep will remove them", async () => {
  const deletedAt = "2026-01-02T03:04:05.678Z";
  const tombstone = [{ id: "article-1", deletedAt }];
  let received;
  const store = {
    async isSessionRevoked() { return false; },
    async listMyDeletedArticles(args) { received = args; return tombstone; },
    async getAuthorProfile() { return null; },
    async listArticleTaxonomies() { return []; },
  };
  await withServer(async (baseUrl) => {
    // No session, no recycle bin: the list is the author's own.
    const anonymous = await fetch(`${baseUrl}/api/v1/me/articles/deleted`);
    assert.equal(anonymous.status, 401);

    const listed = await fetch(`${baseUrl}/api/v1/me/articles/deleted`, {
      headers: { authorization: "Bearer " + signedToken("owner") },
    });
    assert.equal(listed.status, 200);
    // The expiry is the API's to compute: a client that showed its own copy of
    // the retention window would drift from the sweep the moment it is changed.
    assert.deepEqual(await listed.json(), {
      data: [{ id: "article-1", deletedAt, purgesAt: "2026-01-09T03:04:05.678Z", author: null, categories: [], tags: [] }],
    });
    assert.deepEqual(received, { actorId: "owner", locale: "zh-CN", limit: 50 });
  }, { env: { ...authEnv, ARTICLE_TOMBSTONE_RETENTION_DAYS: "7" }, store });

  // Without the variable, the window is the default — and the fallback is the
  // longer retention, never a purge the operator did not ask for.
  await withServer(async (baseUrl) => {
    const listed = await fetch(`${baseUrl}/api/v1/me/articles/deleted`, {
      headers: { authorization: "Bearer " + signedToken("owner") },
    });
    assert.equal((await listed.json()).data[0].purgesAt, "2026-02-01T03:04:05.678Z");
  }, { env: authEnv, store });

  await withServer(async (baseUrl) => {
    const listed = await fetch(`${baseUrl}/api/v1/me/articles/deleted?locale=zh-TW&limit=10`, {
      headers: { authorization: "Bearer " + signedToken("owner") },
    });
    assert.equal(listed.status, 200);
    assert.deepEqual(received, { actorId: "owner", locale: "zh-TW", limit: 10 });
    const rejected = await fetch(`${baseUrl}/api/v1/me/articles/deleted?limit=0`, {
      headers: { authorization: "Bearer " + signedToken("owner") },
    });
    assert.equal(rejected.status, 400);
  }, { env: authEnv, store });
});

test("REST restores the author's own deleted work and refuses everyone else", async () => {
  const articleId = "3f7c1d90-8a2b-4c1e-9f3a-6c5b2e8d1a44";
  let received;
  await withServer(async (baseUrl) => {
    const bearer = (userId: string) => ({ authorization: "Bearer " + signedToken(userId) });
    const path = `${baseUrl}/api/v1/articles/${articleId}/restore`;

    // No session, no restore — and the id is not inspected before that.
    const anonymous = await fetch(path, { method: "POST" });
    assert.equal(anonymous.status, 401);

    const malformed = await fetch(`${baseUrl}/api/v1/articles/not-a-uuid/restore`, { method: "POST", headers: bearer("owner") });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, "BAD_USER_INPUT");

    // A work that is not yours is a 403, never a 404.
    const foreign = await fetch(path, { method: "POST", headers: bearer("intruder") });
    assert.equal(foreign.status, 403);
    assert.equal((await foreign.json()).error.code, "FORBIDDEN");

    const restored = await fetch(path, { method: "POST", headers: bearer("owner") });
    assert.equal(restored.status, 200);
    const payload = await restored.json();
    assert.equal(payload.data.id, articleId);
    assert.equal(payload.data.status, "draft");
    assert.deepEqual(received, { articleId, actorId: "owner", locale: "zh-CN" });

    // A GET is a 405 with the allow-list, so the endpoint cannot be probed by
    // navigating a browser to it.
    const wrongMethod = await fetch(path);
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "POST");
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async restoreArticle(args) {
        received = args;
        // The route hands the id over unchanged; the shape check is the store's,
        // exactly as it is for an update.
        if (!isUuid(args.articleId)) throw new ArticleInputError("articleId must be a valid article ID.");
        if (args.actorId !== "owner") throw new ArticleAuthorizationError("private owner id must not leak");
        return { id: args.articleId, slug: "restored-work", status: "draft" };
      },
      async getAuthorProfile() { return null; },
      async listArticleTaxonomies() { return []; },
    },
  });
});

test("REST tells the readers who commented on a deleted work when their words go", async () => {
  const articleId = "3f7c1d90-8a2b-4c1e-9f3a-6c5b2e8d1a44";
  const deletedAt = "2026-01-02T03:04:05.678Z";
  const notified: Array<{ userId: string; eventKey: string; payload: unknown }> = [];
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/articles/${articleId}`, {
      method: "DELETE",
      headers: { authorization: "Bearer " + signedToken("owner") },
    });
    assert.equal(response.status, 200);
    // The commenters hear about it; the author who pressed the button does not.
    assert.deepEqual(notified.map((input) => input.userId), ["reader-1", "reader-2"]);
    assert.deepEqual(notified[0].payload, {
      type: "article.deleted",
      articleId,
      purgesAt: "2026-02-01T03:04:05.678Z",
    });
    assert.equal(notified[0].eventKey, `article.deleted:${articleId}:reader-1`);
  }, {
    env: { ...authEnv, ARTICLE_TOMBSTONE_RETENTION_DAYS: "30" },
    store: {
      async isSessionRevoked() { return false; },
      async deleteArticle(args) { return { id: args.articleId, deletedAt }; },
      async listArticleCommentAuthorIds() { return ["reader-1", "reader-2", "owner"]; },
      async createNotification(input) {
        notified.push(input);
        return { id: `notification-${notified.length}`, duplicate: false };
      },
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
      // Still a 409, but the reader has a next step, so the code says which
      // conflict it is instead of repeating the generic sentence.
      error: new IdentityConflictError(),
      status: 409,
      code: "EMAIL_TAKEN",
      message: "The email address is already registered.",
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
    // `isEditor` is the assembled fact: the role column for a plain account, and
    // the bootstrap list for the account that has to mint the first editor.
    assert.deepEqual(await me.json(), {
      data: { id: "me-user", email: "me-user@example.test", emailVerifiedAt: null, isEditor: false },
    });
    const curator = await fetch(baseUrl + "/api/v1/me", {
      headers: { authorization: "Bearer " + signedToken("curator-user") },
    });
    assert.deepEqual(await curator.json(), {
      data: { id: "curator-user", email: "curator-user@example.test", emailVerifiedAt: null, isEditor: true },
    });

    const profileResponse = await fetch(baseUrl + "/api/v1/me/profile?locale=zh-CN", {
      headers: { authorization: "Bearer " + signedToken("me-user") },
    });
    assert.equal(profileResponse.status, 200);
    assert.deepEqual(await profileResponse.json(), { data: profile });
  }, {
    env: { ...authEnv, EDITOR_USER_IDS: "curator-user" },
    store: {
      async isSessionRevoked() { return false; },
      async findIdentityAccountByUserId({ userId }) {
        return { userId, email: `${userId}@example.test`, emailVerifiedAt: null };
      },
      async getUserRole() { return "member"; },
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
      async getAuthorProfilesByIds({ userIds, locale, viewerId }) {
        return Object.fromEntries(userIds.map((userId) => [userId, { ...writerProfile, locale, isFollowing: viewerId === "reader-user" }]));
      },
      async listArticleTaxonomies(args) { return args.kind === "category" ? [category] : [tag]; },
      async listArticlesTaxonomies({ articleIds, kind }) {
        const rows = kind === "category" ? [category] : [tag];
        return Object.fromEntries(articleIds.map((articleId) => [articleId, rows]));
      },
      async getArticleLikeInfo(args) { calls.push(["like", args]); return likeInfo; },
    },
  });
});

test("REST following feed requires a session and reads only what the viewer follows", async () => {
  const calls = [];
  const writerProfile = {
    userId: "writer-user", displayName: "作者", bio: "简介", avatarUrl: null,
    websiteUrl: null, locale: "zh-CN",
    createdAt: "2025-12-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    followerCount: 4, followingCount: 3, isFollowing: true,
  };
  const article = {
    id: "article-1", authorId: "writer-user", slug: "followed-work", workType: "other",
    status: "published", locale: "zh-CN", title: "关注的新作", summary: "摘要",
    contentBlocks: [{ id: "p1", type: "paragraph", text: "正文" }],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
    publishedAt: "2026-01-02T00:00:00.000Z", author: writerProfile, categories: [], tags: [],
    likeCount: 3, likedByViewer: false,
  };
  await withServer(async (baseUrl) => {
    // A feed is personal: without a session there is nothing to render, not the public one.
    const anonymous = await fetch(baseUrl + "/api/v1/me/feed");
    assert.equal(anonymous.status, 401);

    const headers = { authorization: "Bearer " + signedToken("reader-user") };
    const badLocale = await fetch(baseUrl + "/api/v1/me/feed?locale=nope", { headers });
    assert.equal(badLocale.status, 400);
    const badLimit = await fetch(baseUrl + "/api/v1/me/feed?limit=0", { headers });
    assert.equal(badLimit.status, 400);
    const badOffset = await fetch(baseUrl + "/api/v1/me/feed?offset=100001", { headers });
    assert.equal(badOffset.status, 400);
    assert.deepEqual(calls, []);

    const feed = await fetch(baseUrl + "/api/v1/me/feed?limit=5&offset=10", { headers });
    assert.equal(feed.status, 200);
    assert.deepEqual(await feed.json(), { data: [article] });
    assert.deepEqual(calls, [{ actorId: "reader-user", locale: "zh-CN", limit: 5, offset: 10 }]);

    const wrongMethod = await fetch(baseUrl + "/api/v1/me/feed", { method: "DELETE" });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "GET");
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async listFollowingArticles(args) { calls.push(args); return [article]; },
      async getAuthorProfile() { return writerProfile; },
      async getAuthorProfilesByIds({ userIds }) {
        return Object.fromEntries(userIds.map((userId) => [userId, writerProfile]));
      },
      async listArticleTaxonomies() { return []; },
      async listArticlesTaxonomies({ articleIds }) {
        return Object.fromEntries(articleIds.map((articleId) => [articleId, []]));
      },
      async getArticleLikeInfo() { return { articleId: "article-1", slug: "followed-work", likeCount: 3, likedByViewer: false }; },
    },
  });
});

test("REST article discovery accepts sort=popular and rejects an unknown sort", async () => {
  const calls = [];
  const profile = {
    userId: "some-author", displayName: "作者", bio: "", avatarUrl: null, websiteUrl: null,
    locale: "zh-CN", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    followerCount: 0, followingCount: 0, isFollowing: false,
  };
  await withServer(async (baseUrl) => {
    const popular = await fetch(baseUrl + "/api/v1/articles?sort=popular&limit=7&offset=2");
    assert.equal(popular.status, 200);
    assert.deepEqual(await popular.json(), { data: [] });
    assert.deepEqual(calls[0], { locale: "zh-CN", query: "", sort: "popular", limit: 7, offset: 2 });

    // Omitted, the historical order is unchanged: newest first.
    const latest = await fetch(baseUrl + "/api/v1/articles");
    assert.equal(latest.status, 200);
    assert.deepEqual(calls[1], { locale: "zh-CN", query: "", sort: "latest", limit: 20, offset: 0 });

    const bogus = await fetch(baseUrl + "/api/v1/articles?sort=hottest");
    assert.equal(bogus.status, 400);

    // The author listing shares the same parameter.
    const byAuthor = await fetch(baseUrl + "/api/v1/authors/some-author/articles?sort=popular&limit=3");
    assert.equal(byAuthor.status, 200);
    assert.deepEqual(calls[2], { authorId: "some-author", locale: "zh-CN", query: "", sort: "popular", limit: 3, offset: 0 });
    const authorBogus = await fetch(baseUrl + "/api/v1/authors/some-author/articles?sort=hottest");
    assert.equal(authorBogus.status, 400);
    assert.equal(calls.length, 3);
  }, {
    env: authEnv,
    store: {
      async listPublishedArticles(args) { calls.push(args); return []; },
      async getAuthorProfile() { return profile; },
    },
  });
});

test("REST role assignment is editor-only, refuses self-service and returns the updated profile", async () => {
  const calls = [];
  let roleOfWriter = "member";
  const profileFor = (userId) => ({
    userId, role: userId === "writer-user" ? roleOfWriter : "member",
    displayName: "作者", bio: "", avatarUrl: null, websiteUrl: null, locale: "zh-CN",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    followerCount: 0, followingCount: 0, isFollowing: false,
  });
  const put = (baseUrl, userId, token, body) => fetch(baseUrl + "/api/v1/users/" + userId + "/role", {
    method: "PUT",
    headers: token
      ? { authorization: "Bearer " + signedToken(token), "content-type": "application/json" }
      : { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  await withServer(async (baseUrl) => {
    // A role is personal state: without a session there is nothing to assign.
    assert.equal((await put(baseUrl, "writer-user", null, { role: "editor" })).status, 401);

    // A member is authenticated and still refused — 403, not 404: the resource
    // exists, the caller simply may not touch it.
    const member = await put(baseUrl, "writer-user", "member-user", { role: "editor" });
    assert.equal(member.status, 403);
    assert.deepEqual(await member.json(), { error: { code: "FORBIDDEN", message: "You are not allowed to access this resource." } });
    assert.deepEqual(calls, []);

    const editor = (userId, body) => put(baseUrl, userId, "editor-user", body);
    const bogusRole = await editor("writer-user", { role: "admin" });
    assert.equal(bogusRole.status, 400);
    const extraField = await editor("writer-user", { role: "editor", admin: true });
    assert.equal(extraField.status, 400);
    const missing = await editor("missing-user", { role: "editor" });
    assert.equal(missing.status, 404);
    // ADR 0016, decision 3: even an editor cannot change their own role.
    const self = await editor("editor-user", { role: "member" });
    assert.equal(self.status, 400);
    assert.deepEqual(calls, []);

    const promoted = await editor("writer-user", { role: "editor" });
    assert.equal(promoted.status, 200);
    assert.deepEqual(await promoted.json(), { data: profileFor("writer-user") });
    assert.deepEqual(calls, [{ actorId: "editor-user", userId: "writer-user", role: "editor" }]);

    const wrongMethod = await fetch(baseUrl + "/api/v1/users/writer-user/role");
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "PUT");
  }, {
    // The editor here comes from the environment list, which is how an empty
    // database gets its first one.
    env: { ...authEnv, EDITOR_USER_IDS: "editor-user" },
    store: {
      async isSessionRevoked() { return false; },
      async getUserRole() { return "member"; },
      async setUserRole(args) {
        if (args.actorId === args.userId) throw new ProfileInputError("You cannot change your own role.");
        if (args.userId === "missing-user") throw new ProfileNotFoundError();
        // Only a successful assignment is recorded: a refused one wrote nothing.
        calls.push(args);
        roleOfWriter = args.role;
        return args.role;
      },
      async getAuthorProfile(args) { return profileFor(args.userId); },
    },
  });
});

test("REST taxonomy writes keep hashtags open and reserve categories for editors", async () => {
  const calls = [];
  const taxonomy = (kind, slug) => ({ id: `taxonomy-${slug}`, kind, slug, name: slug, description: "", locale: "zh-CN", articleCount: 0, createdBy: "author-user" });
  const post = (baseUrl, token, body) => fetch(baseUrl + "/api/v1/taxonomies", {
    method: "POST",
    headers: { authorization: "Bearer " + signedToken(token), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  await withServer(async (baseUrl) => {
    // A hashtag is the author's own words: a plain member may still mint one.
    const tag = await post(baseUrl, "member-user", { kind: "tag", slug: "nowave", name: "NoWave" });
    assert.equal(tag.status, 201);
    assert.deepEqual(calls[0], { kind: "tag", slug: "nowave", name: "NoWave", locale: "zh-CN", description: "", actorId: "member-user", actorIsEditor: false });

    // A category is the platform speaking: the same account is refused.
    const category = await post(baseUrl, "member-user", { kind: "category", slug: "poetry", name: "诗歌" });
    assert.equal(category.status, 403);
    assert.deepEqual(await category.json(), { error: { code: "FORBIDDEN", message: "You are not allowed to access this resource." } });

    // The refused attempt still reached persistence with an honest answer about
    // the caller, so the adapter — not the transport — is what says no.
    assert.deepEqual(calls[1], { kind: "category", slug: "poetry", name: "诗歌", locale: "zh-CN", description: "", actorId: "member-user", actorIsEditor: false });

    const created = await post(baseUrl, "editor-user", { kind: "category", slug: "poetry", name: "诗歌" });
    assert.equal(created.status, 201);
    assert.deepEqual(calls[2], { kind: "category", slug: "poetry", name: "诗歌", locale: "zh-CN", description: "", actorId: "editor-user", actorIsEditor: true });

    // Deleting a category needs the role even from the account that created it.
    const removed = await fetch(baseUrl + "/api/v1/taxonomies/11111111-1111-4111-8111-111111111111", {
      method: "DELETE",
      headers: { authorization: "Bearer " + signedToken("member-user") },
    });
    assert.equal(removed.status, 403);
    assert.deepEqual(calls[3], { taxonomyId: "11111111-1111-4111-8111-111111111111", actorId: "member-user", actorIsEditor: false });
    assert.equal(calls.length, 4);
  }, {
    env: { ...authEnv, EDITOR_USER_IDS: "editor-user" },
    store: {
      async isSessionRevoked() { return false; },
      async getUserRole() { return "member"; },
      // The fake enforces the same rule the persistence contract asserts, so the
      // HTTP layer is tested against the refusal a real adapter would produce.
      async createTaxonomy(args) {
        calls.push(args);
        if (args.kind === "category" && args.actorIsEditor !== true) throw new ArticleAuthorizationError("Only an editor can create a category.");
        return taxonomy(args.kind, args.slug);
      },
      async deleteTaxonomy(args) {
        calls.push(args);
        if (args.actorIsEditor !== true) throw new ArticleAuthorizationError("Only an editor can delete a category.");
        return true;
      },
    },
  });
});

test("REST featured shelf is public to read and editorial to arrange", async () => {
  const calls = [];
  const article = (slug) => ({
    id: `article-${slug}`, authorId: "writer-user", slug, workType: "other", status: "published",
    locale: "zh-CN", title: slug, summary: "", contentBlocks: [{ id: "p1", type: "paragraph", text: "正文" }],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", publishedAt: "2026-01-02T00:00:00.000Z",
    author: null, categories: [], tags: [], likeCount: 0, likedByViewer: false,
  });
  await withServer(async (baseUrl) => {
    // Anyone may read the shelf, signed in or not.
    const read = await fetch(baseUrl + "/api/v1/featured?limit=5");
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), { data: [article("picked")] });
    assert.deepEqual(calls[0], ["list", { locale: "zh-CN", limit: 5, offset: 0 }]);

    // Arranging it needs a session first, then the role.
    const anonymous = await fetch(baseUrl + "/api/v1/featured", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ articleIds: [] }),
    });
    assert.equal(anonymous.status, 401);

    const member = await fetch(baseUrl + "/api/v1/featured", {
      method: "PUT",
      headers: { authorization: "Bearer " + signedToken("member-user"), "content-type": "application/json" },
      body: JSON.stringify({ articleIds: [] }),
    });
    assert.equal(member.status, 403);

    // The member reaches the store carrying the assembled fact, which is what
    // turns the request down — not a second question asked at the wrong depth.
    assert.deepEqual(calls[1], ["set", {
      actorId: "member-user", actorIsEditor: false, locale: "zh-CN", articleIds: [],
    }]);

    const editor = await fetch(baseUrl + "/api/v1/featured", {
      method: "PUT",
      headers: { authorization: "Bearer " + signedToken("editor-user"), "content-type": "application/json" },
      body: JSON.stringify({ articleIds: ["11111111-1111-4111-8111-111111111111"] }),
    });
    assert.equal(editor.status, 200);
    assert.deepEqual(calls[2], ["set", {
      actorId: "editor-user", actorIsEditor: true, locale: "zh-CN",
      articleIds: ["11111111-1111-4111-8111-111111111111"],
    }]);

    // The body carries the whole shelf and nothing else.
    const malformed = await fetch(baseUrl + "/api/v1/featured", {
      method: "PUT",
      headers: { authorization: "Bearer " + signedToken("editor-user"), "content-type": "application/json" },
      body: JSON.stringify({ articleIds: ["11111111-1111-4111-8111-111111111111"], position: 0 }),
    });
    assert.equal(malformed.status, 400);
    assert.equal(calls.length, 3);

    const wrongMethod = await fetch(baseUrl + "/api/v1/featured", { method: "POST" });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "GET, PUT");
  }, {
    env: { ...authEnv, EDITOR_USER_IDS: "editor-user" },
    store: {
      async isSessionRevoked() { return false; },
      async getUserRole() { return "member"; },
      async listFeaturedArticles(args) { calls.push(["list", args]); return [article("picked")]; },
      async setFeaturedArticles(args) {
        calls.push(["set", args]);
        if (args.actorIsEditor !== true) throw new ArticleAuthorizationError("Only an editor can change the featured shelf.");
        return args.articleIds.map((id) => article(id));
      },
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

/**
 * `GET /api/v1/me/sessions` and its two `DELETE` shapes.
 *
 * The HTTP-level assertions are about who may ask and what the transport hands
 * to the identity service: both are authenticated, the device that asks is the
 * one that gets spared, an id that is not a device of this account answers 404,
 * and — the detail the last slice settled — the spared device is named by the
 * token's `sid`, not by its `jti`.
 */
test("REST device management is authenticated, spares the session that asks and refuses a body", async () => {
  const seen: { list: Record<string, unknown> | null; ended: Record<string, unknown> | null; others: Record<string, unknown> | null } = { list: null, ended: null, others: null };
  const device = {
    sessionId: "session-sessions-user",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: null,
    expiresAt: "2026-01-08T00:00:00.000Z",
  };
  await withServer(async (baseUrl) => {
    const headers = { authorization: "Bearer " + signedToken("sessions-user") };

    const list = await fetch(baseUrl + "/api/v1/me/sessions", { headers });
    assert.equal(list.status, 200);
    assert.equal(list.headers.get("cache-control"), "no-store");
    assert.deepEqual(await list.json(), { data: { sessions: [{ ...device, current: true }] } });
    assert.deepEqual(seen.list, { userId: "sessions-user", limit: 50 });

    const endedOthers = await fetch(baseUrl + "/api/v1/me/sessions", { method: "DELETE", headers });
    assert.deepEqual(await endedOthers.json(), { data: { ok: true, revokedSessions: 1 } });
    assert.deepEqual(seen.others, { userId: "sessions-user", exceptSessionId: "session-sessions-user" });
    assert.notEqual(seen.others?.exceptSessionId, "token-sessions-user",
      "the access token is not a device, and sparing it would spare nothing");

    const endedOne = await fetch(baseUrl + "/api/v1/me/sessions/a-device", { method: "DELETE", headers });
    assert.deepEqual(await endedOne.json(), { data: { ok: true } });
    assert.deepEqual(seen.ended, { userId: "sessions-user", sessionId: "a-device" });

    // A body would only be a second place to name the device.
    const withBody = await fetch(baseUrl + "/api/v1/me/sessions/a-device", {
      method: "DELETE", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "another-device" }),
    });
    assert.equal(withBody.status, 400);
    assert.equal((await withBody.json()).error.code, "BAD_USER_INPUT");

    for (const path of ["/api/v1/me/sessions", "/api/v1/me/sessions/a-device"]) {
      const anonymous = await fetch(baseUrl + path, { method: path.endsWith("a-device") ? "DELETE" : "GET" });
      assert.equal(anonymous.status, 401);
      assert.equal(anonymous.headers.get("cache-control"), "no-store");
      assert.equal((await anonymous.json()).error.code, "UNAUTHENTICATED");
    }
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async listIdentitySessions(args) { seen.list = args; return [device]; },
      async revokeIdentitySession(args) { seen.ended = args; return true; },
      async revokeIdentitySessions(args) { seen.others = args; return 1; },
    },
  });
});

test("REST ending a device that is not this account's is a 404, and a session that cannot be checked is a 401", async () => {
  let asked = 0;
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/v1/me/sessions/not-a-device", {
      method: "DELETE",
      headers: { authorization: "Bearer " + signedToken("sessions-user") },
    });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, "NOT_FOUND");
    assert.equal(asked, 1, "the store was asked once and answered no");
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async revokeIdentitySession() { asked += 1; return false; },
    },
  });

  // Fail closed: a revocation check that cannot be answered is not a session.
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/v1/me/sessions", {
      headers: { authorization: "Bearer " + signedToken("sessions-user") },
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, "UNAUTHENTICATED");
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { throw new Error("the revocation store is down"); },
      async listIdentitySessions() { throw new Error("must not be called"); },
    },
  });
});

test("REST current-session logout revokes the access token that was presented, through the token expiry", async () => {
  let received;
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/v1/me/session", {
      method: "DELETE",
      headers: { authorization: "Bearer " + signedToken("logout-user") },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: true });
    // The token id, not the session id: signing out ends the credential that
    // was presented, and leaves the visitor's other devices alone.
    assert.equal(received.sessionId, "token-logout-user");
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

/**
 * `PUT /api/v1/me/password`.
 *
 * The HTTP-level assertions are about the shape of the contract, not the rules:
 * the endpoint is authenticated and single-method, the session that makes the
 * request is the one the identity service is told to spare, and a wrong current
 * password is a 401 that changes nothing. What "spare" and "12 characters"
 * mean is decided once, in the identity service, and tested there.
 */
test("REST password change is authenticated, spares its own session and stores only the new hash", async () => {
  const seen: { replaced: Record<string, unknown> | null } = { replaced: null };
  // One salted hash for the whole test: a real store answers the same value
  // every time it is asked, and the proof the service hands back names it.
  const passwordHash = await hashPassword("the-current-password");
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/v1/me/password", {
      method: "PUT",
      headers: {
        authorization: "Bearer " + signedToken("password-user"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ currentPassword: "the-current-password", newPassword: "a-brand-new-password" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { ok: true, revokedSessions: 1 } });
    // One call carries both halves, so no response can be produced with the
    // new credential saved and the old sessions still signed in.
    assert.equal(seen.replaced?.userId, "password-user");
    assert.ok(await verifyPassword("a-brand-new-password", String(seen.replaced?.passwordHash)));
    // The session to spare is `sid`, not `jti`: a token is minted afresh on
    // every refresh, so sparing the token id would spare nothing and sign the
    // visitor out with their own request.
    assert.equal(seen.replaced?.exceptSessionId, "session-password-user");
    assert.notEqual(seen.replaced?.exceptSessionId, "token-password-user",
      "the access token is not a session, and must not be treated as one");
    // The store re-checks this under its own lock, so the transport hands over
    // exactly the state the service verified — no more of the account.
    assert.deepEqual(seen.replaced?.proof, { email: "owner@example.test", passwordHash });
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async findIdentityCredentials({ userId }) { return { userId, passwordHash }; },
      async findIdentityAccountByUserId({ userId }) {
        return { userId, email: "owner@example.test", emailVerifiedAt: null };
      },
      async replaceIdentityPassword(args) { seen.replaced = args; return { updated: true, revokedSessions: 1 }; },
    },
  });
});

test("REST password change answers 401 for a wrong current password and stores nothing", async () => {
  let stored = 0;
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/v1/me/password", {
      method: "PUT",
      headers: {
        authorization: "Bearer " + signedToken("password-user"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ currentPassword: "not-the-password", newPassword: "a-brand-new-password" }),
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, "UNAUTHENTICATED");
    assert.equal(stored, 0, "a refused change must not write a credential");
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async findIdentityCredentials({ userId }) {
        return { userId, passwordHash: await hashPassword("the-current-password") };
      },
      async replaceIdentityPassword() { stored += 1; return { updated: true, revokedSessions: 0 }; },
    },
  });
});

test("REST password change is refused without a session, and only accepts PUT", async () => {
  await withServer(async (baseUrl) => {
    const anonymous = await fetch(baseUrl + "/api/v1/me/password", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: "the-current-password", newPassword: "a-brand-new-password" }),
    });
    assert.equal(anonymous.status, 401);

    const read = await fetch(baseUrl + "/api/v1/me/password", { headers: { authorization: "Bearer " + signedToken("password-user") } });
    assert.equal(read.status, 405);
    assert.equal(read.headers.get("allow"), "PUT", "a password is never readable");
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async findIdentityCredentials() { throw new Error("must not be called"); },
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
      // Revocation is recorded against the access token, not the session.
      async isSessionRevoked(tokenId) { return tokenId === "token-revoked-viewer"; },
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
        "idempotency-key": "comment-once-1",
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
        idempotencyKey: "comment-once-1",
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
      // The writer is an editor, so this test keeps exercising creator identity
      // and normalization rather than the editorial permission itself.
      async getUserRole() { return "editor"; },
      async createTag(args) { calls.push({ method: "createTag", args }); return tag; },
      async createTaxonomy(args) { calls.push({ method: "createTaxonomy", args }); return category; },
      async deleteTaxonomy(args) { calls.push({ method: "deleteTaxonomy", args }); return true; },
    },
  });
  assert.deepEqual(calls, [
    { method: "createTag", args: { actorId: "writer-user", name: "人工智能", locale: "zh-CN" } },
    { method: "createTaxonomy", args: { kind: "category", slug: "poetry", name: "诗歌", description: "诗歌分类", locale: "zh-CN", actorId: "writer-user", actorIsEditor: true } },
    { method: "deleteTaxonomy", args: { taxonomyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", actorId: "writer-user", actorIsEditor: true } },
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
      method: "POST", headers: { ...jsonHeaders, "idempotency-key": "open-once-1" }, body: JSON.stringify({ participantIds: ["reader-user"] }),
    });
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), { data: conversation });

    const missingCreateKeyRejected = await fetch(baseUrl + "/api/v1/conversations", {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ participantIds: ["reader-user"] }),
    });
    assert.equal(missingCreateKeyRejected.status, 400, "a retried create without a key would silently open a second conversation");

    const listed = await fetch(baseUrl + "/api/v1/conversations?limit=5", { headers: { authorization } });
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), { data: [conversation] });

    const fetched = await fetch(baseUrl + "/api/v1/conversations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", { headers: { authorization } });
    assert.equal(fetched.status, 200);
    assert.deepEqual(await fetched.json(), { data: conversation });

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

  assert.deepEqual(calls[0], { method: "createConversation", args: { actorId: "writer-user", participantIds: ["reader-user"], idempotencyKey: "open-once-1" } });
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

test("REST conversation detail is member-scoped: a stranger's read is indistinguishable from a missing conversation", async () => {
  const conversation = {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", createdBy: "writer-user", participantIds: ["reader-user", "writer-user"],
    createdAt: "2026-01-01T00:00:00.000Z", lastActivityAt: "2026-01-02T00:00:00.000Z", unreadCount: 0, lastMessage: null,
  };
  await withServer(async (baseUrl) => {
    const authorization = "Bearer " + signedToken("stranger-user");
    const read = await fetch(baseUrl + "/api/v1/conversations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", { headers: { authorization } });
    assert.equal(read.status, 404);
    assert.deepEqual(await read.json(), { error: { code: "NOT_FOUND", message: "The conversation was not found." } });

    const unauthenticated = await fetch(baseUrl + "/api/v1/conversations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    assert.equal(unauthenticated.status, 401);

    const unsupported = await fetch(baseUrl + "/api/v1/conversations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", { method: "PUT", headers: { authorization } });
    assert.equal(unsupported.status, 405);
    assert.equal(unsupported.headers.get("allow"), "GET, DELETE");
  }, {
    env: authEnv,
    store: {
      async getConversation() { return null; },
    },
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
  }, {
    env: { ...authEnv, API_METRICS_ENABLED: "true" },
    store: { async isSessionRevoked() { return false; } },
  });
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


test("media upload route requires authentication and passes bounded binary data to the media service", async () => {
  const calls: Array<{ ownerId: string; contentType: string; bytes: Buffer }> = [];
  const assetId = "11111111-1111-4111-8111-111111111111";
  const mediaAssets = {
    async upload(input) {
      calls.push({ ownerId: input.ownerId, contentType: input.contentType, bytes: input.bytes });
      return { id: assetId, src: "/api/media/" + assetId, contentType: "image/webp", byteSize: 12, width: 10, height: 8 };
    },
    async getPublic() { throw new Error("unused"); },
  };
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  await withServer(async (baseUrl) => {
    const unauthenticated = await fetch(baseUrl + "/api/v1/me/media", {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: bytes,
    });
    assert.equal(unauthenticated.status, 401);

    const response = await fetch(baseUrl + "/api/v1/me/media", {
      method: "POST",
      headers: { authorization: "Bearer " + signedToken("media-writer"), "content-type": "image/png" },
      body: bytes,
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { data: { id: assetId, src: "/api/media/" + assetId, contentType: "image/webp", byteSize: 12, width: 10, height: 8 } });

    const unsupported = await fetch(baseUrl + "/api/v1/me/media", {
      method: "POST",
      headers: { authorization: "Bearer " + signedToken("media-writer"), "content-type": "image/svg+xml" },
      body: "<svg/>",
    });
    assert.equal(unsupported.status, 415);
  }, { env: authEnv, store: {}, mediaAssets });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].ownerId, "media-writer");
  assert.equal(calls[0].contentType, "image/png");
  assert.deepEqual(calls[0].bytes, bytes);
});

test("public media route emits an immutable WebP response and supports conditional requests", async () => {
  const assetId = "11111111-1111-4111-8111-111111111111";
  const bytes = Buffer.from("RIFF-test-webp");
  const sha256 = "a".repeat(64);
  let calls = 0;
  const mediaAssets = {
    async upload() { throw new Error("unused"); },
    async getPublic({ id }) {
      calls += 1;
      assert.equal(id, assetId);
      return { id, bytes, byteSize: bytes.byteLength, width: 10, height: 8, sha256, contentType: "image/webp" as const };
    },
  };
  await withServer(async (baseUrl) => {
    const url = baseUrl + "/api/v1/media/" + assetId;
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/webp");
    assert.match(response.headers.get("cache-control") ?? "", /immutable/);
    assert.equal(response.headers.get("etag"), '"' + sha256 + '"');
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);

    const cached = await fetch(url, { headers: { "if-none-match": '"' + sha256 + '"' } });
    assert.equal(cached.status, 304);
    assert.equal(cached.headers.get("etag"), '"' + sha256 + '"');
  }, { mediaAssets });
  assert.equal(calls, 2);
});

/**
 * The media library, at the transport boundary (ADR 0022).
 *
 * What a client can observe: the list is the author's own and paginated, an
 * asset still used by a work is refused with the works that use it, an id that
 * is not that author's is simply not found, and a deployment without object
 * storage says so instead of showing an empty library.
 */
test("the media library lists one author's uploads, newest first, and only theirs", async () => {
  const assetId = "11111111-1111-4111-8111-111111111111";
  const calls: Array<Record<string, unknown>> = [];
  const mediaAssets = {
    async upload() { throw new Error("unused"); },
    async getPublic() { throw new Error("unused"); },
    async listLibrary(input) {
      calls.push({ ...input });
      return {
        items: [{
          id: assetId, src: "/api/media/" + assetId, contentType: "image/webp", byteSize: 2048,
          width: 20, height: 10, createdAt: "2026-10-30T00:00:00.000Z", orphan: true, referencedBy: [],
        }],
        nextCursor: null,
      };
    },
    async deleteAsset() { throw new Error("unused"); },
  };
  await withServer(async (baseUrl) => {
    const unauthenticated = await fetch(baseUrl + "/api/v1/me/media");
    assert.equal(unauthenticated.status, 401);
    await unauthenticated.text();

    const response = await fetch(baseUrl + "/api/v1/me/media?limit=12", {
      headers: { authorization: "Bearer " + signedToken("media-writer") },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
    const body = await response.json();
    assert.equal(body.data.items.length, 1);
    assert.equal(body.data.items[0].orphan, true);
    assert.equal(body.data.nextCursor, null);

    // The owner is the token, never the query string.
    assert.deepEqual(calls, [{ ownerId: "media-writer", cursor: null, limit: 12 }]);

    const fractional = await fetch(baseUrl + "/api/v1/me/media?limit=2.5", {
      headers: { authorization: "Bearer " + signedToken("media-writer") },
    });
    assert.equal(fractional.status, 400);
    await fractional.text();

    const repeated = await fetch(baseUrl + "/api/v1/me/media?limit=12&limit=13", {
      headers: { authorization: "Bearer " + signedToken("media-writer") },
    });
    assert.equal(repeated.status, 400, "a repeated parameter is rejected, not silently read as the first");

    const wrongMethod = await fetch(baseUrl + "/api/v1/me/media", {
      method: "PUT",
      headers: { authorization: "Bearer " + signedToken("media-writer") },
    });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "GET, POST");
  }, { env: authEnv, store: {}, mediaAssets });
});

/**
 * The deployment switch (#156).
 *
 * Deleting an image is off unless an operator turns it on, because the reference
 * check and the delete are not serialised against a concurrent save on
 * PostgreSQL — a work saved in that window loses its images for good. Hiding the
 * button in the Web app does not help: a Flutter build, or curl, talks to the
 * same route.
 *
 * So the route itself has to refuse, and it has to refuse in the right order:
 * authentication first (an anonymous caller learns 401, not how the instance is
 * configured), then the switch, then — only if both pass — the expensive scan.
 */
test("media deletion is refused by default, before the reference scan runs", async () => {
  const assetId = "11111111-1111-4111-8111-111111111111";
  const calls: Array<Record<string, unknown>> = [];
  const mediaAssets = {
    async upload() { throw new Error("unused"); },
    async getPublic() { throw new Error("unused"); },
    async listLibrary() { return { items: [], nextCursor: null }; },
    async deleteAsset(input) { calls.push({ ...input }); return { id: input.id, objectDeleted: true }; },
  };
  // authEnv turns the switch on for the other tests; this one removes it, which
  // is exactly the configuration a stock deployment has.
  const { MEDIA_DELETE_ENABLED: _omitted, ...offByDefault } = authEnv;
  await withServer(async (baseUrl) => {
    // Anonymous first: the refusal must not describe the deployment to someone
    // who has not proved who they are.
    const anonymous = await fetch(baseUrl + "/api/v1/me/media/" + assetId, { method: "DELETE" });
    assert.equal(anonymous.status, 401);
    await anonymous.text();

    const response = await fetch(baseUrl + "/api/v1/me/media/" + assetId, {
      method: "DELETE",
      headers: { authorization: "Bearer " + signedToken("media-writer") },
    });
    assert.equal(response.status, 409, "a decision, not an outage: 409, never 503");
    assert.deepEqual(await response.json(), {
      error: { code: "MEDIA_DELETE_DISABLED", message: "Deleting images is not enabled on this instance." },
    });
    // Nothing was scanned and nothing was deleted. A refused request must also
    // be an unexpensive one: the scan reads every work's body.
    assert.deepEqual(calls, [], "the asset service must not be reached at all");

    // Reading the library and an individual asset stays available: the switch
    // governs deletion, not the whole media feature.
    const library = await fetch(baseUrl + "/api/v1/me/media", {
      headers: { authorization: "Bearer " + signedToken("media-writer") },
    });
    assert.equal(library.status, 200, "listing is unaffected");
  }, { env: offByDefault, store: {}, mediaAssets });
});

test("media deletion runs when the switch is on", async () => {
  const assetId = "11111111-1111-4111-8111-111111111111";
  const calls: Array<Record<string, unknown>> = [];
  const mediaAssets = {
    async upload() { throw new Error("unused"); },
    async getPublic() { throw new Error("unused"); },
    async listLibrary() { return { items: [], nextCursor: null }; },
    async deleteAsset(input) { calls.push({ ...input }); return { id: input.id, objectDeleted: true }; },
  };
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/v1/me/media/" + assetId, {
      method: "DELETE",
      headers: { authorization: "Bearer " + signedToken("media-writer") },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { id: assetId } });
    assert.deepEqual(calls, [{ ownerId: "media-writer", id: assetId }], "the owner is the authenticated caller, never a body field");
  }, { env: authEnv, store: {}, mediaAssets });
});

test("only an explicit word switches media deletion on", async () => {
  const assetId = "11111111-1111-4111-8111-111111111111";
  const makeMediaAssets = (onDelete) => ({
    async upload() { throw new Error("unused"); },
    async getPublic() { throw new Error("unused"); },
    async listLibrary() { return { items: [], nextCursor: null }; },
    async deleteAsset(input) { return { id: input.id, objectDeleted: true }; },
  });
  const statusFor = async (value) => {
    const { MEDIA_DELETE_ENABLED: _ignored, ...rest } = authEnv;
    const env = value === undefined ? rest : { ...rest, MEDIA_DELETE_ENABLED: value };
    let status;
    await withServer(async (baseUrl) => {
      const response = await fetch(baseUrl + "/api/v1/me/media/" + assetId, {
        method: "DELETE",
        headers: { authorization: "Bearer " + signedToken("media-writer") },
      });
      status = response.status;
      await response.text();
    }, { env, store: {}, mediaAssets: makeMediaAssets() });
    return status;
  };
  // Accepting the same affirmative spellings as MAIL_ENABLED keeps one
  // convention for deployment switches in this codebase.
  for (const on of ["true", "TRUE", "1", "yes", "on", "  true  "]) {
    assert.equal(await statusFor(on), 200, `"${on}" must switch deletion on`);
  }
  // Everything else is off. A typo must never be able to destroy data, so the
  // unrecognised case is not "probably fine" — it is refused.
  for (const off of ["false", "0", "no", "off", "", "   ", "ture", "trueee", "enabled"]) {
    assert.equal(await statusFor(off), 409, `"${off}" must leave deletion off`);
  }
  assert.equal(await statusFor(undefined), 409, "unset means off");
});

test("deleting an asset is refused while a work uses it, and answers 404 for anything else", async () => {
  const assetId = "11111111-1111-4111-8111-111111111111";
  const calls: Array<Record<string, unknown>> = [];
  const inUse = {
    async upload() { throw new Error("unused"); },
    async getPublic() { throw new Error("unused"); },
    async listLibrary() { return { items: [], nextCursor: null }; },
    async deleteAsset(input) {
      calls.push({ ...input });
      throw new MediaAssetInUseError([
        { kind: "work", articleId: "a1", slug: "uses-it", title: "用了它", locale: "zh-CN", state: "draft", redacted: false },
      ]);
    },
  };
  await withServer(async (baseUrl) => {
    const unauthenticated = await fetch(baseUrl + "/api/v1/me/media/" + assetId, { method: "DELETE" });
    assert.equal(unauthenticated.status, 401);
    await unauthenticated.text();

    const response = await fetch(baseUrl + "/api/v1/me/media/" + assetId, {
      method: "DELETE",
      headers: { authorization: "Bearer " + signedToken("media-writer") },
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error.code, "MEDIA_IN_USE");
    // The refusal carries the works, so the page can say why instead of just no.
    assert.deepEqual(body.error.details.referencedBy.map((entry) => entry.slug), ["uses-it"]);
    assert.equal(body.error.details.referencedBy[0].redacted, false, "this one the reader is allowed to see");
  }, { env: authEnv, store: {}, mediaAssets: inUse });

  const notFound = {
    async upload() { throw new Error("unused"); },
    async getPublic() { throw new Error("unused"); },
    async listLibrary() { return { items: [], nextCursor: null }; },
    async deleteAsset() { throw new MediaAssetNotFoundError(); },
  };
  await withServer(async (baseUrl) => {
    // "Not yours" and "not a media id at all" are the same answer, so the
    // endpoint cannot be used to find out which assets exist.
    const response = await fetch(baseUrl + "/api/v1/me/media/not-a-uuid", {
      method: "DELETE",
      headers: { authorization: "Bearer " + signedToken("media-writer") },
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: { code: "NOT_FOUND", message: "The requested media asset was not found." },
    });

    const wrongMethod = await fetch(baseUrl + "/api/v1/me/media/" + assetId, {
      headers: { authorization: "Bearer " + signedToken("media-writer") },
    });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "DELETE");
  }, { env: authEnv, store: {}, mediaAssets: notFound });
});

/**
 * The refusal has to stay a refusal when the use it names is not the reader's to
 * read.
 *
 * An image can sit in another author's unpublished draft. The delete is blocked —
 * that is the whole point — but the 409 body is built from the scan, and a body
 * that named the draft would publish its title to whoever owns the bytes. What
 * goes out instead is the count and the state: enough to explain the refusal,
 * nothing of the words.
 */
test("a delete refused by another author's draft says so without naming the draft", async () => {
  const assetId = "11111111-1111-4111-8111-111111111111";
  const mediaAssets = {
    async upload() { throw new Error("unused"); },
    async getPublic() { throw new Error("unused"); },
    async listLibrary() { return { items: [], nextCursor: null }; },
    async deleteAsset() {
      throw new MediaAssetInUseError([
        { kind: "work", articleId: "", slug: "", title: "", locale: "", state: "draft", redacted: true },
        { kind: "avatar" },
      ]);
    },
  };
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/v1/me/media/" + assetId, {
      method: "DELETE",
      headers: { authorization: "Bearer " + signedToken("media-writer") },
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error.code, "MEDIA_IN_USE");
    assert.equal(body.error.details.referencedBy.length, 2, "both uses still count");
    assert.equal(body.error.details.referencedBy[0].redacted, true);
    assert.equal(body.error.details.referencedBy[1].kind, "avatar");
  }, { env: authEnv, store: {}, mediaAssets });
});

/**
 * The delete that half-succeeded.
 *
 * Once the row is gone nothing can be referencing it, so a bucket that cannot be
 * reached leaves bytes with no name attached to them — a bill, not a broken work.
 * The reader asked for one deletion and got it; the leftover is for whoever runs
 * the bucket, which is what the log line is for.
 */
test("a delete whose object cannot be removed still answers 200, and says what is left behind", async () => {
  const assetId = "11111111-1111-4111-8111-111111111111";
  const storageKey = "assets/media-writer/left-behind.webp";
  const mediaAssets = {
    async upload() { throw new Error("unused"); },
    async getPublic() { throw new Error("unused"); },
    async listLibrary() { return { items: [], nextCursor: null }; },
    async deleteAsset() { return { id: assetId, objectDeleted: false, orphanedStorageKey: storageKey }; },
  };
  // The log is the only trace of the leftover, so it is part of the contract.
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  (process.stderr as { write: typeof process.stderr.write }).write = ((chunk: string | Uint8Array) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(baseUrl + "/api/v1/me/media/" + assetId, {
        method: "DELETE",
        headers: { authorization: "Bearer " + signedToken("media-writer") },
      });
      assert.equal(response.status, 200, "the row is gone: the deletion the reader asked for happened");
      assert.deepEqual(await response.json(), { data: { id: assetId } });
      const entry = captured.split("\n").filter(Boolean).map((line) => JSON.parse(line))
        .find((record) => record.event === "media.object_orphaned");
      assert.ok(entry, "the leftover is logged for whoever pays for the bucket");
      assert.equal(entry.level, "warn");
      assert.equal(entry.storageKey, storageKey);
      assert.equal(entry.mediaId, assetId);
    }, { env: authEnv, store: {}, mediaAssets });
  } finally {
    (process.stderr as { write: typeof process.stderr.write }).write = original;
  }
});

test("a deployment without object storage says so instead of showing an empty library", async () => {
  await withServer(async (baseUrl) => {
    const list = await fetch(baseUrl + "/api/v1/me/media", {
      headers: { authorization: "Bearer " + signedToken("media-writer") },
    });
    assert.equal(list.status, 503);
    assert.equal((await list.json()).error.code, "MEDIA_STORAGE_UNAVAILABLE");

    const remove = await fetch(baseUrl + "/api/v1/me/media/11111111-1111-4111-8111-111111111111", {
      method: "DELETE",
      headers: { authorization: "Bearer " + signedToken("media-writer") },
    });
    assert.equal(remove.status, 503);
    assert.equal((await remove.json()).error.code, "MEDIA_STORAGE_UNAVAILABLE");
  }, { env: authEnv, store: {} });
});

/**
 * Recovery and verification, at the transport boundary.
 *
 * The assertions that matter here are the ones a client can observe: a recovery
 * request is accepted with 202 whether or not the address exists, the token is
 * never accepted from the path, and an unauthenticated caller cannot make the API
 * send mail at all.
 */
function recoveryStore(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const store: Record<string, unknown> = {
    calls,
    async consumeRateLimit() { return { allowed: true, resetAt: new Date(Date.now() + 60_000).toISOString() }; },
    async pruneExpiredIdentityState() { return true; },
    async findIdentityAccount({ email }) {
      calls.push({ method: "findIdentityAccount", args: { email } });
      return email === "owner@example.test" ? { userId: "owner-user", passwordHash: "hash-before" } : null;
    },
    async issueIdentityToken(args) { calls.push({ method: "issueIdentityToken", args }); return true; },
    async consumeIdentityToken({ tokenHash, purpose }) {
      calls.push({ method: "consumeIdentityToken", args: { tokenHash, purpose } });
      return tokenHash === RESET_TOKEN_HASH ? { userId: "owner-user", email: "owner@example.test" } : null;
    },
    async replaceIdentityPassword(args) { calls.push({ method: "replaceIdentityPassword", args }); return { updated: true, revokedSessions: 2 }; },
    async markIdentityEmailVerified(args) { calls.push({ method: "markIdentityEmailVerified", args }); return true; },
    async findIdentityAccountByUserId({ userId }) {
      calls.push({ method: "findIdentityAccountByUserId", args: { userId } });
      return userId === "owner-user" ? { userId, email: "owner@example.test", emailVerifiedAt: null } : null;
    },
    ...overrides,
  };
  return store;
}

const RESET_TOKEN = "A".repeat(43);
/** The only digest the fake store recognises, so the test exercises the real hashing. */
const RESET_TOKEN_HASH = createHash("sha256").update(RESET_TOKEN, "utf8").digest("hex");

test("REST password recovery accepts every address identically and never takes the token from the path", async () => {
  const store = recoveryStore();
  await withServer(async (baseUrl) => {
    const post = (path: string, body: unknown) => fetch(baseUrl + path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });

    const known = await post("/api/v1/auth/forgot-password", { email: "owner@example.test" });
    assert.equal(known.status, 202, "an accepted recovery request is not confirmed, only acknowledged");
    assert.deepEqual(await known.json(), { data: { ok: true } });

    // The whole point: the same answer for an address with no account behind it.
    const unknown = await post("/api/v1/auth/forgot-password", { email: "nobody@example.test" });
    assert.equal(unknown.status, 202);
    assert.deepEqual(await unknown.json(), { data: { ok: true } });

    const malformed = await post("/api/v1/auth/forgot-password", { email: "not-an-address" });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, "BAD_USER_INPUT");

    // A token in the path would be logged by every proxy between here and the
    // reader, so no route reads one: the path is simply not a route, and nothing
    // is spent. (Unknown paths answer a write with 405/allow: GET, the same
    // contract every other unrouted write gets.)
    const inPath = await fetch(baseUrl + "/api/v1/auth/reset-password/" + RESET_TOKEN, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "a-brand-new-password" }),
    });
    assert.equal(inPath.status, 405);
    assert.equal(inPath.headers.get("allow"), "GET");
    assert.ok(!store.calls.some((call) => call.method === "consumeIdentityToken"), "a token carried in a path is never spent");

    const wrongMethod = await fetch(baseUrl + "/api/v1/auth/forgot-password");
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "POST");
  }, { env: authEnv, store });
});

test("REST password reset spends the token once, replaces the credential and ends the sessions", async () => {
  const store = recoveryStore();
  await withServer(async (baseUrl) => {
    const post = (body: unknown) => fetch(baseUrl + "/api/v1/auth/reset-password", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const accepted = await post({ token: RESET_TOKEN, password: "a-brand-new-password" });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { data: { ok: true } });

    // A reset spares nothing, and it does that in the same call that carries
    // the new credential: the one failure mode worth designing out is a new
    // password with the session that was stolen still signed in.
    const replacement = store.calls.find((call) => call.method === "replaceIdentityPassword");
    assert.equal(replacement?.method, "replaceIdentityPassword");
    assert.equal(replacement?.args.userId, "owner-user");
    assert.equal(replacement?.args.exceptSessionId, null, "a reset has no session that proved anything");
    assert.match(String(replacement?.args.passwordHash), /^scrypt\$/, "and the new credential rides in the same call");

    // Well-formed but never issued: 401, not 400 — the shape is fine, the
    // credential is not. (A malformed one is rejected as bad input instead.)
    const unknown = await post({ token: randomBytes(32).toString("base64url"), password: "a-brand-new-password" });
    assert.equal(unknown.status, 401, "a token that was never issued is not a reset");
    const malformed = await post({ token: "not-a-token", password: "a-brand-new-password" });
    assert.equal(malformed.status, 400);

    const short = await post({ token: RESET_TOKEN, password: "short" });
    assert.equal(short.status, 400, "a recovered account gets a registration-strength password");
  }, { env: authEnv, store });
});

test("REST email verification stamps the account and only the account holder may ask for the mail", async () => {
  const store = recoveryStore();
  await withServer(async (baseUrl) => {
    const authorization = "Bearer " + signedToken("owner-user");
    const verified = await fetch(baseUrl + "/api/v1/auth/verify-email", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: RESET_TOKEN }),
    });
    assert.equal(verified.status, 200);
    assert.ok(store.calls.some((call) => call.method === "markIdentityEmailVerified"));

    const requested = await fetch(baseUrl + "/api/v1/me/email-verification", { method: "POST", headers: { authorization } });
    assert.equal(requested.status, 202);
    assert.deepEqual(await requested.json(), { data: { ok: true, alreadyVerified: false } });
    assert.deepEqual(store.calls.find((call) => call.method === "issueIdentityToken").args.purpose, "email_verification");

    // Unauthenticated: no way to aim mail at an address.
    const anonymous = await fetch(baseUrl + "/api/v1/me/email-verification", { method: "POST" });
    assert.equal(anonymous.status, 401);
  }, { env: authEnv, store });
});

/**
 * The mail switch, over HTTP.
 *
 * Both endpoints that would put a link in somebody's inbox answer 409 with
 * `MAIL_DISABLED` while the switch is off — 409 rather than 503 because nothing
 * is temporarily unavailable; the site simply cannot mail anybody. What they
 * must **not** do is answer 202: a page that says "check your mail" when no mail
 * exists is worse than one that says the site cannot do this.
 */
test("recovery and verification answer 503 while mail is switched off", async () => {
  const store = recoveryStore();
  const disabled = { ...authEnv, MAIL_ENABLED: "false" };
  await withServer(async (baseUrl) => {
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(baseUrl + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

    const reset = await post("/api/v1/auth/forgot-password", { email: "owner@example.test" });
    assert.equal(reset.status, 409, "a recovery link that cannot be delivered is not an accepted request");
    assert.equal((await reset.json()).error.code, "MAIL_DISABLED");
    assert.ok(!store.calls.some((call) => call.method === "issueIdentityToken"), "no token is issued for a mail that cannot be sent");

    const authorization = "Bearer " + signedToken("owner-user");
    const verification = await post("/api/v1/me/email-verification", {}, { authorization });
    assert.equal(verification.status, 409);
    assert.equal((await verification.json()).error.code, "MAIL_DISABLED");
  }, { env: disabled, store });
});

test("the same endpoints work the moment the switch is on", async () => {
  const store = recoveryStore();
  await withServer(async (baseUrl) => {
    const reset = await fetch(baseUrl + "/api/v1/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@example.test" }),
    });
    assert.equal(reset.status, 202);
    assert.deepEqual(await reset.json(), { data: { ok: true } });
    assert.ok(store.calls.some((call) => call.method === "issueIdentityToken"));
  }, { env: authEnv, store });
});

/**
 * The address a stored asset carries.
 *
 * `POST /me/media` answers with `src: /api/media/<id>` — the *application*
 * path, not the versioned one — because that is the address a content body
 * keeps, and the Web app serves it from its own origin. The stored `src` is not
 * changed (it would break every body already saved, and the editor that only
 * accepts it), so the API answers that path too: one address, both
 * deployments, and a client that talks to the API directly no longer has to
 * rewrite the address it was just handed.
 */
test("the application-relative media address a stored asset carries is served by the API too", async () => {
  const assetId = "11111111-1111-4111-8111-111111111111";
  const bytes = Buffer.from("RIFF-alias-webp");
  const sha256 = "b".repeat(64);
  const requested: string[] = [];
  const mediaAssets = {
    async upload() { throw new Error("unused"); },
    async getPublic({ id }: { id: string }) {
      requested.push(id);
      if (id !== assetId) throw new MediaAssetNotFoundError();
      return { id, bytes, byteSize: bytes.byteLength, width: 10, height: 8, sha256, contentType: "image/webp" as const };
    },
  };
  await withServer(async (baseUrl) => {
    const alias = await fetch(baseUrl + "/api/media/" + assetId);
    assert.equal(alias.status, 200);
    assert.equal(alias.headers.get("content-type"), "image/webp");
    assert.match(alias.headers.get("cache-control") ?? "", /immutable/);
    assert.equal(alias.headers.get("etag"), '"' + sha256 + '"');
    assert.deepEqual(Buffer.from(await alias.arrayBuffer()), bytes);
    assert.deepEqual(requested, [assetId], "the alias resolves through the same handler, not a second one");

    // An unknown asset on the alias is still a 404, and the alias is not a way
    // in for a write: one path, and the same rules the versioned one has.
    const missing = await fetch(baseUrl + "/api/media/22222222-2222-4222-8222-222222222222");
    assert.equal(missing.status, 404);
    const write = await fetch(baseUrl + "/api/media/" + assetId, { method: "POST" });
    assert.equal(write.status, 405);
    assert.equal(write.headers.get("allow"), "GET");
    assert.equal(requested.length, 2, "the rejected write never reached the media service");
  }, { mediaAssets });
});

/**
 * `PUT /api/v1/me/email`.
 *
 * The address is where account recovery lands, so this is the one account
 * change that needs the current password even more sharply than changing the
 * password does. What it must *not* do is gate on verification or send a mail —
 * on an instance where mail is off, that would make the change impossible
 * rather than merely unverified.
 */
test("REST email change stores the new address, unproven, and signs nobody out", async () => {
  const seen: { email: Record<string, unknown> | null } = { email: null };
  const passwordHash = await hashPassword("the-current-password");
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/v1/me/email", {
      method: "PUT",
      headers: {
        authorization: "Bearer " + signedToken("email-user"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ password: "the-current-password", email: "New.Owner@Example.test" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      data: { ok: true, email: "new.owner@example.test", emailVerifiedAt: null },
    });
    // The address move carries the state the service verified: the address the
    // account had when the password was checked, and the credential it checked.
    assert.deepEqual(seen.email, {
      userId: "email-user", email: "new.owner@example.test",
      proof: { email: "owner@example.test", passwordHash },
    });
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async findIdentityCredentials({ userId }) { return { userId, passwordHash }; },
      async findIdentityAccountByUserId({ userId }) {
        return { userId, email: "owner@example.test", emailVerifiedAt: "2026-01-01T00:00:00.000Z" };
      },
      async setIdentityEmail(args) { seen.email = args; return true; },
      async replaceIdentityPassword() { throw new Error("must not be called"); },
    },
  });
});

test("REST email change refuses a wrong password, reports a taken address, and is authenticated", async () => {
  let stored = 0;
  // A stable hash, as a real store has: the retry-on-failure path compares the
  // credential it verified with the one still on file.
  const passwordHash = await hashPassword("the-current-password");
  await withServer(async (baseUrl) => {
    const session = { authorization: "Bearer " + signedToken("email-user"), "content-type": "application/json" };

    const wrongPassword = await fetch(baseUrl + "/api/v1/me/email", {
      method: "PUT",
      headers: session,
      body: JSON.stringify({ password: "not-the-password", email: "moved@example.test" }),
    });
    assert.equal(wrongPassword.status, 401);
    assert.equal((await wrongPassword.json()).error.code, "UNAUTHENTICATED");

    const taken = await fetch(baseUrl + "/api/v1/me/email", {
      method: "PUT",
      headers: session,
      body: JSON.stringify({ password: "the-current-password", email: "taken@example.test" }),
    });
    assert.equal(taken.status, 409);
    // Which conflict it is, not just that it is one: the account page says
    // "that address is taken" and the reader picks another.
    assert.equal((await taken.json()).error.code, "EMAIL_TAKEN");

    const anonymous = await fetch(baseUrl + "/api/v1/me/email", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "the-current-password", email: "moved@example.test" }),
    });
    assert.equal(anonymous.status, 401);

    const read = await fetch(baseUrl + "/api/v1/me/email", { headers: { authorization: "Bearer " + signedToken("email-user") } });
    assert.equal(read.status, 405);
    assert.equal(read.headers.get("allow"), "PUT");
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async findIdentityCredentials({ userId }) { return { userId, passwordHash }; },
      async findIdentityAccountByUserId({ userId }) {
        return { userId, email: "owner@example.test", emailVerifiedAt: null };
      },
      async setIdentityEmail({ email }) { stored += 1; return email !== "taken@example.test"; },
    },
  });
  assert.equal(stored, 1, "only the accepted-password attempt reaches the store");
});

/**
 * A cursor and an offset are two different answers to "where does this page
 * start", so the transport refuses to be asked both at once. What the cursor
 * *means* is the store's business: this layer passes it through bounded and
 * untrimmed, and the store decides whether it names a place.
 */
test("REST article discovery takes a cursor instead of an offset, never both", async () => {
  const calls = [];
  await withServer(async (baseUrl) => {
    const cursor = Buffer.from("2026-10-01T09:00:00.000Z|3f7c1d90-8a2b-4c1e-9f3a-6c5b2e8d1a44", "utf8").toString("base64url");
    const paged = await fetch(baseUrl + `/api/v1/articles?cursor=${cursor}&limit=5`);
    assert.equal(paged.status, 200);
    assert.deepEqual(await paged.json(), { data: [] });
    assert.deepEqual(calls[0], { locale: "zh-CN", query: "", sort: "latest", limit: 5, cursor });

    // Two answers to one question.
    const both = await fetch(baseUrl + `/api/v1/articles?cursor=${cursor}&offset=2`);
    assert.equal(both.status, 400);

    for (const bad of ["", "%20%20", "x".repeat(513)]) {
      const rejected = await fetch(baseUrl + `/api/v1/articles?cursor=${bad}`);
      assert.equal(rejected.status, 400, `cursor=${bad.slice(0, 12)} must be refused`);
    }
    assert.equal(calls.length, 1);
  }, {
    env: authEnv,
    store: {
      async listPublishedArticles(args) { calls.push(args); return []; },
    },
  });
});

test("all-locale authoring reads fail as a whole if one edition cannot be read", async () => {
  const calls = [];
  await withServer(async (baseUrl) => {
    for (const path of ["/api/v1/me/articles?allLocales=true", "/api/v1/me/articles/deleted?allLocales=true"]) {
      const response = await fetch(baseUrl + path, { headers: { authorization: `Bearer ${signedToken("writer")}` } });
      assert.equal(response.status, 500, path);
      const body = await response.json();
      assert.equal(body.error.code, "INTERNAL_SERVER_ERROR");
      assert.equal(Object.hasOwn(body, "data"), false, "a partial list cannot be mistaken for a complete list");
      assert.equal(Object.hasOwn(body, "meta"), false);
    }
    assert.equal(calls.length, 6);
    assert.ok(calls.every((call) => call.actorId === "writer"), "all editions use the verified actor");
  }, {
    env: authEnv,
    store: {
      async isSessionRevoked() { return false; },
      async listMyArticles(args) { calls.push(args); if (args.locale === "en") throw new Error("synthetic locale read failure"); return []; },
      async listMyDeletedArticles(args) { calls.push(args); if (args.locale === "en") throw new Error("synthetic locale read failure"); return []; },
    },
  });
});
