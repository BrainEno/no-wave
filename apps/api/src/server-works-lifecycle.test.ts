/** Deleting, restoring and listing deleted works; pagination rejection; domain error mapping. Split from server.test.ts (#357). */
import assert from "node:assert/strict";
import test from "node:test";
import { ArticleAuthorizationError, ArticleInputError, ArticleNotFoundError, ArticleSlugConflictError, DomainError, IdempotencyConflictError, IdentityConflictError } from "./domain/errors.ts";
import { isUuid } from "./domain/validation.ts";
import { authEnv, signedToken, withServer } from "./test-support/rest-server-harness.ts";


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
      // Audit F-23: the notices go out as one batched transaction, not one
      // statement per commenter.
      async createNotifications(inputs) {
        notified.push(...inputs);
        return inputs.map((input) => ({ id: `notification-${input.userId}`, duplicate: false }));
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
