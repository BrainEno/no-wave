/** Comments, views, likes, JSON body limits and taxonomy mutations. Split from server.test.ts (#357). */
import assert from "node:assert/strict";
import test from "node:test";
import { request as httpRequest } from "node:http";
import { encodeCursor } from "./domain/cursor.ts";
import { authEnv, signedToken, withServer } from "./test-support/rest-server-harness.ts";


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
      // The comment tree is projected the way an article page is (#246): one
      // batch for the distinct authors rather than one read per node.
      async getAuthorProfilesByIds({ userIds }) {
        return Object.fromEntries(userIds
          .filter((userId) => userId === "commenter-user")
          .map((userId) => [userId, commenterProfile]));
      },
      async createArticleComment(args) {
        calls.push({ kind: "create", args });
        return comment;
      },
    },
  });
});

test("REST article views count one reader once a day, refuse the author, and 404 an unpublished slug", async () => {
  const article = {
    id: "9f0e3d2a-0000-4000-8000-000000000001",
    authorId: "author-user",
    slug: "counted-work",
    workType: "other",
    status: "published",
    locale: "zh-CN",
    title: "被阅读的作品",
    summary: "",
    contentBlocks: [],
    contentBlocksVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    publishedAt: "2026-01-01T00:00:00.000Z",
    viewCount: 4,
  };
  const charges = [];
  const increments = [];
  let allow = true;
  await withServer(async (baseUrl) => {
    // The route is throttled before it counts, so the view bucket is the one
    // charged with a limit of one — the policy buckets beside it are the ordinary
    // write limits, and they must not be confused for the dedupe.
    const viewCharges = () => charges.filter((bucket) => bucket.limit === 1);

    // An anonymous reader: no session, keyed by address.
    const first = await fetch(baseUrl + "/api/v1/articles/counted-work/views", { method: "POST" });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { data: { counted: true, viewCount: 5 } });
    assert.equal(viewCharges().length, 1);
    assert.equal(viewCharges()[0].windowSeconds, 86_400);
    assert.match(viewCharges()[0].key, /^[0-9a-f]{64}$/);
    assert.deepEqual(increments, [article.id]);

    // The same reader again, the same day: an ordinary "not counted".
    allow = false;
    const second = await fetch(baseUrl + "/api/v1/articles/counted-work/views", { method: "POST" });
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), { data: { counted: false, viewCount: 4 } });
    assert.deepEqual(increments, [article.id], "a deduplicated read writes nothing");

    // The author's own visit never reaches the per-reader bucket at all.
    charges.length = 0;
    const authorRead = await fetch(baseUrl + "/api/v1/articles/counted-work/views", {
      method: "POST",
      headers: { authorization: "Bearer " + signedToken("author-user") },
    });
    assert.equal(authorRead.status, 200);
    assert.deepEqual(await authorRead.json(), { data: { counted: false, viewCount: 4 } });
    assert.deepEqual(viewCharges(), []);
    assert.deepEqual(increments, [article.id], "the author's own read moved nothing");

    // Reading a work is not a `GET`: a cached fetch must not move a counter.
    const get = await fetch(baseUrl + "/api/v1/articles/counted-work/views");
    assert.equal(get.status, 405);
    assert.equal(get.headers.get("allow"), "POST");

    // A slug that is not a published work is a 404, not a view that vanished.
    const missing = await fetch(baseUrl + "/api/v1/articles/no-such-work/views", { method: "POST" });
    assert.equal(missing.status, 404);
    // The message is the transport's generic not-found, so an unpublished slug and
    // a mistyped one are indistinguishable from outside.
    assert.deepEqual(await missing.json(), {
      error: { code: "NOT_FOUND", message: "The requested resource was not found." },
    });
  }, {
    env: authEnv,
    store: {
      async getPublishedArticle({ slug }) { return slug === "counted-work" ? article : null; },
      async consumeRateLimit(bucket) {
        charges.push(bucket);
        // The view budget is the one that can be spent; the write limits beside it
        // stay open so the test is about the counter, not about throttling.
        if (bucket.limit === 1) return { allowed: allow, resetAt: "2026-03-02T00:00:00.000Z" };
        return { allowed: true, resetAt: "2026-03-01T00:01:00.000Z" };
      },
      async incrementArticleViewCount({ articleId }) {
        increments.push(articleId);
        return article.viewCount + 1;
      },
    },
  });
});

test("REST article comments continue a thread from a cursor and refuse a malformed one", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const at = "2026-06-01T00:00:00.123Z";
  const id = "11111111-1111-4111-8111-111111111111";
  await withServer(async (baseUrl) => {
    const paged = await fetch(
      `${baseUrl}/api/v1/articles/poetry-work/comments?limit=5&cursor=${encodeURIComponent(encodeCursor(at, id))}`,
    );
    assert.equal(paged.status, 200);
    assert.deepEqual(await paged.json(), { data: [] });
    // The store sees the two halves of the sort key, not the client's base64.
    assert.deepEqual(calls.at(-1), { slug: "poetry-work", locale: "zh-CN", limit: 5, cursor: { at, id } });

    // Without a cursor the request is the first page, exactly as before: no
    // cursor key at all, so nothing downstream has to treat null and absent
    // differently.
    const first = await fetch(`${baseUrl}/api/v1/articles/poetry-work/comments?limit=5`);
    assert.equal(first.status, 200);
    assert.deepEqual(calls.at(-1), { slug: "poetry-work", locale: "zh-CN", limit: 5 });

    // A cursor half the API cannot compare is the client's mistake: 400, never a
    // database error surfacing as 500, and never a store call.
    for (const bad of [
      "not-a-cursor",
      encodeCursor("2026-06-01T00:00:00.123Z", "not-a-uuid"),
      encodeCursor("2026-06-01T00:00:00Z", id),
      Buffer.from("", "utf8").toString("base64url"),
    ]) {
      const response = await fetch(
        `${baseUrl}/api/v1/articles/poetry-work/comments?cursor=${encodeURIComponent(bad)}`,
      );
      assert.equal(response.status, 400, `cursor ${JSON.stringify(bad)} is rejected`);
      assert.deepEqual(await response.json(), {
        error: { code: "BAD_USER_INPUT", message: "Invalid comment cursor." },
      });
    }
    assert.equal(calls.length, 2, "a malformed cursor never reaches the store");
  }, {
    env: authEnv,
    store: {
      async listArticleComments(args) { calls.push(args); return []; },
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
