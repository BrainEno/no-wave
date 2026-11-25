/** REST article reads and writes, author profiles, taxonomy listings and discovery cursors. Split from server.test.ts (#357). */
import assert from "node:assert/strict";
import test from "node:test";
import { createSqliteClient, runSqliteMigrations } from "./persistence/sqlite.ts";
import { createSqliteStore } from "./persistence/sqlite-store.ts";
import { authEnv, signedToken, withServer } from "./test-support/rest-server-harness.ts";


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
